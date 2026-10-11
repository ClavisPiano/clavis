<script lang="ts">
  import { updateState } from "./update-state.svelte";
</script>

{#if updateState.available}
  <div class="banner" role="status">
    <span>Update available</span>
    <button
      type="button"
      class="button"
      disabled={!updateState.canUpdateNow}
      onclick={() => {
        updateState.reload();
      }}
    >
      Reload
    </button>
  </div>
{/if}

<style>
  .banner {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-3);
    padding: var(--space-2) var(--space-4);
    background: var(--color-surface);
    border-bottom: 1px solid var(--color-border);
  }

  button:disabled {
    opacity: 0.5;
  }
</style>
