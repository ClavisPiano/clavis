<script lang="ts">
  import { wallNow } from "../../lib/clock";
  import { onMount } from "svelte";
  import { resolve } from "$app/paths";
  import { keyOfDay, type Key } from "@clavis/core";
  import Keyboard from "../../lib/components/Keyboard.svelte";
  import { deviceTzOffsetMin } from "../../lib/home";
  import { createPiano } from "../../lib/piano";
  import {
    PRACTICE_KEYS,
    guideMarks,
    homeChordSpec,
    homeNoteSpec,
    homeNotes,
    keyLabel,
    keySpec,
  } from "../../lib/keyboard-practice";
  import { useLearner } from "../../lib/learner.svelte";

  /*
   * A keyboard to play any time: nothing is graded or stored. It knows the key of the day, marks
   * its home note and chord, and can play the scale and cadence that open a session.
   */

  const learner = useLearner();
  const piano = createPiano();
  const FIRST: Key = { tonic: "C", mode: "major" };
  let key = $state<Key>(FIRST);
  let heardKey = $state(false);

  onMount(() => {
    void learner.init().then(() => {
      if (learner.status !== "ready" || !learner.state || heardKey) return;
      try {
        key = keyOfDay(learner.state, learner.ctx.graph, wallNow(), deviceTzOffsetMin());
      } catch {
        // Keep C major.
      }
    });
    return () => {
      piano.stop();
    };
  });

  const index = $derived(
    PRACTICE_KEYS.findIndex((k) => k.tonic === key.tonic && k.mode === key.mode),
  );
  const marks = $derived(guideMarks(key));
  const home = $derived(homeNotes(key));

  function choose(i: number): void {
    const next = PRACTICE_KEYS[i];
    if (!next) return;
    key = { tonic: next.tonic, mode: next.mode };
    heardKey = true;
  }

  function hear(spec: ReturnType<typeof keySpec>): void {
    void piano.unlock().then(() => {
      piano.play(spec);
    });
  }
</script>

<svelte:head><title>Keyboard</title></svelte:head>

<h1>Keyboard</h1>
<p class="lead">
  Play any time. Nothing here is marked or saved. Gold is the home note, the pale keys are the rest
  of the home chord.
</p>

<label class="key">
  Key
  <select
    data-testid="keyboard-key"
    value={String(index)}
    onchange={(e) => {
      choose(Number(e.currentTarget.value));
    }}
  >
    {#each PRACTICE_KEYS as k, i (i)}
      <option value={String(i)}>{keyLabel(k)}</option>
    {/each}
  </select>
</label>

<div class="row">
  <button
    type="button"
    class="primary"
    data-testid="hear-key"
    onclick={() => {
      hear(keySpec(key));
    }}>Hear the key</button
  >
  <button
    type="button"
    class="secondary"
    data-testid="hear-home-chord"
    onclick={() => {
      hear(homeChordSpec(key));
    }}>Home chord</button
  >
  <button
    type="button"
    class="secondary"
    data-testid="hear-home-note"
    onclick={() => {
      hear(homeNoteSpec(key));
    }}>Home note</button
  >
</div>

<div class="board" data-testid="keyboard-board">
  <Keyboard
    low={48}
    high={84}
    focusMidi={home.tonic}
    labels="all"
    {marks}
    playSound={(midi: number) => {
      void piano.unlock().then(() => {
        piano.tone(midi);
      });
    }}
  />
</div>

<p><a href={resolve("/")}>Back to home</a></p>

<style>
  .lead {
    line-height: 1.5;
  }

  .key {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    max-width: 16rem;
  }

  .row {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-3);
    margin: var(--space-4) 0;
  }

  .row button {
    flex: 1 1 8rem;
    min-height: 52px;
    padding: 0 var(--space-5);
    border-radius: var(--radius-md);
    font: inherit;
    font-weight: 600;
    cursor: pointer;
  }

  .row .primary {
    border: 1px solid var(--color-accent);
    background: var(--color-accent);
    color: var(--color-accent-contrast);
  }

  .row .secondary {
    border: 1px solid var(--color-accent);
    background: transparent;
    color: var(--color-accent);
  }

  .board {
    margin-bottom: var(--space-4);
  }
</style>
