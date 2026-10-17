<script lang="ts">
  import { onMount } from "svelte";
  import { resolve } from "$app/paths";
  import { cardForNode } from "@clavis/content";
  import type { Key } from "@clavis/core";
  import ConceptCardView from "../../../lib/components/ConceptCard.svelte";
  import { useLearner } from "../../../lib/learner.svelte";
  import { percentLabel, secondsLabel, STRAND_LABEL } from "../../../lib/progress";
  import {
    NODE_H,
    NODE_W,
    STATE_GLYPH,
    STATE_LABEL,
    layoutSkillMap,
    nodeProgress,
    type MapNode,
  } from "../../../lib/skill-map";

  const learner = useLearner();
  onMount(() => learner.init());

  // Card examples show their notation in this key. They have no play button here.
  const CARD_KEY: Key = { tonic: "C", mode: "major" };

  let showLater = $state(false);
  let selectedId = $state<string | undefined>(undefined);
  let dialog = $state<HTMLDialogElement | undefined>(undefined);
  let opener: HTMLElement | undefined;

  const ready = $derived(learner.status === "ready" && learner.state !== undefined);
  const graph = $derived(ready ? learner.ctx.graph : undefined);
  const layout = $derived(
    graph && learner.state
      ? layoutSkillMap(graph, learner.state, { showUnimplemented: showLater })
      : undefined,
  );
  const selectedNode = $derived(graph?.nodes.find((n) => n.id === selectedId));
  const selectedMap = $derived(layout?.nodes.find((n) => n.id === selectedId));
  const progress = $derived(
    selectedNode && learner.state ? nodeProgress(selectedNode, learner.state) : undefined,
  );
  const card = $derived(selectedId ? cardForNode(selectedId) : undefined);
  const prereqs = $derived(
    selectedNode && graph && learner.state
      ? selectedNode.prerequisites.map((id) => ({
          id,
          title: graph.nodes.find((n) => n.id === id)?.title ?? id,
          state: learner.state?.nodes[id]?.state ?? "locked",
        }))
      : [],
  );
  const counts = $derived.by(() => {
    const out: Record<string, number> = {};
    for (const n of layout?.nodes ?? []) out[n.state] = (out[n.state] ?? 0) + 1;
    return out;
  });

  function open(node: MapNode, event: Event): void {
    opener = event.currentTarget instanceof HTMLElement ? event.currentTarget : undefined;
    selectedId = node.id;
    dialog?.showModal();
  }

  function onclose(): void {
    selectedId = undefined;
    opener?.focus();
  }

  function nodeLabel(n: MapNode): string {
    return `${n.title}, ${STRAND_LABEL[n.strand] ?? n.strand}, ${STATE_LABEL[n.state]}`;
  }
</script>

<svelte:head><title>Skill map</title></svelte:head>

<p class="back"><a href={resolve("/progress")}>Back to progress</a></p>
<h1>Skill map</h1>

