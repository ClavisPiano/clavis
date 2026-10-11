<script lang="ts">
  import type { Snippet } from "svelte";
  import "../app.css";
  import { resolve } from "$app/paths";
  import { page } from "$app/state";
  import { NAV_ITEMS, isActive } from "../lib/nav";

  let { children }: { children: Snippet } = $props();
</script>

<div class="shell">
  <main>
    {@render children()}
  </main>
  <nav aria-label="Primary">
    {#each NAV_ITEMS as item (item.href)}
      <a
        href={resolve(item.href)}
        aria-current={isActive(item, page.url.pathname) ? "page" : undefined}
      >
        {item.label}
      </a>
    {/each}
  </nav>
</div>

<style>
  .shell {
    display: flex;
    flex-direction: column;
    min-height: 100dvh;
    padding-top: env(safe-area-inset-top);
    padding-left: env(safe-area-inset-left);
    padding-right: env(safe-area-inset-right);
  }

  main {
    flex: 1;
    min-width: 0;
    padding: var(--space-5) var(--space-4);
    max-width: 40rem;
    width: 100%;
    margin: 0 auto;
    overflow-wrap: anywhere;
  }

  nav {
    position: sticky;
    bottom: 0;
    display: flex;
    background: var(--color-surface);
    border-top: 1px solid var(--color-border);
    padding-bottom: env(safe-area-inset-bottom);
  }

  nav a {
    flex: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    min-height: calc(var(--touch-target) + var(--space-3));
    color: var(--color-text-muted);
    text-decoration: none;
    font-weight: 500;
  }

  nav a[aria-current="page"] {
    color: var(--color-accent);
    font-weight: 700;
  }
</style>
