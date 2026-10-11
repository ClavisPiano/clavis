<script lang="ts">
  import { asset } from "$app/paths";
  import {
    COUNT_IN_BEATS,
    midiToHz,
    takeToEntry,
    takeTruth,
    takesFor,
    writeWav,
    type Take,
  } from "@clavis/audio";
  import type { FixtureInstrument } from "@clavis/audio";

  // Records a fixture take to 22.05 kHz mono WAV with a count-in click, and builds the matching
  // manifest entry from the score. See docs/fixtures-recording.md.
  const OUT_RATE = 22050;

  let instrument = $state<FixtureInstrument>("acoustic-piano");
  let device = $state("iPhone built-in mic");
  let variant = $state("");
  let slug = $state(takesFor("acoustic-piano")[0]?.slug ?? "");
  let status = $state<"idle" | "recording" | "done">("idle");
  let message = $state("");
  let result = $state<{ wav: Uint8Array; snippet: string; name: string } | undefined>();

  const takes = $derived(takesFor(instrument));
  const take = $derived<Take | undefined>(takes.find((t) => t.slug === slug) ?? takes[0]);

  $effect(() => {
    if (take !== undefined && take.slug !== slug) slug = take.slug;
  });

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

  async function record(): Promise<void> {
    if (take === undefined) return;
    result = undefined;
    message = "";
    // Everything below starts inside the tap, so iOS allows the context and the mic prompt.
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
      const beatSec = 60 / take.bpm;
      for (let b = 0; b < COUNT_IN_BEATS; b++) {
        beep(ctx, t0 + b * beatSec, b === 0 ? 1600 : 1000, 0.05, 0.4);
      }
      const lastEnd = Math.max(...takeTruth(take).map((n) => n.offsetMs ?? n.onsetMs)) / 1000;
      const totalSec = lastEnd + 1.5;
      status = "recording";
      message = `Count-in, then play. ${String(Math.round(totalSec))} s.`;
      await new Promise((r) => setTimeout(r, (0.5 + totalSec) * 1000));

      node.disconnect();
      for (const tr of stream.getTracks()) tr.stop();
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
      const entry = takeToEntry(take, { instrument, device, sampleRate: OUT_RATE, variant });
      result = {
        wav: writeWav(out, OUT_RATE),
        snippet: JSON.stringify(entry, null, 2),
        name: entry.id,
      };
      status = "done";
      message = `Recorded ${entry.id}. Listen to it, then download.`;
    } catch (e) {
      status = "idle";
      message = e instanceof Error ? e.message : String(e);
    } finally {
      await ctx.close();
    }
  }

  function save(data: BlobPart, name: string, type: string): void {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([data], { type }));
    a.download = name;
    a.click();
    setTimeout(() => {
      URL.revokeObjectURL(a.href);
    }, 10000);
  }

  function download(): void {
    if (result === undefined) return;
    save(result.wav as BlobPart, `${result.name}.wav`, "audio/wav");
    save(result.snippet, `${result.name}.json`, "application/json");
  }

  const wavUrl = $derived(
    result === undefined
      ? undefined
      : URL.createObjectURL(new Blob([result.wav as BlobPart], { type: "audio/wav" })),
  );
</script>

<h1>Record fixture</h1>
<p>
  Pick the instrument and take, press Record, play along with the 4 count-in clicks. Needs the mic.
  Turn the speaker down or use headphones for the click if it bleeds into the recording.
</p>

<label
  >Instrument
  <select bind:value={instrument}>
    <option value="voice">voice</option>
    <option value="acoustic-piano">acoustic-piano</option>
    <option value="digital-piano">digital-piano</option>
  </select>
</label>
<label>Device <input bind:value={device} /></label>
<label>Id suffix (optional, e.g. laptop) <input bind:value={variant} /></label>
<label
  >Take
  <select bind:value={slug}>
    {#each takes as t (t.slug)}
      <option value={t.slug}>{t.label}</option>
    {/each}
  </select>
</label>

{#if take}
  <p>{take.prompt}</p>
  <p>{String(take.bpm)} bpm, {String(take.notes.length)} notes.</p>
  {#if take.cadenceTonic !== undefined}
    <button type="button" onclick={cadence} disabled={status === "recording"}>Play cadence</button>
  {/if}
  <button type="button" onclick={record} disabled={status === "recording"}>Record</button>
{/if}

<p aria-live="polite">{message}</p>
{#if result && wavUrl}
  <audio controls src={wavUrl}></audio>
  <button type="button" onclick={download}>Download WAV + manifest snippet</button>
  <pre>{result.snippet}</pre>
{/if}
