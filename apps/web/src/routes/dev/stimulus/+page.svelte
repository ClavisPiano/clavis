<script lang="ts">
  import { onMount } from "svelte";
  import { asset } from "$app/paths";
  import {
    SmplrPianoInstrument,
    StimulusPlayer,
    getAudioContextManager,
    type ManagerState,
  } from "@clavis/audio";
  import { DEV_KEYS, cadenceSpec, scaleSpec } from "../../../lib/stimulus-dev";

  const audio = getAudioContextManager();
  const piano = new SmplrPianoInstrument({
    getContext: () => audio.getContext() as unknown as BaseAudioContext,
    // asset() only accepts real files, so derive the directory from the manifest.
    baseUrl: asset("samples/piano/manifest.json").replace(/\/manifest\.json$/, ""),
    onLoadProgress: (loaded, total) => {
      loadStatus = `Loading samples ${String(loaded)}/${String(total)}`;
    },
  });
  const player = new StimulusPlayer(audio, piano);

  let keyValue = $state("C major");
  let ctxState = $state<ManagerState>(audio.state);
  let loadStatus = $state("Samples not loaded");
  let times = $state<{ startAt: number; endAt: number } | undefined>();
  let error = $state<string | undefined>();

  onMount(() => audio.subscribe((s) => (ctxState = s)));

  const key = $derived(DEV_KEYS.find((k) => k.value === keyValue)?.key);

  async function unlock(): Promise<void> {
    error = undefined;
    try {
      await audio.unlock();
      loadStatus = "Loading samples";
      await player.load();
      loadStatus = "Samples ready";
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
  }

  function play(kind: "cadence" | "scale"): void {
    if (!key) return;
    error = undefined;
    try {
      times = player.play(kind === "cadence" ? cadenceSpec(key) : scaleSpec(key));
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
  }
</script>

<h1>Stimulus player</h1>

<p>
  <label>
    Key
    <select bind:value={keyValue}>
      {#each DEV_KEYS as k (k.value)}
        <option value={k.value}>{k.value}</option>
      {/each}
    </select>
  </label>
</p>

<p class="row">
  <button type="button" onclick={unlock}>Unlock audio</button>
  <button
    type="button"
    onclick={() => {
      play("cadence");
    }}>Play cadence</button
  >
  <button
    type="button"
    onclick={() => {
      play("scale");
    }}>Play scale</button
  >
  <button
    type="button"
    onclick={() => {
      player.stop();
    }}>Stop</button
  >
</p>

<dl>
  <dt>Context state</dt>
  <dd data-testid="ctx-state">{ctxState}</dd>
  <dt>Samples</dt>
  <dd>{loadStatus}</dd>
  <dt>startAt / endAt</dt>
  <dd data-testid="times">
    {#if times}{times.startAt.toFixed(3)} / {times.endAt.toFixed(3)} s{:else}not played yet{/if}
  </dd>
</dl>

{#if error}<p role="alert">{error}</p>{/if}

<style>
  .row {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2, 0.5rem);
  }
  button {
    min-height: 44px;
    padding: 0 var(--space-4, 1rem);
  }
</style>
