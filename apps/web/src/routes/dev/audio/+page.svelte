<script lang="ts">
  import { onMount } from "svelte";
  import { asset } from "$app/paths";
  import { PitchDetector } from "pitchy";
  import {
    AudioContextManager,
    SmplrPianoInstrument,
    StimulusPlayer,
    type ManagerState,
  } from "@clavis/audio";
  import type { StimulusSpec } from "@clavis/core";
  import { cadenceSpec } from "../../../lib/stimulus-dev";
  import {
    adaptiveThreshold,
    findGaps,
    firstSpike,
    median,
    rms,
    toDb,
    type LevelFrame,
  } from "../../../lib/audio-spike/dsp";
  import {
    SESSION_TYPES,
    applySessionType,
    collectEnvironment,
    currentSessionType,
    getAudioSession,
    type SessionType,
  } from "../../../lib/audio-spike/env";
  import { buildReport, type BleedResult, type LogEntry } from "../../../lib/audio-spike/report";

  // The page owns the session type (the shared manager would force "playback" in unlock()).
  const audio = new AudioContextManager({ audioSession: undefined });
  const piano = new SmplrPianoInstrument({
    getContext: () => audio.getContext() as unknown as BaseAudioContext,
    baseUrl: asset("samples/piano/manifest.json").replace(/\/manifest\.json$/, ""),
  });
  const player = new StimulusPlayer(audio, piano);

  const FFT_SIZE = 2048;
  const LEVEL_WINDOW = 256;
  const CADENCE: StimulusSpec = cadenceSpec({ tonic: "C", mode: "major" });
  const A4: StimulusSpec = {
    events: [{ atSec: 0, midi: [69], durationSec: 2, velocity: 0.7, role: "reference" }],
  };
  const CLICK: StimulusSpec = {
    events: [{ atSec: 0, midi: [72, 84, 96], durationSec: 0.1, velocity: 1, role: "count-in" }],
  };
  const LATENCY_RUNS = 5;

  let ctxState = $state<ManagerState>("uninitialized");
  let sessionChoice = $state<SessionType>("play-and-record");
  let sessionSupported = $state(false);
  let sessionCurrent = $state("n/a");
  let samplesReady = $state(false);
  let busy = $state(false);
  let error = $state<string | undefined>();
  let volumeNote = $state("");
  let notes = $state("");
  let env = $state<Record<string, string>>({});
  let log = $state<LogEntry[]>([]);

  let echoCancellation = $state(false);
  let noiseSuppression = $state(false);
  let autoGainControl = $state(false);
  let micRequested = $state<Record<string, boolean> | undefined>();
  let micSettings = $state<Record<string, unknown> | undefined>();
  let micOn = $state(false);
  let level = $state(0);
  let peakHold = $state(0);
  let pitchText = $state("-");

  let bleed = $state<BleedResult | undefined>();
  let latencyRuns = $state<(number | null)[]>([]);
  let heartbeats = $state(0);
  let lastHeartbeatCtx = $state<number | undefined>();
  let heartbeatWall: number[] = [];
  let heartbeatGaps = $state<{ atMs: number; gapMs: number }[]>([]);
  let reportText = $state("");
  let copyStatus = $state("");

  let stream: MediaStream | undefined;
  let source: MediaStreamAudioSourceNode | undefined;
  let analyser: AnalyserNode | undefined;
  let rafId = 0;
  const timeBuf = new Float32Array(FFT_SIZE);
  let frameListeners: ((f: LevelFrame) => void)[] = [];

  function ctx(): AudioContext {
    return audio.getContext() as unknown as AudioContext;
  }

  function addLog(message: string): void {
    const d = new Date();
    const time = d.toTimeString().slice(0, 8) + "." + String(d.getMilliseconds()).padStart(3, "0");
    log = [...log, { time, message }];
  }

  function refreshEnv(): void {
    env = collectEnvironment(audio.state === "uninitialized" ? undefined : ctx());
    sessionCurrent = currentSessionType();
  }

  function fail(e: unknown): void {
    error = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
    addLog(`error ${error}`);
  }

  function applySession(): void {
    const err = applySessionType(sessionChoice);
    addLog(
      err
        ? `audioSession.type = ${sessionChoice} failed: ${err}`
        : `audioSession.type = ${sessionChoice}`,
    );
    sessionCurrent = currentSessionType();
  }

  onMount(() => {
    sessionSupported = getAudioSession() !== undefined;
    refreshEnv();
    addLog("page loaded");
    const onVis = (): void => {
      addLog(`visibilitychange ${document.visibilityState}`);
      refreshEnv();
    };
    const onHide = (): void => {
      addLog("pagehide");
    };
    const onShow = (e: PageTransitionEvent): void => {
      addLog(`pageshow persisted=${String(e.persisted)}`);
      refreshEnv();
    };
    const onFreeze = (): void => {
      addLog("freeze");
    };
    const onResume = (): void => {
      addLog("resume");
    };
    document.addEventListener("visibilitychange", onVis);
    document.addEventListener("freeze", onFreeze);
    document.addEventListener("resume", onResume);
    window.addEventListener("pagehide", onHide);
    window.addEventListener("pageshow", onShow);
    const unsub = audio.subscribe((s) => {
      ctxState = s;
      addLog(`context state ${s}`);
      refreshEnv();
    });
    return () => {
      unsub();
      document.removeEventListener("visibilitychange", onVis);
      document.removeEventListener("freeze", onFreeze);
      document.removeEventListener("resume", onResume);
      window.removeEventListener("pagehide", onHide);
      window.removeEventListener("pageshow", onShow);
      stopMic();
      void audio.dispose();
    };
  });

  /** Must run synchronously inside a gesture handler up to the audio.unlock() call. */
  function startContext(): Promise<ManagerState> {
    if (sessionSupported) applySession();
    const p = audio.unlock();
    ctxState = audio.state;
    return p;
  }

  async function unlock(): Promise<void> {
    error = undefined;
    busy = true;
    try {
      const state = await startContext();
      addLog(`unlock -> ${state}`);
      refreshEnv();
      if (!samplesReady) {
        addLog("loading samples");
        await player.load();
        samplesReady = true;
        addLog("samples ready");
      }
    } catch (e) {
      fail(e);
    } finally {
      busy = false;
    }
  }

  function play(spec: StimulusSpec, label: string): void {
    error = undefined;
    if (!samplesReady) {
      error = "Unlock audio first so the samples load.";
      return;
    }
    try {
      const r = player.play(spec);
      addLog(`play ${label} at ${r.startAt.toFixed(3)} s, ends ${r.endAt.toFixed(3)} s`);
    } catch (e) {
      fail(e);
    }
  }

  // Microphone and frame loop

  function frame(): void {
    rafId = requestAnimationFrame(frame);
    if (!analyser) return;
    analyser.getFloatTimeDomainData(timeBuf);
    const recent = timeBuf.subarray(FFT_SIZE - LEVEL_WINDOW);
    const lv = rms(recent);
    level = lv;
    peakHold = Math.max(peakHold * 0.995, lv);
    const t = ctx().currentTime;
    for (const l of frameListeners) l({ t, level: lv });
    if (lv < 0.005) {
      pitchText = "-";
      return;
    }
    const [hz, clarity] = detector.findPitch(timeBuf, ctx().sampleRate);
    pitchText = clarity > 0.9 ? `${hz.toFixed(1)} Hz (clarity ${clarity.toFixed(2)})` : "unclear";
  }
  const detector = PitchDetector.forFloat32Array(FFT_SIZE);

  async function startMic(): Promise<void> {
    error = undefined;
    if (micOn) return;
    busy = true;
    try {
      const ready = startContext();
      const requested = {
        echoCancellation,
        noiseSuppression,
        autoGainControl,
      };
      micRequested = requested;
      addLog(`getUserMedia ${JSON.stringify(requested)}`);
      stream = await navigator.mediaDevices.getUserMedia({ audio: requested });
      await ready;
      const track = stream.getAudioTracks()[0];
      micSettings = track ? { ...track.getSettings() } : undefined;
      addLog(`mic settings ${JSON.stringify(micSettings)}`);
      const c = ctx();
      source = c.createMediaStreamSource(stream);
      analyser = c.createAnalyser();
      analyser.fftSize = FFT_SIZE;
      analyser.smoothingTimeConstant = 0;
      source.connect(analyser);
      micOn = true;
      peakHold = 0;
      rafId = requestAnimationFrame(frame);
      refreshEnv();
    } catch (e) {
      fail(e);
      stopMic();
    } finally {
      busy = false;
    }
  }

  function stopMic(): void {
    cancelAnimationFrame(rafId);
    source?.disconnect();
    stream?.getTracks().forEach((t) => {
      t.stop();
    });
    source = undefined;
    analyser = undefined;
    stream = undefined;
    if (micOn) addLog("mic stopped");
    micOn = false;
    level = 0;
    pitchText = "-";
    refreshEnv();
  }

  /** Collects level frames for `seconds` of context time. */
  function capture(seconds: number): Promise<LevelFrame[]> {
    return new Promise((resolve) => {
      const frames: LevelFrame[] = [];
      const end = ctx().currentTime + seconds;
      const listener = (f: LevelFrame): void => {
        frames.push(f);
        if (f.t >= end) {
          frameListeners = frameListeners.filter((l) => l !== listener);
          resolve(frames);
        }
      };
      frameListeners = [...frameListeners, listener];
    });
  }

  const peakOf = (frames: readonly LevelFrame[]): number =>
    frames.reduce((m, f) => Math.max(m, f.level), 0);

  function requireMicAndSamples(): boolean {
    if (!micOn || !samplesReady) {
      error = "Start the mic and unlock audio (samples loaded) first.";
      return false;
    }
    if (document.visibilityState === "hidden") {
      error = "Page is hidden; frames are not running.";
      return false;
    }
    return true;
  }

  async function bleedTest(): Promise<void> {
    error = undefined;
    if (!requireMicAndSamples()) return;
    busy = true;
    try {
      addLog(`bleed test start (session ${currentSessionType()}, ctx ${audio.state})`);
      const silence = peakOf(await capture(1));
      const pending = capture(3.5);
      play(CADENCE, "cadence (bleed test)");
      const playback = peakOf(await pending);
      bleed = { silencePeak: silence, playbackPeak: playback };
      addLog(
        `bleed silence ${toDb(silence).toFixed(1)} dBFS, playback ${toDb(playback).toFixed(1)} dBFS`,
      );
      refreshEnv();
    } catch (e) {
      fail(e);
    } finally {
      busy = false;
    }
  }

  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

  async function latencyProbe(): Promise<void> {
    error = undefined;
    if (!requireMicAndSamples()) return;
    busy = true;
    latencyRuns = [];
    try {
      for (let i = 0; i < LATENCY_RUNS; i++) {
        const baseline = peakOf(await capture(0.4));
        const threshold = adaptiveThreshold(baseline);
        const t0 = ctx().currentTime + 0.3;
        player.play(CLICK, { startAt: t0 });
        const frames = await capture(1.2);
        const spike = firstSpike(frames, threshold, t0 - 0.002);
        const ms = spike ? (spike.t - t0) * 1000 : null;
        latencyRuns = [...latencyRuns, ms];
        addLog(
          `latency run ${String(i + 1)}: ${ms === null ? "no spike" : ms.toFixed(0) + " ms"} (threshold ${threshold.toFixed(3)})`,
        );
        await sleep(600);
      }
    } catch (e) {
      fail(e);
    } finally {
      busy = false;
    }
  }

  const latencyMedian = $derived(median(latencyRuns.filter((v): v is number => v !== null)));

  // AudioWorklet heartbeat

  let workletNode: AudioWorkletNode | undefined;
  let workletOn = $state(false);

  async function startWorklet(): Promise<void> {
    error = undefined;
    if (workletNode) return;
    busy = true;
    try {
      await startContext();
      const c = ctx();
      await c.audioWorklet.addModule(asset("dev/heartbeat-processor.js"));
      const node = new AudioWorkletNode(c, "heartbeat");
      node.port.onmessage = (e: MessageEvent<{ count: number; contextTime: number }>) => {
        heartbeats = e.data.count;
        lastHeartbeatCtx = e.data.contextTime;
        const now = Date.now();
        const prev = heartbeatWall[heartbeatWall.length - 1];
        heartbeatWall.push(now);
        if (prev !== undefined && now - prev > 1500) {
          addLog(
            `heartbeat gap ${((now - prev) / 1000).toFixed(1)} s (count ${String(e.data.count)})`,
          );
        }
        heartbeatGaps = findGaps(heartbeatWall, 1500);
      };
      const silent = c.createGain();
      silent.gain.value = 0;
      node.connect(silent).connect(c.destination);
      workletNode = node;
      workletOn = true;
      addLog("worklet heartbeat started");
    } catch (e) {
      fail(e);
    } finally {
      busy = false;
    }
  }

  // Report

  function report(): string {
    refreshEnv();
    return buildReport({
      generatedAt: new Date().toISOString(),
      environment: env,
      sessionType: { requested: sessionChoice, current: currentSessionType() },
      volumeNote,
      micRequested,
      micSettings,
      bleed,
      latencyRunsMs: latencyRuns,
      worklet: { heartbeats, lastContextTime: lastHeartbeatCtx, gaps: heartbeatGaps },
      notes,
      log,
    });
  }

  async function copyReport(): Promise<void> {
    reportText = report();
    try {
      await navigator.clipboard.writeText(reportText);
      copyStatus = "Copied to clipboard";
    } catch {
      copyStatus = "Clipboard blocked: select the text below and copy it manually";
    }
  }
