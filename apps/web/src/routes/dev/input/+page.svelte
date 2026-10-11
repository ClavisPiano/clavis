<script lang="ts">
  import { onMount } from "svelte";
  import { asset } from "$app/paths";
  import {
    SmplrPianoInstrument,
    getAudioContextManager,
    type InputAdapter,
    type TapInputAdapter,
  } from "@clavis/audio";
  import type { NoteEvent } from "@clavis/core";
  import Keyboard from "../../../lib/components/Keyboard.svelte";
  import {
    INPUT_STORAGE_KEY,
    createInput,
    detachFakeInput,
    resolveInputKind,
    type InputKind,
  } from "../../../lib/input";
  import { noteName } from "../../../lib/keyboard";
  import { parseSessionMode } from "../../../lib/session-mode";

  const MAX_NOTES = 20;

  const audio = getAudioContextManager();
  const piano = new SmplrPianoInstrument({
    getContext: () => audio.getContext() as unknown as BaseAudioContext,
    baseUrl: asset("samples/piano/manifest.json").replace(/\/manifest\.json$/, ""),
  });

  let kind = $state<InputKind>("mic");
  let running = $state(false);
  let sound = $state(false);
  let error = $state<string | undefined>();
  let notes = $state<NoteEvent[]>([]);
  let adapter: InputAdapter | undefined;
  let tap = $state<TapInputAdapter | undefined>();
  let off: (() => void) | undefined;

  function teardown(): void {
    off?.();
    off = undefined;
    adapter?.stop();
    adapter = undefined;
    tap = undefined;
    detachFakeInput();
    running = false;
  }

  function select(next: InputKind): void {
    teardown();
    kind = next;
    notes = [];
    error = undefined;
    const handle = createInput(next);
    adapter = handle.adapter;
    tap = handle.tap;
    off = adapter.onNote((n) => {
      notes = [n, ...notes].slice(0, MAX_NOTES);
    });
    // The fake adapter needs no permission or gesture, so it is live straight away.
    if (next === "fake") void start();
  }

  async function start(): Promise<void> {
    error = undefined;
    try {
      await adapter?.start();
      running = true;
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
  }

  function stop(): void {
    adapter?.stop();
    running = false;
  }

  function emit(midi: number): void {
    window.__clavisFakeInput?.emitNote(midi);
  }

  let soundReady = false;
  function playSound(midi: number): void {
    if (!sound) return;
    void (async () => {
      if (!soundReady) {
        await audio.unlock();
        await piano.load();
        soundReady = true;
      }
      piano.start({ midi, time: audio.currentTime, duration: 0.8, velocity: 0.8 });
    })().catch(() => {
      sound = false;
    });
  }

  onMount(() => {
    const params = new URLSearchParams(window.location.search);
    let stored: string | null = null;
    try {
      stored = window.localStorage.getItem(INPUT_STORAGE_KEY);
    } catch {
      // Storage can be blocked; fall back to the mode default.
    }
    select(resolveInputKind(parseSessionMode(params), params, stored));
    return teardown;
  });
</script>

<h1>Input adapters</h1>

<p class="row">
  <label>
    Adapter
    <select
      value={kind}
      onchange={(e) => {
        select(e.currentTarget.value as InputKind);
      }}
    >
      <option value="mic">mic</option>
      <option value="tap">tap</option>
      <option value="fake">fake</option>
    </select>
  </label>
  <button type="button" onclick={start} disabled={running}>Start</button>
  <button type="button" onclick={stop} disabled={!running}>Stop</button>
  <span data-testid="input-state">{kind}: {running ? "running" : "stopped"}</span>
</p>

{#if error}<p role="alert">{error}</p>{/if}

{#if kind === "tap"}
  <label><input type="checkbox" bind:checked={sound} /> Play piano sound</label>
  <Keyboard
    focusMidi={60}
    labels="c-only"
    disabled={!running}
    {playSound}
    onpress={(midi: number, ts: number) => tap?.press(midi, ts)}
    onrelease={(midi: number, ts: number) => tap?.release(midi, ts)}
  />
{/if}

{#if kind === "fake"}
  <p class="row">
    {#each [60, 64, 67] as midi (midi)}
      <button
        type="button"
        onclick={() => {
          emit(midi);
        }}>Emit {noteName(midi)}</button
      >
    {/each}
  </p>
{/if}

<h2>Last {MAX_NOTES} notes</h2>
{#if notes.length === 0}
  <p>No notes yet.</p>
{:else}
  <ol data-testid="notes">
    {#each notes as note, i (`${String(i)}:${String(note.onsetMs)}`)}
      <li data-testid="note">
        {noteName(note.pitch)} (midi {note.pitch}) source={note.source} onset={note.onsetMs.toFixed(
          1,
        )} ms conf={note.confidence}
      </li>
    {/each}
  </ol>
{/if}

<style>
  .row {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
    align-items: center;
  }
</style>
