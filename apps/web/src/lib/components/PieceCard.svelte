<script lang="ts">
  import { resolve } from "$app/paths";
  import type { PieceCardData, PieceRow } from "../piece-card";

  interface Props {
    card: PieceCardData;
  }

  let { card }: Props = $props();

  const dots = (n: number): number[] => Array.from({ length: n }, (_, i) => i);

  const hand = (r: PieceRow): string => (r.hand === "right" ? "Right hand" : "Left hand");

  function status(r: PieceRow): string {
    switch (r.status) {
      case "completed":
        return "Played through";
      case "ready":
        return "Ready to play through";
      case "playing":
        return `Learning: ${String(r.learned)} of ${String(r.phraseCount)} phrases`;
      case "next":
        return "Up next";
      case "locked":
        return `Locked: needs ${r.missing.join(", ")}`;
    }
  }
</script>

<section class="pieces" aria-labelledby="pieces-h" data-testid="piece-card">
  <h2 id="pieces-h">Pieces</h2>

  {#if card.current}
    {@const c = card.current}
    <div class="current" data-testid="current-piece" data-status={c.status}>
      <p class="title">
        <strong data-testid="current-title">{c.title}</strong>
        <span class="muted">{hand(c)}</span>
      </p>
      <p
        class="progress"
        data-testid="phrase-progress"
        role="img"
        aria-label={`${String(c.learned)} of ${String(c.phraseCount)} phrases learned`}
      >
        {#each dots(c.phraseCount) as i (i)}
          <span class="dot" class:done={i < c.learned} aria-hidden="true"></span>
        {/each}
      </p>
      {#if c.status === "ready"}
        <p>You have played every phrase. Now play it from start to finish.</p>
        <a class="button primary" href={resolve(`/session?run=${c.id}`)} data-testid="play-through">
          <strong>Play it through</strong>
        </a>
      {:else}
        <p class="muted" data-testid="piece-hint">
          {String(c.learned)} of {String(c.phraseCount)} phrases learned. Your next sessions bring the
          next phrases.
        </p>
      {/if}
    </div>
  {:else if card.completed.length > 0}
    <p data-testid="all-done">You have played through every piece that is unlocked so far.</p>
  {:else}
    <p class="muted" data-testid="first-piece-locked">
      Your first tune unlocks once you read the treble staff quickly.
    </p>
  {/if}

  {#if card.completed.length > 0}
    <p class="milestones" data-testid="milestones">
      Played through:
      {#each card.completed as r, i (r.id)}
        <span data-testid="milestone">{r.title}{i < card.completed.length - 1 ? ", " : ""}</span>
      {/each}
    </p>
  {/if}

  <details>
    <summary>All pieces</summary>
    <ol class="list" data-testid="piece-list">
      {#each card.rows as r (r.id)}
        <li data-testid="piece-row" data-piece={r.id} data-status={r.status}>
          <span class="name">{r.title} <span class="muted">({hand(r)})</span></span>
          <span class="state muted">{status(r)}</span>
        </li>
      {/each}
    </ol>
  </details>
</section>

<style>
  .pieces {
    padding: var(--space-4);
    margin-bottom: var(--space-4);
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
  }

  h2 {
    font-size: 1.125rem;
  }

  .title {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2);
    align-items: baseline;
    margin: 0 0 var(--space-2);
  }

  .muted {
    color: var(--color-text-muted);
  }

  .progress {
    display: flex;
    gap: var(--space-1);
    margin: 0 0 var(--space-3);
  }

  .dot {
    width: 1rem;
    height: 0.5rem;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-sm);
  }

  .dot.done {
    background: var(--color-accent);
    border-color: var(--color-accent);
  }

  .milestones {
    margin: var(--space-3) 0 0;
  }

  details {
    margin-top: var(--space-3);
  }

  summary {
    min-height: var(--touch-target);
    display: flex;
    align-items: center;
    cursor: pointer;
  }

  .list {
    list-style: none;
    padding: 0;
    margin: 0;
  }

  .list li {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
    padding: var(--space-2) 0;
    border-top: 1px solid var(--color-border);
  }

  .state {
    font-size: 0.875rem;
  }
</style>
