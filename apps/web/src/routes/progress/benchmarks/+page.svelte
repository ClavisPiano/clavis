<script lang="ts">
  import { wallNow } from "../../../lib/clock";
  import { onMount, untrack } from "svelte";
  import { resolve } from "$app/paths";
  import {
    benchmarkMonth,
    benchmarksByPiece,
    defaultComparison,
    needsBenchmark,
    type BenchmarkRecord,
  } from "@clavis/core";
  import NotationView from "../../../lib/components/NotationView.svelte";
  import { benchmarkAudio, sweepOrphanBenchmarks } from "../../../lib/benchmark/app";
  import { clockLabel, monthLabel } from "../../../lib/benchmark/view";
  import { deviceTzOffsetMin } from "../../../lib/home";
  import { useLearner } from "../../../lib/learner.svelte";
  import { getNotationClient } from "../../../lib/notation/shared";
  import { createNotationViewPort } from "../../../lib/notation/view-port";
  import { appPieces } from "../../../lib/pieces";

  /*
   * Monthly benchmarks side by side (T6.5, R28): grouped by piece, newest first. A piece shows its
   * score once and two players, the newest take and an earlier month (the oldest by default).
   */

  const learner = useLearner();
  const port = createNotationViewPort(getNotationClient());
  const library = appPieces();
  let now = $state(wallNow());
  let chosenPiece = $state<string | undefined>();
  let chosenEarlier = $state<string | undefined>();

  type Audio = { status: "loading" } | { status: "ready"; url: string } | { status: "missing" };
  let latestAudio = $state<Audio>({ status: "loading" });
  let earlierAudio = $state<Audio>({ status: "loading" });
  let latestEl = $state<HTMLAudioElement | undefined>();
  let earlierEl = $state<HTMLAudioElement | undefined>();
  /** Which player the "one after the other" run is on. */
  let sequence = $state<"latest" | "earlier" | undefined>();

  onMount(() => {
    void learner.init().then(() => {
      now = wallNow();
      if (learner.state) void sweepOrphanBenchmarks(learner.state, now);
    });
    return () => {
      port.hide();
    };
  });

  const groups = $derived(learner.state ? benchmarksByPiece(learner.state) : []);
  const group = $derived(groups.find((g) => g.pieceId === chosenPiece) ?? groups[0]);
  const piece = $derived(library.find((p) => p.id === group?.pieceId));
  const comparison = $derived(defaultComparison(group?.benchmarks ?? []));
  const latest = $derived(comparison.latest);
  const earlierChoices = $derived(group?.benchmarks.slice(1) ?? []);
  const earlier = $derived(
    earlierChoices.find((b) => b.month === chosenEarlier) ?? comparison.earlier,
  );
  const month = $derived(benchmarkMonth(now, deviceTzOffsetMin()));
  const due = $derived(learner.state ? needsBenchmark(learner.state, month) : false);

  const titleOf = (pieceId: string): string =>
    library.find((p) => p.id === pieceId)?.title ?? pieceId;
  const takeLabel = (b: BenchmarkRecord): string =>
    b.month === month ? `${monthLabel(b.month)} (this month)` : monthLabel(b.month);

  $effect(() => {
    if (!piece) {
      port.hide();
      return;
    }
    port.show(piece.score).catch(() => undefined);
  });

  /** Load `b`'s audio into `set`; revoke the object URL when `b` changes or the page goes. */
  function track(b: BenchmarkRecord | undefined, set: (a: Audio) => void): () => void {
    let url: string | undefined;
    let live = true;
    set({ status: "loading" });
    if (b) {
      benchmarkAudio(b)
        .then((blob) => {
          if (!live) return;
          if (!blob) {
            set({ status: "missing" });
            return;
          }
          url = URL.createObjectURL(blob);
          set({ status: "ready", url });
        })
        .catch((error: unknown) => {
          console.warn("Could not load a benchmark recording", error);
          if (live) set({ status: "missing" });
        });
    }
    return () => {
      live = false;
      if (url) URL.revokeObjectURL(url);
    };
  }

  // Keyed by blob, so a refold that rebuilds equal records does not reload the audio.
  const latestKey = $derived(latest?.blobKey);
  const earlierKey = $derived(earlier?.blobKey);
  $effect(() => {
    const key = latestKey;
    return track(key === undefined ? undefined : untrack(() => latest), (a) => {
      latestAudio = a;
    });
  });
  $effect(() => {
    const key = earlierKey;
    return track(key === undefined ? undefined : untrack(() => earlier), (a) => {
      earlierAudio = a;
    });
  });

  function choosePiece(id: string): void {
    chosenPiece = id;
    chosenEarlier = undefined;
    sequence = undefined;
  }

  function playBoth(): void {
    const first = latestEl;
    const second = earlierEl;
    if (!first || !second) return;
    second.pause();
    first.currentTime = 0;
    sequence = "latest";
    first.addEventListener(
      "ended",
      () => {
        if (sequence !== "latest") return;
        second.currentTime = 0;
        sequence = "earlier";
        void second.play().catch(() => (sequence = undefined));
        second.addEventListener("ended", () => (sequence = undefined), { once: true });
      },
      { once: true },
    );
    void first.play().catch(() => (sequence = undefined));
  }
</script>

