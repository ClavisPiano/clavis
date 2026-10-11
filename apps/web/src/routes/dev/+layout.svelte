<script lang="ts">
  import type { Snippet } from "svelte";
  import { resolve } from "$app/paths";
  import { page } from "$app/state";

  let { children }: { children: Snippet } = $props();
</script>

<!-- In an installed PWA there is no address bar, so every dev page links back out. -->
<nav class="devnav" aria-label="Developer tools" data-testid="dev-nav">
  {#if page.url.pathname.replace(/\/$/, "") !== "/dev"}
    <a href={resolve("/dev")}>Dev pages</a>
  {/if}
  <a href={resolve("/")} data-testid="dev-back">Back to app</a>
</nav>
{@render children()}

<style>
  .devnav {
    display: flex;
    gap: var(--space-4);
    margin-bottom: var(--space-3);
    font-size: 0.9rem;
  }
</style>
