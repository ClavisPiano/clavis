<script lang="ts">
  import type { Snippet } from "svelte";
  import "../app.css";
  import { resolve } from "$app/paths";
  import { page } from "$app/state";
  import { onMount } from "svelte";
  import { NAV_ITEMS, isActive } from "../lib/nav";
  import UpdateBanner from "../lib/pwa/UpdateBanner.svelte";
  import { requestPersistentStorage } from "../lib/pwa/persist";
  import { watchServiceWorker } from "../lib/pwa/update-state.svelte";
  import { initAppStore } from "../lib/app-store";
  import { getSyncController } from "../lib/sync/app";

  let { children }: { children: Snippet } = $props();
  let storageFailed = $state(false);

  onMount(() => {
    void initAppStore().then((result) => {
      storageFailed = !result.ok;
    });
    void watchServiceWorker();
    let local: Storage | undefined;
    try {
      local = localStorage;
    } catch {
      local = undefined;
    }
    void requestPersistentStorage(navigator.storage, local);
    return getSyncController().start();
  });
</script>

<div class="shell">
  <UpdateBanner />
  {#if storageFailed}
    <div class="notice" role="status">
      Local storage is unavailable, so progress will not be saved on this device.
    </div>
  {/if}
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

  .notice {
    padding: var(--space-2) var(--space-4);
    background: var(--color-surface);
    border-bottom: 1px solid var(--color-border);
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
