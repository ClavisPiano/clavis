<script lang="ts">
  import { resolve } from "$app/paths";
  import { onMount } from "svelte";
  import { readInstallEnv, shouldShowIosInstallHint } from "../lib/pwa/ios";

  const HINT_DISMISSED_KEY = "clavis.install-hint-dismissed";
  let showHint = $state(false);

  onMount(() => {
    let dismissed = false;
    try {
      dismissed = localStorage.getItem(HINT_DISMISSED_KEY) !== null;
    } catch {
      // Storage unavailable: show the hint every time.
    }
    showHint = !dismissed && shouldShowIosInstallHint(readInstallEnv());
  });

  function dismiss() {
    showHint = false;
    try {
      localStorage.setItem(HINT_DISMISSED_KEY, "1");
    } catch {
      // Best effort.
    }
  }
</script>

{#if showHint}
  <aside class="hint" aria-label="Install hint">
    <p>
      Add Clavis to your Home Screen for reliable offline use.
      <a href={resolve("/install")}>How to install</a>
    </p>
    <button type="button" onclick={dismiss}>Dismiss</button>
  </aside>
{/if}

<h1>Clavis</h1>
<p>Piano and ear training, a few focused minutes a day.</p>
<div class="actions">
  <a class="button" href={resolve("/session")}>Start session</a>
  <a class="button secondary" href={resolve("/session?mode=away")}>Away session</a>
</div>

<style>
  .hint {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    padding: var(--space-3) var(--space-4);
    margin-bottom: var(--space-5);
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
  }

  .hint p {
    flex: 1;
    margin: 0;
  }

  .hint button {
    min-height: var(--touch-target);
    padding: 0 var(--space-4);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    background: transparent;
    color: var(--color-text);
    font: inherit;
  }

  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-3);
  }
</style>