<svelte:head><title>Benchmarks</title></svelte:head>

<p class="back"><a href={resolve("/progress")}>Progress</a></p>
<h1>Benchmarks</h1>

{#if learner.status === "failed"}
  <p role="alert">Local storage is unavailable, so there are no benchmarks to show.</p>
{:else if learner.status === "loading"}
  <p>Loading...</p>
{:else}
  {#if due}
    <p>
      <a
        class="button"
        href={resolve("/progress/benchmarks/record")}
        data-testid="benchmark-record-link">Record this month's benchmark</a
      >
    </p>
  {/if}

  {#if groups.length === 0}
    <p class="muted" data-testid="benchmarks-empty">
      No benchmarks yet. Once a month, record yourself playing a piece; here you can play the takes
      next to each other and hear the change.
    </p>
  {:else}
    <ul class="groups" data-testid="benchmark-pieces">
      {#each groups as g (g.pieceId)}
        <li>
          <button
            type="button"
            class="group"
            class:selected={g.pieceId === group?.pieceId}
            aria-pressed={g.pieceId === group?.pieceId}
            data-testid="benchmark-piece"
            data-piece={g.pieceId}
            onclick={() => {
              choosePiece(g.pieceId);
            }}
          >
            <strong>{titleOf(g.pieceId)}</strong>
            <span class="muted" data-testid="benchmark-months"
              >{g.benchmarks.map((b) => monthLabel(b.month)).join(", ")}</span
            >
          </button>
        </li>
      {/each}
    </ul>

    {#if group && latest}
      <section class="card" aria-labelledby="piece-h" data-testid="benchmark-compare">
        <h2 id="piece-h">{titleOf(group.pieceId)}</h2>
        {#if piece}
          <NotationView {port} label={`Score of ${piece.title}`} maxWidth="48rem" />
        {/if}

        <div class="players">
          <figure data-testid="player-latest" data-month={latest.month}>
            <figcaption>
              <strong>{takeLabel(latest)}</strong>
              <span class="muted">{clockLabel(latest.durationMs)}</span>
            </figcaption>
            {#if latestAudio.status === "ready"}
              <audio controls preload="auto" src={latestAudio.url} bind:this={latestEl}></audio>
            {:else if latestAudio.status === "missing"}
              <p class="muted" data-testid="audio-missing">
                The recording is not on this device. Sign in to fetch it.
              </p>
            {:else}
              <p class="muted">Loading...</p>
            {/if}
          </figure>

          <figure data-testid="player-earlier" data-month={earlier?.month ?? ""}>
            {#if earlier}
              <figcaption>
                <label>
                  <span class="sr-only">Earlier month</span>
                  <select
                    data-testid="earlier-month"
                    value={earlier.month}
                    onchange={(e) => {
                      chosenEarlier = e.currentTarget.value;
                      sequence = undefined;
                    }}
                  >
                    {#each earlierChoices as b (b.month)}
                      <option value={b.month}>{monthLabel(b.month)}</option>
                    {/each}
                  </select>
                </label>
                <span class="muted">{clockLabel(earlier.durationMs)}</span>
              </figcaption>
              {#if earlierAudio.status === "ready"}
                <audio controls preload="auto" src={earlierAudio.url} bind:this={earlierEl}></audio>
              {:else if earlierAudio.status === "missing"}
                <p class="muted" data-testid="audio-missing">
                  The recording is not on this device. Sign in to fetch it.
                </p>
              {:else}
                <p class="muted">Loading...</p>
              {/if}
            {:else}
              <p class="muted" data-testid="no-earlier">
                Next month's take will appear here, next to this one.
              </p>
            {/if}
          </figure>
        </div>

        {#if earlier}
          <p>
            <button
              type="button"
              class="button secondary"
              data-testid="play-both"
              data-sequence={sequence ?? ""}
              disabled={latestAudio.status !== "ready" || earlierAudio.status !== "ready"}
              onclick={playBoth}>Play one after the other</button
            >
          </p>
        {/if}
      </section>
    {/if}
  {/if}
{/if}

<style>
  .back {
    margin-bottom: var(--space-2);
  }

  .muted {
    color: var(--color-text-muted);
  }

  .groups {
    list-style: none;
    padding: 0;
    margin: 0 0 var(--space-4);
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }

  .group {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    width: 100%;
    min-height: var(--touch-target);
    padding: var(--space-2) var(--space-3);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-sm);
    background: var(--color-surface);
    color: var(--color-text);
    font: inherit;
    text-align: left;
    cursor: pointer;
  }

  .group.selected {
    border-color: var(--color-accent);
    background: color-mix(in srgb, var(--color-accent) 12%, var(--color-surface));
  }

  .card {
    padding: var(--space-4);
    margin-bottom: var(--space-4);
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
  }

  .card h2 {
    font-size: 1.125rem;
  }

  .players {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(14rem, 1fr));
    gap: var(--space-4);
    margin: var(--space-4) 0;
  }

  figure {
    margin: 0;
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    min-width: 0;
  }

  figcaption {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-2);
  }

  select {
    font: inherit;
    min-height: var(--touch-target);
  }

  audio {
    width: 100%;
  }

  .sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip: rect(0 0 0 0);
    white-space: nowrap;
  }
</style>
