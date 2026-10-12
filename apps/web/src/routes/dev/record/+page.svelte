<script lang="ts">
  import { onDestroy } from "svelte";
  import { asset } from "$app/paths";
  import {
    COUNT_IN_BEATS,
    KEYBOARD_RANGES,
    midiToHz,
    noteName,
    pipelineOptionsFor,
    runWavBytes,
    selfPacedTruth,
    takeInRange,
    takeToEntry,
    takeTruth,
    takesFor,
    writeWav,
    type Take,
  } from "@clavis/audio";
  import type { FixtureInstrument } from "@clavis/audio";
  import {
    OnsetDetector,
    cueAt,
    noteBeats,
    scoreNotes,
    type Cue,
    type TakeScore,
  } from "../../../lib/record-take";

  // Records a fixture take to 22.05 kHz mono WAV, scores it on the device, and builds the matching
  // manifest entry. Single-note takes are self-paced: one note on screen at a time, and the page
  // moves on when it hears the note. Timed takes (melodies, two hands) click once per note after a
  // count-in. See docs/fixtures-recording.md.
  const OUT_RATE = 22050;
  /** Self-paced: how long a note rings after its attack before the next one is shown. */
  const RING_MS = 2000;
  /** Self-paced: recording stops on its own after this long, whatever happens. */
  const MAX_SELF_PACED_SEC = 600;

  interface SelfCue {
    index: number;
    total: number;
    note: string;
    next: string | undefined;
    heard: boolean;
    level: number;
  }

  let instrument = $state<FixtureInstrument>("acoustic-piano");
  let device = $state("iPhone built-in mic");
  let variant = $state("");
  let slug = $state(takesFor("acoustic-piano")[0]?.slug ?? "");
  let status = $state<"idle" | "recording" | "analysing" | "done">("idle");
  let message = $state("");
  let cue = $state<Cue | undefined>();
  let selfCue = $state<SelfCue | undefined>();
  let remainingSec = $state(0);
  let result = $state<
    { wav: Uint8Array; snippet: string; name: string; score: TakeScore } | undefined
  >();
  // An object, so a Stop during the awaited recording is visible after it.
  const stop$ = { requested: false };
  const wasStopped = (): boolean => stop$.requested;
  let stopNow: (() => void) | undefined;
  let skipNote = $state<(() => void) | undefined>();
  let frame = 0;

  // The keys this piano has, remembered on the device. Takes leave out notes outside it.
  const RANGE_STORAGE_KEY = "clavisRecordRange";
  interface Range {
    low: number;
    high: number;
  }
  const DEFAULT_RANGE: Range = KEYBOARD_RANGES["88 keys (A0 to C8)"];
  function loadRange(): Range {
    try {
      const raw = localStorage.getItem(RANGE_STORAGE_KEY);
      const r = raw === null ? undefined : (JSON.parse(raw) as Partial<Range>);
      if (
        r !== undefined &&
        typeof r.low === "number" &&
        typeof r.high === "number" &&
        r.low >= 21 &&
        r.high <= 108 &&
        r.low < r.high
      ) {
        return { low: r.low, high: r.high };
      }
    } catch {
      // Storage blocked or bad value: use the full piano.
    }
    return DEFAULT_RANGE;
  }
  let range = $state<Range>(loadRange());
  function setRange(r: Range): void {
    range = r;
    try {
      localStorage.setItem(RANGE_STORAGE_KEY, JSON.stringify(r));
    } catch {
      // Not remembered; still applies to this visit.
    }
  }
  const presetName = $derived(
    Object.entries(KEYBOARD_RANGES).find(
      ([, r]) => r.low === range.low && r.high === range.high,
    )?.[0] ?? "custom",
  );
  const KEY_CHOICES = Array.from({ length: 88 }, (_, i) => 21 + i);

  const takes = $derived(takesFor(instrument));
  const baseTake = $derived<Take | undefined>(takes.find((t) => t.slug === slug) ?? takes[0]);
  const take = $derived<Take | undefined>(
    baseTake === undefined || instrument === "voice"
      ? baseTake
      : takeInRange(baseTake, range.low, range.high),
  );
  const durationSec = $derived(take === undefined ? 0 : takeLengthSec(take));

  $effect(() => {
    if (baseTake !== undefined && baseTake.slug !== slug) slug = baseTake.slug;
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

  /** Timed takes: louder count-in, then one click on every note (never between notes). */
  function scheduleClicks(ctx: AudioContext, current: Take, t0: number): void {
    const beatSec = 60 / current.bpm;
    for (let b = 0; b < COUNT_IN_BEATS; b++) {
      beep(ctx, t0 + b * beatSec, b === 0 ? 1600 : 1000, 0.05, 0.4);
    }
    for (const beat of noteBeats(current)) {
      beep(ctx, t0 + (COUNT_IN_BEATS + beat) * beatSec, 1600, 0.05, 0.35);
    }
  }

  async function record(): Promise<void> {
    if (take === undefined) return;
    const current = take;
    const selfPaced = current.selfPaced === true;
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
      const rate = ctx.sampleRate;
      // File time 0: samples before it are dropped by frame number.
      const t0 = ctx.currentTime + (selfPaced ? 0.3 : 0.5);
      const first = Math.round(t0 * rate);
      const chunks: { frame: number; samples: Float32Array }[] = [];

      // Self-paced state: which note is shown, and the attack heard for each note.
      const detector = new OnsetDetector(rate);
      const onsets: (number | undefined)[] = [];
      let index = 0;
      let ringUntil: number | undefined;
      const advance = (): void => {
        index++;
        ringUntil = undefined;
        if (index >= current.notes.length) stopNow?.();
      };
      skipNote = selfPaced
        ? () => {
            onsets[index] = undefined;
            advance();
          }
        : undefined;

      const node = new AudioWorkletNode(ctx, "rec");
      node.port.onmessage = (e: MessageEvent<{ frame: number; samples: Float32Array }>) => {
        chunks.push(e.data);
        if (!selfPaced) return;
        for (const at of detector.push(e.data.samples, e.data.frame)) {
          if (at < first || ringUntil !== undefined || index >= current.notes.length) continue;
          onsets[index] = ((at - first) / rate) * 1000;
          ringUntil = at + Math.round((RING_MS / 1000) * rate);
        }
      };
      const mute = ctx.createGain();
      mute.gain.value = 0;
      ctx.createMediaStreamSource(stream).connect(node);
      node.connect(mute).connect(ctx.destination);

      const totalSec = selfPaced ? MAX_SELF_PACED_SEC : takeLengthSec(current);
      if (!selfPaced) scheduleClicks(ctx, current, t0);
      status = "recording";
      const tick = (): void => {
        const elapsed = ctx.currentTime - t0;
        if (selfPaced) {
          const now = Math.round(ctx.currentTime * rate);
          if (ringUntil !== undefined && now >= ringUntil) advance();
          const n = current.notes[index];
          const nx = current.notes[index + 1];
          selfCue =
            n === undefined
              ? undefined
              : {
                  index,
                  total: current.notes.length,
                  note: noteName(n.midi),
                  next: nx === undefined ? undefined : noteName(nx.midi),
                  heard: ringUntil !== undefined,
                  level: Math.min(1, detector.level * 10),
                };
        } else {
          cue =
            elapsed < 0
              ? { phase: "count-in", beatsLeft: COUNT_IN_BEATS }
              : cueAt(current, elapsed * 1000);
          remainingSec = Math.max(0, Math.ceil(totalSec - Math.max(0, elapsed)));
        }
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
      // Let the last self-paced note's tail into the file.
      const endSec = selfPaced ? ctx.currentTime - t0 + (wasStopped() ? 0 : 0.2) : totalSec;
      stopNow = undefined;
      skipNote = undefined;
      cancelAnimationFrame(frame);
      cue = undefined;
      selfCue = undefined;
      node.disconnect();
      for (const tr of stream.getTracks()) tr.stop();
      if (wasStopped()) {
        status = "idle";
        message = "Stopped. Nothing was saved.";
        return;
      }

      status = "analysing";
      const length = Math.max(1, Math.round(endSec * rate));
      const pcm = new Float32Array(length);
      for (const c of chunks) {
        const at = c.frame - first;
        for (let i = 0; i < c.samples.length; i++) {
          if (at + i >= 0 && at + i < length) pcm[at + i] = c.samples[i] ?? 0;
        }
      }
      const truth = selfPaced ? selfPacedTruth(current, onsets) : takeTruth(current);
      if (truth.length === 0) {
        status = "idle";
        message = "No notes were heard, so nothing was saved. Check the microphone and try again.";
        return;
      }
      const out = await resample(pcm, rate);
      const entry = takeToEntry(
        current,
        { instrument, device, sampleRate: OUT_RATE, variant },
        truth,
      );
      const wav = writeWav(out, OUT_RATE);
      // Same pitch pipeline as the app, on the file just recorded.
      const detected = runWavBytes(wav, pipelineOptionsFor(entry)).notes;
      result = {
        wav,
        snippet: JSON.stringify(entry, null, 2),
        name: entry.id,
        score: scoreNotes(entry.notes, detected),
      };
      status = "done";
      message = "";
    } catch (e) {
      status = "idle";
      cue = undefined;
      selfCue = undefined;
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
    Put the phone on the music stand or about 50 cm from the piano, microphone towards the strings
    or speaker, in a quiet room.
  </li>
  <li>Press <strong>Record</strong> and allow the microphone.</li>
  <li>
    <strong>Single-note takes</strong> (bass, soft, loud) go at your own pace, with no clicks. The
    screen shows one note. Play it whenever you are ready and let it ring: the screen ticks when it
    hears the note, then shows the next one after about 2 seconds. If a note is not picked up, play
    it again a little louder, or tap <strong>Skip note</strong>.
  </li>
  <li>
    <strong>Melodies and two-hand takes</strong> keep time: 4 count-in clicks, then exactly one click
    for each note. Play the note shown as its click sounds; the bar fills up towards the next one.
  </li>
  <li>
    Check the result below, listen back, then <strong>Share</strong> (or Download) the WAV and JSON
    and send both to me. <strong>Stop</strong> cancels at any time.
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
  {#if instrument !== "voice"}
    <label
      >Keyboard
      <select
        value={presetName}
        data-testid="rec-range"
        onchange={(e) => {
          const name = e.currentTarget.value;
          const preset = KEYBOARD_RANGES[name as keyof typeof KEYBOARD_RANGES] as Range | undefined;
          if (preset) setRange(preset);
        }}
      >
        {#each Object.keys(KEYBOARD_RANGES) as name (name)}
          <option value={name}>{name}</option>
        {/each}
        <option value="custom" disabled>Custom</option>
      </select>
    </label>
    <div class="inline">
      <label
        >Lowest key
        <select
          value={range.low}
          data-testid="rec-range-low"
          onchange={(e) => {
            const low = Number(e.currentTarget.value);
            if (low < range.high) setRange({ low, high: range.high });
          }}
        >
          {#each KEY_CHOICES as m (m)}
            <option value={m}>{noteName(m)}</option>
          {/each}
        </select>
      </label>
      <label
        >Highest key
        <select
          value={range.high}
          data-testid="rec-range-high"
          onchange={(e) => {
            const high = Number(e.currentTarget.value);
            if (high > range.low) setRange({ low: range.low, high });
          }}
        >
          {#each KEY_CHOICES as m (m)}
            <option value={m}>{noteName(m)}</option>
          {/each}
        </select>
      </label>
    </div>
  {/if}
  <label>Device <input bind:value={device} /></label>
  <label>Id suffix (optional, e.g. laptop) <input bind:value={variant} /></label>
</fieldset>

{#if take}
  <p>{take.prompt}</p>
  {#if baseTake && take.notes.length < baseTake.notes.length}
    <p class="muted" data-testid="rec-range-note">
      {take.notes.length} of {baseTake.notes.length} notes are on your keyboard; the rest are left out.
    </p>
  {/if}
  <p class="muted">
    {#if take.selfPaced}
      {String(take.notes.length)} notes at your own pace, about {String(
        Math.round((take.notes.length * 3) / 60),
      )} minutes.
    {:else}
      {String(take.bpm)} bpm, {String(take.notes.length)} notes, about {String(
        Math.round(durationSec),
      )} s.
    {/if}
  </p>
  <p>
    {#if take.cadenceTonic !== undefined}
      <button type="button" onclick={cadence} disabled={status !== "idle" && status !== "done"}
        >Play cadence</button
      >
    {/if}
    {#if status === "recording"}
      {#if skipNote}
        <button type="button" class="button" onclick={() => skipNote?.()} data-testid="rec-skip"
          >Skip note</button
        >
      {/if}
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
        {#if cue.next !== undefined}
          <div class="bar" aria-hidden="true">
            <div style:width={`${String(Math.round(cue.towardNext * 100))}%`}></div>
          </div>
        {/if}
      {/if}
    {:else}
      <p class="big">Done</p>
    {/if}
    <p class="muted">{remainingSec} s left</p>
  </div>
{/if}
{#if status === "recording" && selfCue}
  <div class="cue" aria-live="polite" data-testid="rec-cue">
    <p class="label">Note {selfCue.index + 1} of {selfCue.total}</p>
    <p class="big">{selfCue.note}</p>
    <p class="next" data-testid="rec-heard">
      {selfCue.heard ? "Heard it, let it ring" : "Play it when ready"}
    </p>
    <div class="bar level" aria-hidden="true">
      <div style:width={`${String(Math.round(selfCue.level * 100))}%`}></div>
    </div>
    <p class="muted">{selfCue.next === undefined ? "Last note" : `Then: ${selfCue.next}`}</p>
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
              <td>{n.verdict === "exact" ? "ok" : n.verdict}</td>
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

  .bar {
    height: 8px;
    margin: var(--space-2) auto 0;
    max-width: 16rem;
    border: 1px solid var(--color-border);
    border-radius: 4px;
    overflow: hidden;
  }

  .bar div {
    height: 100%;
    background: var(--color-accent);
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
