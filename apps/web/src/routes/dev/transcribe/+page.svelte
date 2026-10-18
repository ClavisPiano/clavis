<script lang="ts">
  import { onDestroy } from "svelte";
  import { MicInputAdapter, getAudioContextManager, type CaptureContext } from "@clavis/audio";
  import { createMicPitchSource } from "@clavis/audio/web";
  import type { NoteEvent } from "@clavis/core";
  import { groupChords, noteName, type HeardChord } from "../../../lib/transcribe/review";
  import type { TranscribeStats } from "../../../lib/transcribe/client";
  import { createWebTranscriber } from "../../../lib/transcribe/web";

  /* Review page for chords on the microphone (T8.19, R31). Play something you know, press Stop and
     compare the chords below with what you played. Nothing is stored. */

  const audio = getAudioContextManager();
  const transcriber = createWebTranscriber();
  const mic = new MicInputAdapter({
    source: createMicPitchSource(),
    getContext: async () => {
      await audio.unlock({ capture: true });
      return audio.getContext() as unknown as CaptureContext;
    },
    transcriber,
  });

  let phase = $state<"idle" | "ready" | "recording" | "working">("idle");
  let error = $state<string | undefined>();
  let notes = $state<NoteEvent[]>([]);
  let chords = $state<HeardChord[]>([]);
  let stats = $state<TranscribeStats | undefined>();
  let recordedAtMs = 0;

  async function start(): Promise<void> {
    error = undefined;
    try {
      await mic.start();
      mic.pause();
      phase = "ready";
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
  }

  function record(): void {
    recordedAtMs = audio.getContext().currentTime * 1000;
    mic.resume();
    notes = [];
    chords = [];
    phase = "recording";
  }

  async function finish(): Promise<void> {
    phase = "working";
    try {
      notes = await mic.finishTake();
      chords = groupChords(notes, recordedAtMs);
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
    mic.pause();
    stats = transcriber.last;
    phase = "ready";
  }

  onDestroy(() => {
    mic.stop();
    transcriber.dispose();
  });
</script>

<h1>Chords on the microphone</h1>
<p>
  Play a chord or two on your piano, press Stop, and compare what was heard with what you played.
  The recording is analysed on this device and not stored. The first take downloads the model.
</p>

<p class="row">
  <button type="button" onclick={start} disabled={phase !== "idle"} data-testid="tx-start">
    Start mic
  </button>
  <button type="button" onclick={record} disabled={phase !== "ready"} data-testid="tx-record">
    Record
  </button>
  <button type="button" onclick={finish} disabled={phase !== "recording"} data-testid="tx-stop">
    Stop and transcribe
  </button>
</p>

<p data-testid="tx-state" aria-live="polite">
  {phase === "working" ? "Working out the notes..." : phase}
</p>
{#if error}<p role="alert">{error}</p>{/if}

{#if stats}
  <dl data-testid="tx-stats">
    <dt>Take</dt>
    <dd>{stats.seconds.toFixed(1)} s</dd>
    <dt>Time to transcribe</dt>
    <dd>{(stats.ms / 1000).toFixed(1)} s on {stats.backend}</dd>
    <dt>Notes found</dt>
    <dd>{stats.notes} {stats.ok ? "" : "(failed)"}</dd>
  </dl>
{/if}

{#if chords.length > 0}
  <h2>Heard</h2>
  <ol data-testid="tx-chords">
    {#each chords as chord (chord.atSec)}
      <li>{chord.atSec.toFixed(2)} s: <strong>{chord.names.join(" ")}</strong></li>
    {/each}
  </ol>
  <h2>Notes</h2>
  <ul>
    {#each notes as n (`${String(n.onsetMs)}-${String(n.pitch)}`)}
      <li>
        {noteName(n.pitch)} (MIDI {n.pitch}), strength {n.confidence.toFixed(2)}, {(
          ((n.offsetMs ?? n.onsetMs) - n.onsetMs) /
          1000
        ).toFixed(2)} s long
      </li>
    {/each}
  </ul>
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
</style>
