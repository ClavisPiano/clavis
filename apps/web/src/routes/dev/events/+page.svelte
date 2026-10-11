<script lang="ts">
  import { onMount } from "svelte";
  import type { LearningEvent } from "@clavis/core";
  import { initAppStore } from "../../../lib/app-store";

  let events = $state<LearningEvent[]>([]);
  let deviceId = $state("");
  let failed = $state(false);
  let loaded = $state(false);

  /**
   * Target midi of a presented single-note reading item, for the e2e specs. This page is a dev
   * tool, so it can show what the session UI never reveals.
   */
  function presentedMidi(event: LearningEvent): number | undefined {
    if (event.type !== "item.presented" || event.generator !== "bassNoteRead") return undefined;
    const midi = event.presentation.midi;
    return typeof midi === "number" ? midi : undefined;
  }

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
      <li
        data-testid="event"
        data-v={event.v}
        data-practice={event.type === "session.started" && event.practice === true}
        data-midi={presentedMidi(event)}
        data-block={event.type === "item.presented" ? event.block : undefined}
        data-generator={event.type === "item.presented" ? event.generator : undefined}
      >
        <strong>{event.type}</strong>
        <time datetime={new Date(event.at).toISOString()}>{new Date(event.at).toISOString()}</time>
        <code>{event.id}</code>
      </li>
    {/each}
  </ul>
{:else}
  <p>Loading...</p>
{/if}
