<script lang="ts">
  import type { NotationViewPort } from "../notation/view-port";
  import type { NotationMark } from "../notation/port";
  import { describeScore } from "../notation/describe";
  import type { ScoreSpec } from "@clavis/core";

  interface Props {
    /** Where the SVG and highlights come from. */
    port: NotationViewPort;
    /** Accessible description of the score, for example "Bass staff with one note". */
    label: string;
    /** The score scales to its container up to this width. */
    maxWidth?: string;
    /**
     * List every note in the screen reader description. Leave off for a reading item, where the
     * notes are the question; turn on for worked examples and previews.
     */
    revealPitches?: boolean;
  }

  let { port, label, maxWidth = "36rem", revealPitches = false }: Props = $props();

  // Unique per instance, so two scores on one page each point at their own description.
  const uid = $props.id();
  const descriptionId = `notation-desc-${uid}`;
  let score = $state.raw<ScoreSpec | undefined>();
  const description = $derived(score ? describeScore(score, { pitches: revealPitches }) : "");

  let svg = $state("");
  let marks = $state.raw<readonly NotationMark[]>([]);
  let host = $state<HTMLElement | undefined>();

  $effect(() =>
    port.subscribe((s) => {
      svg = s.svg;
      marks = s.marks;
      score = s.score;
    }),
  );

  // Highlights are CSS classes on the SVG groups, so they follow the note ids in the markup. This
  // runs after the DOM update, so it also re-applies when the score itself is replaced.
  $effect(() => {
    const root = host;
    if (!root || !svg) return;
    for (const el of root.querySelectorAll(".target, .wrong, .right")) {
      el.classList.remove("target", "wrong", "right");
    }
    for (const mark of marks) {
      root.querySelector(`[id="${mark.noteId.replace(/"/g, '\\"')}"]`)?.classList.add(mark.kind);
    }
  });
</script>

{#if svg}
  <div
    class="notation"
    role="img"
    aria-label={label}
    aria-describedby={description ? descriptionId : undefined}
    data-testid="notation"
    style:max-width={maxWidth}
    bind:this={host}
  >
    <!-- eslint-disable-next-line svelte/no-at-html-tags -- trusted: SVG from our own renderer, built from our own ScoreSpec -->
    {@html svg}
  </div>
  {#if description}
    <p id={descriptionId} class="sr-only" data-testid="notation-description">{description}</p>
  {/if}
{/if}

<style>
  /* Read by screen readers, not shown. */
  .sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    margin: -1px;
    padding: 0;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
    border: 0;
  }
  .notation {
    width: 100%;
    margin-inline: auto;
    color: var(--color-text);
  }
  /* Scale the SVG to the container width. */
  .notation :global(svg) {
    display: block;
    width: 100%;
    height: auto;
    overflow: visible;
  }
  /* Verovio sets color="black" on its inner svg and leaves glyph fills unset (black). Take both from
     the theme; strokes already use currentColor. */
  .notation :global(svg .definition-scale) {
    color: inherit;
    fill: currentColor;
  }
  .notation :global(.target) {
    color: var(--color-accent);
  }
  .notation :global(.wrong) {
    color: var(--color-danger);
  }
  .notation :global(.right) {
    color: var(--color-success);
  }
</style>
