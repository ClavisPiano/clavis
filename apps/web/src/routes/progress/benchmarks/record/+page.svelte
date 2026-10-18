<script lang="ts">
  import { wallNow } from "../../../../lib/clock";
  import { onMount } from "svelte";
  import { goto } from "$app/navigation";
  import { resolve } from "$app/paths";
  import {
    MAX_BENCHMARK_MS,
    benchmarkMonth,
    benchmarkOptions,
    createUlidGenerator,
  } from "@clavis/core";
  import NotationView from "../../../../lib/components/NotationView.svelte";
  import { remoteDeleter } from "../../../../lib/benchmark/app";
  import {
    browserRecorderEnv,
    startRecording,
    type Recording,
    type Take,
  } from "../../../../lib/benchmark/recorder";
  import { saveBenchmark } from "../../../../lib/benchmark/save";
  import { clockLabel, defaultBenchmarkPiece, monthLabel } from "../../../../lib/benchmark/view";
  import { getBlobStore } from "../../../../lib/blobs/app";
  import { deviceTzOffsetMin } from "../../../../lib/home";
  import { useLearner } from "../../../../lib/learner.svelte";
  import { appPieces } from "../../../../lib/pieces";
  import { getNotationClient } from "../../../../lib/notation/shared";
  import { createNotationViewPort } from "../../../../lib/notation/view-port";

  /*
   * Record the monthly benchmark (T6.5, R28): choose a piece, play it from the score, listen back
   * and save. The take is not graded.
   */

  const learner = useLearner();
  const port = createNotationViewPort(getNotationClient());
  const library = appPieces();

  type Phase = "ready" | "starting" | "recording" | "review" | "saving";
  let phase = $state<Phase>("ready");
  let pieceId = $state<string | undefined>();
  let recording: Recording | undefined;
  let take = $state.raw<Take | undefined>();
  let takeUrl = $state<string | undefined>();
  let elapsedMs = $state(0);
  let ticker: number | undefined;
  let error = $state("");
  let scoreFailed = $state(false);
  let now = $state(wallNow());

  const supported = typeof window !== "undefined" && browserRecorderEnv() !== undefined;

  onMount(() => {
    void learner.init().then(() => {
      now = wallNow();
      const state = learner.state;
      if (state) pieceId ??= defaultBenchmarkPiece(options, state.benchmarks);
    });
    return () => {
      recording?.cancel();
      stopTicker();
      if (takeUrl) URL.revokeObjectURL(takeUrl);
      port.hide();
    };
  });

  const options = $derived(learner.state ? benchmarkOptions(library, learner.state) : []);
  const piece = $derived(options.find((o) => o.piece.id === pieceId)?.piece);
  const month = $derived(benchmarkMonth(now, deviceTzOffsetMin()));
  const existing = $derived(learner.state?.benchmarks[month]);

  $effect(() => {
    if (!piece) {
      port.hide();
      return;
    }
    scoreFailed = false;
    port.show(piece.score).catch(() => {
      scoreFailed = true;
    });
  });

  function stopTicker(): void {
    if (ticker !== undefined) window.clearInterval(ticker);
    ticker = undefined;
  }

  function clearTake(): void {
    if (takeUrl) URL.revokeObjectURL(takeUrl);
    takeUrl = undefined;
    take = undefined;
  }

  async function record(): Promise<void> {
    const env = browserRecorderEnv();
    if (!env) return;
    error = "";
    clearTake();
    phase = "starting";
    try {
      recording = await startRecording(env);
    } catch (e) {
      phase = "ready";
      error =
        e instanceof DOMException && e.name === "NotAllowedError"
          ? "Clavis needs the microphone to record. Allow it in your browser and try again."
          : `Recording could not start: ${e instanceof Error ? e.message : String(e)}`;
      return;
    }
    phase = "recording";
    const started = performance.now();
    elapsedMs = 0;
    ticker = window.setInterval(() => {
      elapsedMs = performance.now() - started;
    }, 250);
    const current = recording;
    try {
      const t = await current.done;
      take = t;
      takeUrl = URL.createObjectURL(t.blob);
      phase = "review";
    } catch (e) {
      if (recording === current) {
        phase = "ready";
        error = `Recording failed: ${e instanceof Error ? e.message : String(e)}`;
      }
    } finally {
      stopTicker();
      if (recording === current) recording = undefined;
    }
  }

  function stop(): void {
    void recording?.stop();
  }

  async function save(): Promise<void> {
    if (!take || !piece || learner.status !== "ready" || !learner.state) return;
    phase = "saving";
    error = "";
    try {
      const blobs = await getBlobStore();
      if (!blobs) throw new Error("storage is unavailable");
      const newId = createUlidGenerator({
        now: () => wallNow(),
        randomBytes: (n) => crypto.getRandomValues(new Uint8Array(n)),
      });
      await saveBenchmark(
        {
          blobs,
          append: (events) => learner.append(events),
          deleteRemote: remoteDeleter(),
          deviceId: learner.ctx.deviceId,
          newId,
          now: () => wallNow(),
          tzOffsetMin: deviceTzOffsetMin(),
        },
        learner.state,
        piece.id,
        take,
      );
      clearTake();
      // The benchmarks page opens on the newest take's piece: this one.
      await goto(resolve("/progress/benchmarks"));
    } catch (e) {
      phase = "review";
      error = `The take could not be saved: ${e instanceof Error ? e.message : String(e)}`;
    }
  }
