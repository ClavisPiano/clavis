<script lang="ts">
  import type { NotationViewPort } from "../notation/view-port";
  import type { NotationMark } from "../notation/port";

  interface Props {
    /** Where the SVG and highlights come from. */
    port: NotationViewPort;
    /** Accessible description of the score, for example "Bass staff with one note". */
    label: string;
    /** The score scales to its container up to this width. */
    maxWidth?: string;
  }

  let { port, label, maxWidth = "36rem" }: Props = $props();

  let svg = $state("");
  let marks = $state.raw<readonly NotationMark[]>([]);
  let host = $state<HTMLElement | undefined>();

  $effect(() =>
    port.subscribe((s) => {
      svg = s.svg;
      marks = s.marks;
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
    data-testid="notation"
    style:max-width={maxWidth}
    bind:this={host}
  >
    <!-- eslint-disable-next-line svelte/no-at-html-tags -- trusted: SVG from our own renderer, built from our own ScoreSpec -->
    {@html svg}
  </div>
{/if}

<style>
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
