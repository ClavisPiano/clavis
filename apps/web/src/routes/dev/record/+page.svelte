<script lang="ts">
  import { onDestroy } from "svelte";
  import { asset } from "$app/paths";
  import {
    COUNT_IN_BEATS,
    midiToHz,
    pipelineOptionsFor,
    runWavBytes,
    takeToEntry,
    takeTruth,
    takesFor,
    writeWav,
    type Take,
  } from "@clavis/audio";
  import type { FixtureInstrument } from "@clavis/audio";
  import { cueAt, scoreTake, type Cue, type TakeScore } from "../../../lib/record-take";

  // Records a fixture take to 22.05 kHz mono WAV with a click track and an on-screen cue for every
  // note, scores it on the device, and builds the matching manifest entry. See
  // docs/fixtures-recording.md.
  const OUT_RATE = 22050;

  let instrument = $state<FixtureInstrument>("acoustic-piano");
  let device = $state("iPhone built-in mic");
  let variant = $state("");
  let slug = $state(takesFor("acoustic-piano")[0]?.slug ?? "");
  let clickThrough = $state(true);
  let status = $state<"idle" | "recording" | "analysing" | "done">("idle");
  let message = $state("");
  let cue = $state<Cue | undefined>();
  let remainingSec = $state(0);
  let result = $state<
    { wav: Uint8Array; snippet: string; name: string; score: TakeScore } | undefined
  >();
  // An object, so a Stop during the awaited recording is visible after it.
  const stop$ = { requested: false };
  const wasStopped = (): boolean => stop$.requested;
  let stopNow: (() => void) | undefined;
  let frame = 0;

  const takes = $derived(takesFor(instrument));
  const take = $derived<Take | undefined>(takes.find((t) => t.slug === slug) ?? takes[0]);
  const durationSec = $derived(take === undefined ? 0 : takeLengthSec(take));

  $effect(() => {
    if (take !== undefined && take.slug !== slug) slug = take.slug;
  });

  onDestroy(() => {
    cancelAnimationFrame(frame);
    stopNow?.();
  });

  function takeLengthSec(t: Take): number {
    const lastEnd = Math.max(...takeTruth(t).map((n) => n.offsetMs ?? n.onsetMs)) / 1000;
    return lastEnd + 1.5;
  }

  const beep = (ctx: AudioContext, at: number, hz: number, dur: number, gain: number): void => {
    const osc = ctx.createOscillator();
    const amp = ctx.createGain();
    osc.frequency.value = hz;
    amp.gain.setValueAtTime(gain, at);
    amp.gain.exponentialRampToValueAtTime(0.0001, at + dur);
    osc.connect(amp).connect(ctx.destination);
    osc.start(at);
    osc.stop(at + dur);
  };

  /** I IV V I triads from the tonic. Use headphones, or play it before pressing Record. */
  async function cadence(): Promise<void> {
    if (take?.cadenceTonic === undefined) return;
    const ctx = new AudioContext();
    const t = take.cadenceTonic;
    [0, 5, 7, 0].forEach((root, i) => {
      for (const iv of [0, 4, 7])
        beep(ctx, ctx.currentTime + 0.05 + i * 0.9, midiToHz(t + root + iv), 0.8, 0.15);
    });
    await new Promise((r) => setTimeout(r, 4000));
    await ctx.close();
  }

  async function resample(pcm: Float32Array, rate: number): Promise<Float32Array> {
    const offline = new OfflineAudioContext(1, Math.ceil((pcm.length * OUT_RATE) / rate), OUT_RATE);
    const buf = offline.createBuffer(1, pcm.length, rate);
    buf.copyToChannel(pcm as Float32Array<ArrayBuffer>, 0);
    const src = offline.createBufferSource();
    src.buffer = buf;
    src.connect(offline.destination);
    src.start();
    return (await offline.startRendering()).getChannelData(0);
  }

  function stop(): void {
    stop$.requested = true;
    stopNow?.();
  }

  async function record(): Promise<void> {
    if (take === undefined) return;
    const current = take;
    result = undefined;
    message = "";
    stop$.requested = false;
    // Everything below starts inside the tap, so iOS allows the context and the mic prompt.
    // iOS refuses capture under the "playback" session another page may have set.
    const session = (navigator as Navigator & { audioSession?: { type: string } }).audioSession;
    if (session?.type === "playback") session.type = "play-and-record";
    const ctx = new AudioContext();
    await ctx.resume();
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      });
      await ctx.audioWorklet.addModule(asset("dev/record-processor.js"));
      const chunks: { frame: number; samples: Float32Array }[] = [];
      const node = new AudioWorkletNode(ctx, "rec");
      node.port.onmessage = (e: MessageEvent<{ frame: number; samples: Float32Array }>) => {
        chunks.push(e.data);
      };
      const mute = ctx.createGain();
      mute.gain.value = 0;
      ctx.createMediaStreamSource(stream).connect(node);
      node.connect(mute).connect(ctx.destination);

      // File time 0 is the first click: samples before it are dropped by frame number.
      const t0 = ctx.currentTime + 0.5;
      const beatSec = 60 / current.bpm;
      const totalSec = takeLengthSec(current);
      const clicks = clickThrough ? Math.floor(totalSec / beatSec) : COUNT_IN_BEATS;
      for (let b = 0; b < clicks; b++) {
        const countIn = b < COUNT_IN_BEATS;
        // Count-in clicks are louder; the clicks under the take are quiet so they bleed less.
        beep(ctx, t0 + b * beatSec, b % 4 === 0 ? 1600 : 1000, 0.04, countIn ? 0.4 : 0.12);
      }
      status = "recording";
      const tick = (): void => {
        const elapsed = ctx.currentTime - t0;
        cue =
          elapsed < 0
            ? { phase: "count-in", beatsLeft: COUNT_IN_BEATS }
            : cueAt(current, elapsed * 1000);
        remainingSec = Math.max(0, Math.ceil(totalSec - Math.max(0, elapsed)));
        frame = requestAnimationFrame(tick);
      };
      frame = requestAnimationFrame(tick);
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, (0.5 + totalSec) * 1000);
        stopNow = () => {
          clearTimeout(timer);
          resolve();
        };
      });
      stopNow = undefined;
      cancelAnimationFrame(frame);
      cue = undefined;
      node.disconnect();
      for (const tr of stream.getTracks()) tr.stop();
      if (wasStopped()) {
        status = "idle";
        message = "Stopped. Nothing was saved.";
        return;
      }

      status = "analysing";
      const first = Math.round(t0 * ctx.sampleRate);
      const length = Math.round(totalSec * ctx.sampleRate);
      const pcm = new Float32Array(length);
      for (const c of chunks) {
        const at = c.frame - first;
        for (let i = 0; i < c.samples.length; i++) {
          if (at + i >= 0 && at + i < length) pcm[at + i] = c.samples[i] ?? 0;
        }
      }
      const out = await resample(pcm, ctx.sampleRate);
      const entry = takeToEntry(current, { instrument, device, sampleRate: OUT_RATE, variant });
      const wav = writeWav(out, OUT_RATE);
      // Same pitch pipeline as the app, on the file just recorded.
      const detected = runWavBytes(wav, pipelineOptionsFor(entry)).notes;
      result = {
        wav,
        snippet: JSON.stringify(entry, null, 2),
        name: entry.id,
        score: scoreTake(current, detected),
      };
      status = "done";
      message = "";
    } catch (e) {
      status = "idle";
      cue = undefined;
      cancelAnimationFrame(frame);
      message = `Could not record: ${e instanceof Error ? e.message : String(e)}`;
    } finally {
      await ctx.close();
    }
  }

  function files(): File[] {
    if (result === undefined) return [];
    return [
      new File([result.wav as BlobPart], `${result.name}.wav`, { type: "audio/wav" }),
      new File([result.snippet], `${result.name}.json`, { type: "application/json" }),
    ];
  }

  const canShare = $derived(
    typeof navigator !== "undefined" &&
      typeof navigator.canShare === "function" &&
      navigator.canShare({ files: [new File([""], "probe.wav", { type: "audio/wav" })] }),
  );

  async function share(): Promise<void> {
    try {
      await navigator.share({ files: files(), title: result?.name ?? "recording" });
    } catch (e) {
      if (!(e instanceof DOMException && e.name === "AbortError")) {
        message = `Share failed: ${e instanceof Error ? e.message : String(e)}`;
      }
    }
  }

  function download(): void {
    for (const f of files()) {
      const a = document.createElement("a");
      a.href = URL.createObjectURL(f);
      a.download = f.name;
      a.click();
      setTimeout(() => {
        URL.revokeObjectURL(a.href);
      }, 10000);
    }
  }

  const wavUrl = $derived(
    result === undefined
      ? undefined
      : URL.createObjectURL(new Blob([result.wav as BlobPart], { type: "audio/wav" })),
  );
  const pct = (x: number | null): string => (x === null ? "-" : `${String(Math.round(x * 100))}%`);