</script>

<svelte:head><title>Record a benchmark</title></svelte:head>

<p class="back"><a href={resolve("/progress/benchmarks")}>Benchmarks</a></p>
<h1>Record this month's benchmark</h1>

{#if learner.status === "failed"}
  <p role="alert">Local storage is unavailable, so a benchmark cannot be saved.</p>
{:else if learner.status === "loading"}
  <p>Loading...</p>
{:else if !supported}
  <p role="alert" data-testid="record-unsupported">This browser cannot record audio.</p>
{:else}
  <p>
    Play one piece from start to finish, at your own pace, and keep going through any slips. The
    take is not graded: it is for you to listen back to next to earlier months. A take can be up to
    three minutes long.
  </p>
  {#if existing}
    <p class="muted" data-testid="record-replaces">
      You already recorded a benchmark for {monthLabel(month)}. Saving a new take replaces it.
    </p>
  {/if}

  <fieldset class="pieces" disabled={phase !== "ready" && phase !== "review"}>
    <legend>Piece</legend>
    {#each options as o (o.piece.id)}
      <label class="piece">
        <input
          type="radio"
          name="piece"
          value={o.piece.id}
          bind:group={pieceId}
          data-testid="benchmark-option"
          onchange={clearTake}
        />
        <span>{o.piece.title}</span>
        {#if !o.unlocked}<span class="muted">(not unlocked yet)</span>{/if}
      </label>
    {/each}
  </fieldset>

  {#if piece}
    <section class="score" aria-label="Score">
      <NotationView {port} label={`Score of ${piece.title}`} maxWidth="48rem" />
      {#if scoreFailed}
        <p class="muted">The score could not be drawn.</p>
      {/if}
    </section>

    <div class="controls">
      {#if phase === "ready" || phase === "starting"}
        <button
          type="button"
          class="button"
          data-testid="record-start"
          disabled={phase === "starting"}
          onclick={() => void record()}>Start recording</button
        >
      {:else if phase === "recording"}
        <button type="button" class="button" data-testid="record-stop" onclick={stop}>Stop</button>
        <span class="timer" data-testid="record-timer" role="timer" aria-live="off"
          >{clockLabel(elapsedMs)} / {clockLabel(MAX_BENCHMARK_MS)}</span
        >
      {:else if take && takeUrl}
        <audio controls src={takeUrl} data-testid="record-preview"></audio>
        <div class="row">
          <button
            type="button"
            class="button"
            data-testid="record-save"
            disabled={phase === "saving"}
            onclick={() => void save()}>Save benchmark</button
          >
          <button
            type="button"
            class="button secondary"
            data-testid="record-again"
            disabled={phase === "saving"}
            onclick={() => void record()}>Record again</button
          >
        </div>
      {/if}
    </div>
  {/if}

  {#if error}
    <p class="error" role="alert" data-testid="record-error">{error}</p>
  {/if}
{/if}

<style>
  .back {
    margin-bottom: var(--space-2);
  }

  .muted {
    color: var(--color-text-muted);
  }

  .pieces {
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    padding: var(--space-3) var(--space-4);
    margin: 0 0 var(--space-4);
  }

  .piece {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    min-height: var(--touch-target);
  }

  .score {
    margin-bottom: var(--space-4);
  }

  .controls {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    align-items: flex-start;
  }

  .row {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-3);
  }

  .timer {
    font-variant-numeric: tabular-nums;
    font-size: 1.25rem;
  }

  audio {
    width: 100%;
    max-width: 28rem;
  }

  .error {
    color: var(--color-danger);
  }
</style>
