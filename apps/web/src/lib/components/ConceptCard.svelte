<script lang="ts">
  import {
    cardExampleScore,
    cardExampleStimulus,
    type ConceptCard,
    type Key,
    type StimulusSpec,
  } from "@clavis/core";
  import CardStaff from "./CardStaff.svelte";

  interface Props {
    card: ConceptCard;
    /** Examples sound in this key (or its parallel key for examples in the other mode). */
    keyOfDay: Key;
    onplay: (spec: StimulusSpec) => void;
  }

  let { card, keyOfDay, onplay }: Props = $props();
</script>

<article class="concept" data-testid="concept-card" data-card-id={card.id}>
  <h2>{card.title}</h2>
  {#each card.body as paragraph, i (i)}
    <p>{paragraph}</p>
  {/each}

  <!-- Staff examples show their score (cardExampleScore) next to the play button's label. -->
  {#if card.examples.length > 0}
    <div class="examples" role="group" aria-label="Listen">
      {#each card.examples as example, i (i)}
        <button
          type="button"
          class="example"
          data-testid="card-example"
          aria-label={`Play: ${example.label}`}
          onclick={() => {
            onplay(cardExampleStimulus(example, keyOfDay));
          }}
        >
          <span aria-hidden="true">&#9654;</span>
          {example.label}
          {#if example.kind === "staff"}
            {@const score = cardExampleScore(example, keyOfDay)}
            {#if score}
              <!-- The button's label already describes the example. -->
              <div class="staff" aria-hidden="true">
                <CardStaff {score} label={example.label} />
              </div>
            {/if}
          {/if}
        </button>
      {/each}
    </div>
  {/if}

  <h3>What you'll do</h3>
  <ol class="steps" data-testid="card-howto">
    {#each card.howTo as step, i (i)}
      <li>{step}</li>
    {/each}
  </ol>

  {#if card.links.length > 0}
    <h3>Read more</h3>
    <ul class="links">
      {#each card.links as link (link.url)}
        <li>
          <!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- external https links (card schema), not app routes -->
          <a href={link.url} target="_blank" rel="noopener noreferrer">{link.label}</a>
        </li>
      {/each}
    </ul>
  {/if}
</article>

<style>
  .concept {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
  }

  h2,
  h3,
  p,
  ol,
  ul {
    margin: 0;
  }

  h2 {
    font-size: 1.5rem;
  }

  h3 {
    font-size: 1.05rem;
    margin-top: var(--space-2);
  }

  p,
  li {
    line-height: 1.5;
  }

  .examples {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }

  .example {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    min-height: var(--touch-target);
    padding: var(--space-2) var(--space-4);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    background: var(--color-bg);
    color: var(--color-text);
    font: inherit;
    text-align: left;
    cursor: pointer;
  }

  .staff {
    flex: 0 1 12rem;
    min-width: 6rem;
    margin-left: auto;
  }

  .example span {
    color: var(--color-accent);
  }

  .steps {
    padding-left: var(--space-5);
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }

  .links {
    margin: 0;
    padding-left: var(--space-5);
  }
</style>
