<script lang="ts">
  import { onMount } from "svelte";
  import type { LearningEvent } from "@clavis/core";
  import { initAppStore } from "../../../lib/app-store";

  let events = $state<LearningEvent[]>([]);
  let deviceId = $state("");
  let failed = $state(false);
  let loaded = $state(false);

  onMount(async () => {
    const result = await initAppStore();
    if (result.ok) {
      deviceId = result.deviceId;
      events = (await result.store.list()).slice(-50).reverse();
    } else {
      failed = true;
    }
    loaded = true;
  });
</script>

<h1>Events</h1>
{#if failed}
  <p>Local storage is unavailable.</p>
{:else if loaded}
  <p>Device: <code data-testid="device-id">{deviceId}</code></p>
  <p>Showing the latest {events.length} events (max 50).</p>
  <ul data-testid="events">
    {#each events as event (event.id)}
      <li data-testid="event">
        <strong>{event.type}</strong>
        <time datetime={new Date(event.at).toISOString()}>{new Date(event.at).toISOString()}</time>
        <code>{event.id}</code>
      </li>
    {/each}
  </ul>
{:else}
  <p>Loading...</p>
{/if}