{#if learner.status === "failed"}
  <p role="alert">Local storage is unavailable, so there is no skill map to show.</p>
{:else if !layout}
  <p>Loading...</p>
{:else}
  <p class="muted">
    Skills read top to bottom: a skill unlocks once the ones above it that it is linked to are
    mastered. Tap a skill for details.
  </p>

  <ul class="legend" aria-label="Legend" data-testid="map-legend">
    {#each ["locked", "available", "learning", "fluent", "mastered"] as const as s (s)}
      <li class="chip state-{s}">
        <span aria-hidden="true">{STATE_GLYPH[s]}</span>
        {STATE_LABEL[s]}
      </li>
    {/each}
  </ul>

  <label class="toggle">
    <input type="checkbox" bind:checked={showLater} data-testid="show-later" />
    Show skills that are coming later
  </label>

  <!-- A scrollable region must be reachable by keyboard. -->
  <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
  <div class="scroller" tabindex="0" role="region" aria-label="Skill map, scrolls sideways">
    <div
      class="canvas"
      data-testid="skill-map"
      style:width="{layout.width}px"
      style:height="{layout.height}px"
    >
      <svg
        class="edges"
        width={layout.width}
        height={layout.height}
        viewBox="0 0 {layout.width} {layout.height}"
        aria-hidden="true"
      >
        {#each layout.edges as e (`${e.from}>${e.to}`)}
          <path
            d={e.d}
            class:soft={e.soft}
            class:cross={e.cross}
            data-testid="map-edge"
            data-from={e.from}
            data-to={e.to}
            data-cross={e.cross}
          />
        {/each}
      </svg>

      {#each layout.columns as col (col.strand)}
        <h2 class="strand" style:left="{col.x}px" style:width="{NODE_W}px">
          {STRAND_LABEL[col.strand] ?? col.strand}
        </h2>
      {/each}

      {#each layout.nodes as n (n.id)}
        <button
          type="button"
          class="node state-{n.state}"
          style:left="{n.x}px"
          style:top="{n.y}px"
          style:width="{NODE_W}px"
          style:height="{NODE_H}px"
          data-testid="map-node"
          data-node-id={n.id}
          data-state={n.state}
          aria-label={nodeLabel(n)}
          onclick={(e) => {
            open(n, e);
          }}
        >
          <span class="title">{n.title}</span>
          <span class="status"
            ><span aria-hidden="true">{STATE_GLYPH[n.state]}</span> {STATE_LABEL[n.state]}</span
          >
        </button>
      {/each}
    </div>
  </div>

  <p class="muted summary" data-testid="map-summary">
    {counts.mastered ?? 0} mastered, {(counts.fluent ?? 0) + (counts.learning ?? 0)} in progress,
    {counts.available ?? 0} ready to start.
  </p>
{/if}

<dialog bind:this={dialog} class="details" data-testid="node-details" {onclose}>
  {#if selectedNode && selectedMap}
    <div class="head">
      <div>
        <p class="eyebrow">{STRAND_LABEL[selectedNode.strand] ?? selectedNode.strand}</p>
        <h2 data-testid="node-title">{selectedNode.title}</h2>
      </div>
      <button type="button" class="close" data-testid="node-close" onclick={() => dialog?.close()}>
        Close
      </button>
    </div>

    <p class="chip state-{selectedMap.state}" data-testid="node-state">
      <span aria-hidden="true">{STATE_GLYPH[selectedMap.state]}</span>
      {STATE_LABEL[selectedMap.state]}
    </p>

    {#if selectedNode.description}
      <p data-testid="node-description">{selectedNode.description}</p>
    {/if}

    {#if selectedMap.state === "later"}
      <p class="muted">This skill is not available yet. It will open up in a later update.</p>
    {/if}

    {#if prereqs.length > 0}
      <h3>Needs first</h3>
      <ul class="prereqs" data-testid="node-prereqs">
        {#each prereqs as p (p.id)}
          <li>
            <span aria-hidden="true">{STATE_GLYPH[p.state]}</span>
            {p.title}: {STATE_LABEL[p.state]}
          </li>
        {/each}
      </ul>
    {/if}

    <h3>To master it</h3>
    <dl class="criteria" data-testid="node-criteria">
      <dt>Accuracy</dt>
      <dd data-testid="crit-accuracy">
        at least {percentLabel(selectedNode.mastery.minAccuracy)} over the last {selectedNode
          .mastery.windowAttempts} answers
        {#if progress?.accuracy !== undefined}
          <span class="now">(now {percentLabel(progress.accuracy)})</span>
        {/if}
      </dd>
      {#if selectedNode.mastery.maxMedianLatencyMs !== undefined}
        <dt>Speed</dt>
        <dd data-testid="crit-latency">
          median under {secondsLabel(selectedNode.mastery.maxMedianLatencyMs)}
          {#if progress?.medianLatencyMs !== undefined}
            <span class="now">(now {secondsLabel(progress.medianLatencyMs)})</span>
          {/if}
        </dd>
      {/if}
      <dt>Sessions</dt>
      <dd data-testid="crit-sessions">
        spread over at least {selectedNode.mastery.distinctSessions} sessions on different days
        {#if progress && progress.windowAttempts > 0}
          <span class="now">(now {progress.sessions} sessions)</span>
        {/if}
      </dd>
      <dt>Answers</dt>
      <dd data-testid="crit-answers">
        {progress?.windowAttempts ?? 0} of {selectedNode.mastery.windowAttempts} counted so far (answers
        in Away mode do not count toward mastery)
      </dd>
    </dl>

    {#if card}
      <section class="card-wrap" data-testid="node-card" aria-label="About this skill">
        <ConceptCardView {card} keyOfDay={CARD_KEY} />
      </section>
    {:else}
      <p class="muted" data-testid="node-no-card">There is no explainer card for this skill yet.</p>
    {/if}
  {/if}
</dialog>

<style>
  .back {
    margin: 0 0 var(--space-2);
  }

  .muted {
    color: var(--color-text-muted);
  }

  .legend {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2);
    list-style: none;
    padding: 0;
    margin: 0 0 var(--space-3);
  }

  .chip {
    display: inline-block;
    margin: 0;
    padding: 2px var(--space-2);
    border: 2px solid var(--state-border, var(--color-border));
    border-radius: var(--radius-md);
    background: var(--state-bg, var(--color-surface));
    color: var(--color-text);
    font-size: 0.85rem;
  }

  .toggle {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    margin-bottom: var(--space-3);
  }

  .scroller {
    overflow: auto;
    max-width: 100%;
    max-height: 70vh;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    background: var(--color-surface);
  }

  .canvas {
    position: relative;
  }

  .edges {
    position: absolute;
    inset: 0;
    pointer-events: none;
  }

  .edges path {
    fill: none;
    stroke: var(--color-text-muted);
    stroke-width: 1.5;
    opacity: 0.6;
  }

  .edges path.soft {
    stroke-dasharray: 4 4;
  }

  .edges path.cross {
    stroke: var(--color-accent);
    opacity: 0.8;
  }

  .strand {
    position: absolute;
    top: 12px;
    margin: 0;
    font-size: 0.75rem;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: var(--color-text-muted);
    text-align: center;
    pointer-events: none;
  }

  .node {
    position: absolute;
    display: flex;
    flex-direction: column;
    justify-content: center;
    gap: 2px;
    padding: var(--space-1) var(--space-2);
    border: 2px solid var(--state-border);
    border-radius: var(--radius-md);
    background: var(--state-bg);
    color: var(--color-text);
    font: inherit;
    text-align: left;
    cursor: pointer;
    overflow: hidden;
  }

  .node .title {
    font-size: 0.85rem;
    font-weight: 600;
    line-height: 1.2;
    display: -webkit-box;
    line-clamp: 2;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }

  .node .status {
    font-size: 0.75rem;
    color: var(--color-text-muted);
  }

  .node.state-later {
    opacity: 0.55;
    border-style: dashed;
  }

  .node.state-locked {
    border-style: dotted;
  }

  .state-locked {
    --state-border: var(--color-text-muted);
    --state-bg: var(--color-surface);
  }

  .state-available {
    --state-border: var(--color-accent);
    --state-bg: var(--color-surface);
  }

  .state-learning {
    --state-border: var(--color-accent);
    --state-bg: color-mix(in srgb, var(--color-accent) 18%, var(--color-surface));
  }

  .state-fluent {
    --state-border: var(--color-success);
    --state-bg: color-mix(in srgb, var(--color-success) 14%, var(--color-surface));
  }

  .state-mastered {
    --state-border: var(--color-success);
    --state-bg: color-mix(in srgb, var(--color-success) 32%, var(--color-surface));
  }

  .state-later {
    --state-border: var(--color-border);
    --state-bg: var(--color-surface);
  }

  .summary {
    margin-top: var(--space-3);
  }

  .details {
    width: min(36rem, calc(100vw - 2 * var(--space-4)));
    max-height: calc(100dvh - 2 * var(--space-4));
    padding: var(--space-4);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    background: var(--color-surface);
    color: var(--color-text);
    overflow: auto;
  }

  .details::backdrop {
    background: rgb(0 0 0 / 0.5);
  }

  .head {
    display: flex;
    justify-content: space-between;
    gap: var(--space-3);
    align-items: flex-start;
  }

  .head h2 {
    margin: 0;
    font-size: 1.25rem;
  }

  .eyebrow {
    margin: 0;
    font-size: 0.75rem;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: var(--color-text-muted);
  }

  .close {
    min-height: var(--touch-target);
    padding: 0 var(--space-4);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    background: var(--color-bg);
    color: var(--color-text);
    font: inherit;
    cursor: pointer;
  }

  .details h3 {
    font-size: 1rem;
    margin: var(--space-3) 0 var(--space-1);
  }

  .prereqs {
    margin: 0;
    padding-left: var(--space-4);
  }

  .criteria {
    display: grid;
    grid-template-columns: max-content 1fr;
    gap: var(--space-1) var(--space-3);
    margin: 0;
  }

  .criteria dt {
    font-weight: 600;
  }

  .criteria dd {
    margin: 0;
  }

  .now {
    color: var(--color-text-muted);
    white-space: nowrap;
  }

  .card-wrap {
    margin-top: var(--space-4);
    padding-top: var(--space-3);
    border-top: 1px solid var(--color-border);
  }
</style>
