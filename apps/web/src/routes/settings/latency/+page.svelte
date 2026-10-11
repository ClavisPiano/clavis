<script lang="ts">
  import { onMount } from "svelte";
  import { resolve } from "$app/paths";
  import { page } from "$app/state";
  import {
    estimateLatency,
    eventTimeToContextMs,
    getAudioContextManager,
    scheduleClickTrack,
    type CaptureContext,
    type ClickContextLike,
    type LatencyEstimate,
  } from "@clavis/audio";
  import { createLevelMeter } from "@clavis/audio/web";
  import { initAppStore } from "../../../lib/app-store";
  import {
    readLatency,
    resetLatency,
    saveLatency,
    type LatencyMeta,
    type MetaStore,
  } from "../../../lib/latency";

  type Path = "tap" | "mic";
  type Phase = "idle" | "running" | "done";

  interface Result {
    estimate: LatencyEstimate;
  }

  const audio = getAudioContextManager();
  const testMode = $derived(page.url.searchParams.get("test") === "1");

  let phase = $state<Phase>("idle");
  let active = $state<Path | undefined>();
  let message = $state("");
  let results = $state<Partial<Record<Path, Result>>>({});
  let saved = $state<LatencyMeta | undefined>();
  let store = $state.raw<MetaStore | undefined>();
  let storeError = $state(false);
  let tapCount = $state(0);
  let clickTimes: number[] = [];
  let observed: number[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  let meter: ReturnType<typeof createLevelMeter> | undefined;
  let offOnset: (() => void) | undefined;

  onMount(() => {
    void (async () => {
      const s = await initAppStore();
      if (!s.ok) {
        storeError = true;
        return;
      }
      store = s.store;
      saved = await readLatency(store);
    })();
    return () => {
      clearTimeout(timer);
      offOnset?.();
      meter?.stop();
    };
  });

  $effect(() => {
    if (!testMode) return;
    window.__clavisLatency = {
      clickTimesMs: () => [...clickTimes],
      injectTap: (ms) => {
        recordObservation(ms);
      },
    };
    return () => {
      delete window.__clavisLatency;
    };
  });

  function recordObservation(contextMs: number): void {
    if (phase !== "running") return;
    observed.push(contextMs);
    tapCount = observed.length;
  }

  function onPadDown(event: PointerEvent): void {
    if (active !== "tap") return;
    const ctx = audio.getContext() as unknown as {
      currentTime: number;
      getOutputTimestamp?: () => { contextTime?: number; performanceTime?: number };
    };
    recordObservation(
      eventTimeToContextMs(event.timeStamp, {
        outputTimestamp: ctx.getOutputTimestamp?.(),
        contextNowMs: ctx.currentTime * 1000,
        performanceNowMs: performance.now(),
      }),
    );
  }

  function begin(path: Path): ReturnType<typeof scheduleClickTrack> {
    phase = "running";
    active = path;
    observed = [];
    tapCount = 0;
    const ctx = audio.getContext();
    const track = scheduleClickTrack(ctx as unknown as ClickContextLike);
    clickTimes = track.clickTimesMs;
    return track;
  }

  function finish(path: Path): void {
    const estimate = estimateLatency(clickTimes, observed);
    results = { ...results, [path]: { estimate } };
    phase = "done";
    active = undefined;
    offOnset?.();
    offOnset = undefined;
    meter?.stop();
    message = estimate.ok ? "" : "Not enough clean responses. Retry.";
  }

  function scheduleFinish(path: Path, endMs: number): void {
    const ctx = audio.getContext();
    const wait = Math.max(0, endMs - ctx.currentTime * 1000) + (path === "tap" ? 600 : 400);
    timer = setTimeout(() => {
      finish(path);
    }, wait);
  }

  async function startTap(): Promise<void> {
    message = "";
    const unlock = audio.unlock();
    await unlock;
    const track = begin("tap");
    scheduleFinish("tap", track.endMs);
  }

  async function startMic(): Promise<void> {
    message = "";
    try {
      await audio.unlock();
      meter ??= createLevelMeter();
      offOnset?.();
      offOnset = meter.onOnset((ms) => {
        recordObservation(ms);
      });
      if (!meter.running) await meter.start(audio.getContext() as unknown as CaptureContext);
    } catch (error) {
      message = `Microphone unavailable: ${error instanceof Error ? error.message : String(error)}`;
      return;
    }
    // Let the detector learn the room's noise floor before the first click.
    const track = begin("mic");
    scheduleFinish("mic", track.endMs);
  }

  function round(n: number): string {
    return n.toFixed(1);
  }

  async function onSave(): Promise<void> {
    if (!store) return;
    const update: { tapMs?: number; micMs?: number } = {};
    const tap = results.tap?.estimate;
    const mic = results.mic?.estimate;
    if (tap?.ok) update.tapMs = Math.round(tap.offsetMs * 10) / 10;
    if (mic?.ok) update.micMs = Math.round(mic.offsetMs * 10) / 10;
    saved = await saveLatency(store, update, {
      now: () => Date.now(),
      userAgent: navigator.userAgent,
    });
    message = "Saved.";
  }

  async function onReset(): Promise<void> {
    if (!store) return;
    await resetLatency(store);
    saved = undefined;
    results = {};
    message = "Reset.";
  }

  const canSave = $derived(
    store !== undefined && phase !== "running" && Object.values(results).some((r) => r.estimate.ok),
  );
</script>

<h1>Latency calibration</h1>
<p>
  <a href={resolve("/settings")}>Back to settings</a>
</p>
<p>
  Rhythm scoring needs to know how long this device takes to play a sound and register a touch or a
  note. Use the same output you will practise with (speaker or headphones). The test plays
  {12} clicks at 100 bpm after a one second lead-in.
</p>

<section>
  <h2>Tap along</h2>
  <p>Tap the pad in time with the clicks. Start with the first click you hear.</p>
  <button
    type="button"
    data-testid="start-tap"
    disabled={phase === "running"}
    onclick={() => void startTap()}
  >
    Start tap test
  </button>
  <div
    class="pad"
    class:live={active === "tap"}
    role="button"
    tabindex="0"
    aria-label="Tap pad"
    data-testid="tap-pad"
    onpointerdown={onPadDown}
  >
    {active === "tap" ? "Tap along with the clicks" : "Tap pad"}
  </div>
  <p data-testid="tap-count">Taps recorded: {tapCount}</p>
  {#if results.tap}
    {@const e = results.tap.estimate}
    <p data-testid="tap-result">
      Tap latency {round(e.offsetMs)} ms, spread {round(e.spreadMs)} ms, {e.used} used, {e.rejected}
      rejected:
      <strong data-testid="tap-verdict">{e.ok ? "ok" : "retry"}</strong>
    </p>
  {/if}
</section>

<section>
  <h2>Microphone (optional)</h2>
  <p>
    Hold the phone near the speaker or piano in a quiet room, without headphones. The microphone
    listens for each click.
  </p>
  <button
    type="button"
    data-testid="start-mic"
    disabled={phase === "running"}
    onclick={() => void startMic()}
  >
    Start microphone test
  </button>
  {#if active === "mic"}
    <p data-testid="mic-count">Clicks heard: {tapCount}</p>
  {/if}
  {#if results.mic}
    {@const e = results.mic.estimate}
    <p data-testid="mic-result">
      Output plus input latency {round(e.offsetMs)} ms, spread {round(e.spreadMs)} ms, {e.used} used,
      {e.rejected} rejected:
      <strong data-testid="mic-verdict">{e.ok ? "ok" : "retry"}</strong>
    </p>
  {/if}
</section>

<section>
  <h2>Saved on this device</h2>
  {#if storeError}
    <p>Local storage is unavailable, so the calibration cannot be saved.</p>
  {:else if saved}
    <p data-testid="saved">
      Tap: {saved.tapMs === undefined ? "not measured" : `${round(saved.tapMs)} ms`}. Mic: {saved.micMs ===
      undefined
        ? "not measured"
        : `${round(saved.micMs)} ms`}. Measured {new Date(saved.measuredAt).toLocaleString()}.
    </p>
  {:else}
    <p data-testid="saved">Not calibrated.</p>
  {/if}
  <button type="button" data-testid="save" disabled={!canSave} onclick={() => void onSave()}>
    Save
  </button>
  <button
    type="button"
    data-testid="reset"
    disabled={saved === undefined}
    onclick={() => void onReset()}
  >
    Reset
  </button>
  <p role="status" data-testid="message">{message}</p>
</section>

<style>
  .pad {
    display: grid;
    place-items: center;
    min-height: 40vh;
    margin: 1rem 0;
    border: 2px dashed currentColor;
    border-radius: 1rem;
    touch-action: manipulation;
    user-select: none;
    -webkit-user-select: none;
    opacity: 0.6;
  }
  .pad.live {
    opacity: 1;
    border-style: solid;
  }
  button {
    min-height: 44px;
    padding: 0 1rem;
  }
</style>