</script>

<h1>iOS audio spike</h1>
<p class="hint">
  Run the steps in order, top to bottom, then tap Copy report and paste into
  <code>docs/spikes/ios-audio.md</code>.
</p>

{#if error}<p role="alert" class="error">{error}</p>{/if}

<section>
  <h2>1. Environment</h2>
  <dl data-testid="env">
    {#each Object.entries(env) as [k, v] (k)}
      <dt>{k}</dt>
      <dd>{v}</dd>
    {/each}
  </dl>
  <button type="button" onclick={refreshEnv}>Refresh</button>
</section>

<section>
  <h2>2. Audio session</h2>
  <label>
    navigator.audioSession.type
    <select
      bind:value={sessionChoice}
      disabled={!sessionSupported}
      onchange={() => {
        if (sessionSupported) applySession();
      }}
    >
      {#each SESSION_TYPES as t (t)}
        <option value={t}>{t}</option>
      {/each}
    </select>
  </label>
  <p class="hint">
    {#if sessionSupported}Current: <strong data-testid="session-current">{sessionCurrent}</strong>.
      Applied on change and again just before unlock or mic start.{:else}navigator.audioSession is
      not supported here.{/if}
  </p>
</section>

<section>
  <h2>3. Playback</h2>
  <div class="row">
    <button type="button" disabled={busy} onclick={unlock}>Unlock audio</button>
    <button
      type="button"
      onclick={() => {
        play(CADENCE, "C major cadence");
      }}>Play C major cadence</button
    >
    <button
      type="button"
      onclick={() => {
        play(A4, "A4");
      }}>Play single A4</button
    >
    <button
      type="button"
      onclick={() => {
        player.stop();
      }}>Stop</button
    >
  </div>
  <p>
    Context: <strong data-testid="ctx-state">{ctxState}</strong>. Samples:
    <strong data-testid="samples">{samplesReady ? "ready" : "not loaded"}</strong>.
  </p>
  <label>
    Volume note (loudness, route, silent switch)
    <input
      type="text"
      bind:value={volumeNote}
      placeholder="e.g. speaker, quiet, silent switch on"
    />
  </label>
</section>

<section>
  <h2>4. Microphone</h2>
  <div class="checks">
    <label
      ><input type="checkbox" bind:checked={echoCancellation} disabled={micOn} /> echoCancellation</label
    >
    <label
      ><input type="checkbox" bind:checked={noiseSuppression} disabled={micOn} /> noiseSuppression</label
    >
    <label
      ><input type="checkbox" bind:checked={autoGainControl} disabled={micOn} /> autoGainControl</label
    >
  </div>
  <div class="row">
    <button type="button" disabled={busy || micOn} onclick={startMic}>Start mic</button>
    <button type="button" disabled={!micOn} onclick={stopMic}>Stop mic</button>
  </div>
  <p>
    Input level: <strong data-testid="level">{toDb(level).toFixed(1)} dBFS</strong>
    (peak hold {toDb(peakHold).toFixed(1)})
  </p>
  <meter min="0" max="1" value={Math.min(1, level * 4)}></meter>
  <p>Raw pitch: <strong data-testid="pitch">{pitchText}</strong></p>
  <h3>Applied settings</h3>
  {#if micSettings}
    <dl data-testid="mic-settings">
      {#each Object.entries(micSettings) as [k, v] (k)}
        <dt>{k}</dt>
        <dd>{JSON.stringify(v)}</dd>
      {/each}
    </dl>
  {:else}
    <p class="hint">Start the mic to see what the track really applied.</p>
  {/if}
</section>

<section>
  <h2>5. Playback while mic open</h2>
  <p class="hint">
    Keep the room quiet. Measures 1 s of silence, then plays the cadence and records the input peak.
    Also listen: did the volume or output route change after the mic opened?
  </p>
  <button type="button" disabled={busy || !micOn} onclick={bleedTest}
    >Play cadence with mic open</button
  >
  {#if bleed}
    <p data-testid="bleed">
      Silence peak {toDb(bleed.silencePeak).toFixed(1)} dBFS, playback peak
      {toDb(bleed.playbackPeak).toFixed(1)} dBFS.
    </p>
  {/if}
</section>

<section>
  <h2>6. Latency probe</h2>
  <p class="hint">
    Rough. Plays a click through the speaker and times the first input spike. Needs the speaker
    audible to the mic (no headphones), mic running, samples loaded. {LATENCY_RUNS} runs.
  </p>
  <button type="button" disabled={busy || !micOn} onclick={latencyProbe}>Run latency probe</button>
  <p data-testid="latency">
    Runs: {latencyRuns.map((v) => (v === null ? "none" : v.toFixed(0))).join(", ") || "-"} ms. Median:
    {latencyMedian === undefined ? "-" : latencyMedian.toFixed(0)} ms
  </p>
</section>

<section>
  <h2>7. AudioWorklet survival</h2>
  <p class="hint">
    Start it, then switch to another app or lock the screen for 30 s or more, and come back.
    Heartbeats should keep counting without gaps.
  </p>
  <button type="button" disabled={busy || workletOn} onclick={startWorklet}>Start heartbeat</button>
  <p>
    Heartbeats: <strong data-testid="heartbeats">{heartbeats}</strong>. Gaps over 1.5 s:
    <strong>{heartbeatGaps.length}</strong>
  </p>
  <h3>Event log</h3>
  <pre data-testid="log">{log.map((e) => `${e.time} ${e.message}`).join("\n")}</pre>
</section>

<section>
  <h2>8. Report</h2>
  <label>
    Notes
    <textarea rows="3" bind:value={notes} placeholder="Anything else you noticed"></textarea>
  </label>
  <button type="button" class="primary" onclick={copyReport}>Copy report</button>
  {#if copyStatus}<p role="status">{copyStatus}</p>{/if}
  {#if reportText}
    <textarea readonly rows="12" data-testid="report" value={reportText}></textarea>
  {/if}
</section>

<style>
  section {
    margin-block: 1.5rem;
    padding-block-start: 0.5rem;
    border-block-start: 1px solid color-mix(in srgb, currentColor 20%, transparent);
  }
  .row {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
    margin-block: 0.5rem;
  }
  .checks {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    margin-block: 0.5rem;
  }
  .checks label {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    min-height: 44px;
  }
  .checks input[type="checkbox"] {
    width: 24px;
    height: 24px;
  }
  button {
    min-height: 48px;
    padding: 0 1rem;
    font: inherit;
  }
  .primary {
    width: 100%;
    margin-block: 0.5rem;
  }
  label {
    display: block;
  }
  select,
  input[type="text"],
  textarea {
    display: block;
    width: 100%;
    min-height: 44px;
    font: inherit;
    box-sizing: border-box;
  }
  meter {
    width: 100%;
    height: 1.5rem;
  }
  dl {
    display: grid;
    grid-template-columns: max-content 1fr;
    gap: 0.25rem 1rem;
    margin: 0;
  }
  dd {
    margin: 0;
    overflow-wrap: anywhere;
  }
  pre {
    max-height: 14rem;
    overflow: auto;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    font-size: 0.8rem;
  }
  .hint {
    opacity: 0.75;
  }
  .error {
    color: crimson;
  }
</style>