</script>

<h1>Record fixture</h1>

<ol class="steps">
  <li>
    Pick the instrument and the take. For bass reading, choose your piano and "Bass notes C2 to E4".
  </li>
  <li>
    Put the phone on the music stand or about 50 cm from the piano, mic towards the strings or
    speaker. Turn the phone volume up so you can hear the clicks.
  </li>
  <li>
    Press <strong>Record</strong> and allow the microphone. You hear 4 count-in clicks while the screen
    counts down.
  </li>
  <li>
    Then the screen shows the note to play. Play it on the click and let it ring until the next note
    appears. Keep going until it says Done. <strong>Stop</strong> cancels.
  </li>
  <li>
    Check the result below, listen back, then <strong>Share</strong> (or Download) the WAV and JSON and
    send both to me.
  </li>
</ol>

<fieldset disabled={status === "recording" || status === "analysing"}>
  <label
    >Instrument
    <select bind:value={instrument} data-testid="rec-instrument">
      <option value="acoustic-piano">Acoustic piano</option>
      <option value="digital-piano">Digital piano</option>
      <option value="voice">Voice</option>
    </select>
  </label>
  <label
    >Take
    <select bind:value={slug} data-testid="rec-take">
      {#each takes as t (t.slug)}
        <option value={t.slug}>{t.label}</option>
      {/each}
    </select>
  </label>
  <label>Device <input bind:value={device} /></label>
  <label>Id suffix (optional, e.g. laptop) <input bind:value={variant} /></label>
  <label class="inline">
    <input type="checkbox" bind:checked={clickThrough} /> Click on every beat (not just the count-in)
  </label>
</fieldset>

{#if take}
  <p>{take.prompt}</p>
  <p class="muted">
    {String(take.bpm)} bpm, {String(take.notes.length)} notes, about {String(
      Math.round(durationSec),
    )} s.
  </p>
  <p>
    {#if take.cadenceTonic !== undefined}
      <button type="button" onclick={cadence} disabled={status !== "idle" && status !== "done"}
        >Play cadence</button
      >
    {/if}
    {#if status === "recording"}
      <button type="button" class="button" onclick={stop} data-testid="rec-stop">Stop</button>
    {:else}
      <button
        type="button"
        class="button primary"
        onclick={record}
        disabled={status === "analysing"}
        data-testid="rec-start">Record</button
      >
    {/if}
  </p>
{/if}

{#if status === "recording" && cue}
  <div class="cue" aria-live="polite" data-testid="rec-cue">
    {#if cue.phase === "count-in"}
      <p class="label">Get ready</p>
      <p class="big">{cue.beatsLeft}</p>
    {:else if cue.phase === "play"}
      {#if cue.index < 0}
        <p class="label">First note</p>
        <p class="big">{cue.next}</p>
      {:else}
        <p class="label">Play now ({cue.index + 1} of {cue.total})</p>
        <p class="big">{cue.now}</p>
        <p class="next">{cue.next === undefined ? "Last note" : `Next: ${cue.next}`}</p>
      {/if}
    {:else}
      <p class="big">Done</p>
    {/if}
    <p class="muted">{remainingSec} s left</p>
  </div>
{/if}
{#if status === "analysing"}
  <p aria-live="polite">Analysing the recording...</p>
{/if}

<p aria-live="polite" data-testid="rec-message">{message}</p>

{#if result && wavUrl}
  <section class="result" data-testid="rec-result">
    <h2>Result</h2>
    <p>
      Heard <strong>{result.score.heard}</strong> of {result.score.total} notes. Exact pitch on
      <strong>{pct(result.score.exactRate)}</strong> of the notes heard ({result.score.exact} exact, {result
        .score.octaveErrors} right note in the wrong octave, {result.score.wrong} wrong note).
    </p>
    {#if take?.tags?.includes("bass")}
      <p>
        Bass reading needs 95% exact. {result.score.exactRate !== null &&
        result.score.exactRate >= 0.95
          ? "This take meets it."
          : "This take is below it."} Send the files either way: CI keeps the baseline.
      </p>
    {/if}
    <audio controls src={wavUrl}></audio>
    <p>
      {#if canShare}
        <button type="button" class="button primary" onclick={share}>Share WAV + JSON</button>
      {/if}
      <button type="button" class="button" onclick={download}>Download WAV + JSON</button>
    </p>
    <details>
      <summary>Note by note</summary>
      <table>
        <thead><tr><th>Played</th><th>Heard</th><th></th></tr></thead>
        <tbody>
          {#each result.score.notes as n, i (i)}
            <tr class={n.verdict}>
              <td>{n.expected}</td>
              <td>{n.heard ?? "-"}</td>
              <td
                >{n.verdict === "exact"
                  ? "ok"
                  : n.verdict === "octave"
                    ? "octave"
                    : n.verdict === "wrong"
                      ? "wrong"
                      : "missed"}</td
              >
            </tr>
          {/each}
        </tbody>
      </table>
    </details>
    <details>
      <summary>Manifest entry</summary>
      <pre>{result.snippet}</pre>
    </details>
  </section>
{/if}

<style>
  .steps {
    padding-left: var(--space-5);
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }

  fieldset {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    border: 0;
    padding: 0;
    margin: 0 0 var(--space-3);
  }

  .inline {
    display: flex;
    gap: var(--space-2);
    align-items: center;
  }

  .muted {
    opacity: 0.75;
  }

  .cue {
    text-align: center;
    padding: var(--space-4);
    border: 2px solid var(--color-accent);
    border-radius: var(--radius-md);
    margin: var(--space-3) 0;
  }

  .cue p {
    margin: var(--space-1) 0;
  }

  .big {
    font-size: 3.5rem;
    font-weight: 700;
    line-height: 1.1;
  }

  .label,
  .next {
    font-size: 1.1rem;
  }

  .result table {
    border-collapse: collapse;
  }

  .result td,
  .result th {
    padding: 2px var(--space-3) 2px 0;
    text-align: left;
  }

  .result tr.octave,
  .result tr.wrong,
  .result tr.missed {
    font-weight: 700;
  }
</style>
