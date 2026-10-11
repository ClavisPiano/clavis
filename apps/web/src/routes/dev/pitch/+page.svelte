<script lang="ts">
  import { onDestroy } from "svelte";
  import { getAudioContextManager, hzToMidi, type MicState } from "@clavis/audio";
  import { createMicPitchSource } from "@clavis/audio/web";
  import type { NoteEvent, PitchFrame } from "@clavis/core";

  const MAX_NOTES = 20;
  const NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

  function noteName(midi: number): string {
    return `${NAMES[((midi % 12) + 12) % 12] ?? "?"}${String(Math.floor(midi / 12) - 1)}`;
  }

  interface Row {
    note: NoteEvent;
    done: boolean;
  }

  const audio = getAudioContextManager();
  const mic = createMicPitchSource();

  let micState = $state<MicState>("idle");
  let frame = $state<PitchFrame | undefined>();
  let rows = $state<Row[]>([]);
  let error = $state<string | undefined>();

  const live = $derived.by(() => {
    const hz = frame?.hz;
    if (hz === null || hz === undefined) return undefined;
    return { name: noteName(Math.round(hzToMidi(hz))), hz, cents: frame?.cents ?? 0 };
  });

  mic.onFrame((f) => {
    frame = f;
  });
  mic.onNote((note, phase) => {
    if (phase === "start") {
      rows = [{ note, done: false }, ...rows].slice(0, MAX_NOTES);
    } else {
      rows = rows.map((r) => (r.note.onsetMs === note.onsetMs ? { note, done: true } : r));
    }
  });

  async function start(): Promise<void> {
    error = undefined;
    try {
      // Both calls must begin inside the tap: the context resume and the permission prompt.
      await audio.unlock();
      await mic.start({ context: audio.getContext() as unknown as AudioContext });
      micState = mic.state;
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
      micState = mic.state;
    }
  }

  async function stop(): Promise<void> {
    await mic.stop();
    micState = mic.state;
    frame = undefined;
  }

  function togglePause(): void {
    if (mic.state === "running") mic.pause();
    else mic.resume();
    micState = mic.state;
  }

  onDestroy(() => {
    void mic.stop();
  });
</script>

<h1>Mic pitch</h1>

<p class="row">
  <button type="button" onclick={start} disabled={micState !== "idle"}>Start mic</button>
  <button
    type="button"
    onclick={togglePause}
    disabled={micState !== "running" && micState !== "paused"}
  >
    {micState === "paused" ? "Resume" : "Pause"}
  </button>
  <button type="button" onclick={stop} disabled={micState === "idle"}>Stop mic</button>
</p>

<dl>
  <dt>Mic</dt>
  <dd data-testid="mic-state">{micState}</dd>
  <dt>Note</dt>
  <dd class="big" data-testid="live-note">{live ? live.name : "-"}</dd>
  <dt>Frequency</dt>
  <dd data-testid="live-hz">{live ? `${live.hz.toFixed(1)} Hz` : "-"}</dd>
  <dt>Cents</dt>
  <dd data-testid="live-cents">
    {live ? `${live.cents >= 0 ? "+" : ""}${live.cents.toFixed(0)}` : "-"}
  </dd>
  <dt>Clarity</dt>
  <dd data-testid="live-clarity">{frame ? frame.confidence.toFixed(2) : "-"}</dd>
  <dt>Frame time</dt>
  <dd>{frame ? `${(frame.atMs / 1000).toFixed(2)} s (AudioContext clock)` : "-"}</dd>
</dl>

{#if error}<p role="alert">{error}</p>{/if}

<h2>Last {MAX_NOTES} notes</h2>
{#if rows.length === 0}
  <p>No notes yet. Sing or play a single note.</p>
{:else}
  <ol data-testid="notes">
    {#each rows as row (row.note.onsetMs)}
      <li>
        <strong>{noteName(row.note.pitch)}</strong>
        (MIDI {row.note.pitch}) onset {(row.note.onsetMs / 1000).toFixed(2)} s, clarity
        {row.note.confidence.toFixed(2)},
        {row.done && row.note.offsetMs !== undefined
          ? `${String(Math.round(row.note.offsetMs - row.note.onsetMs))} ms long`
          : "sounding"}
      </li>
    {/each}
  </ol>
{/if}

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
  .big {
    font-size: 2rem;
    font-weight: 600;
  }
</style>
