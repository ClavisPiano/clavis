import { BasicPitch, noteFramesToTime, outputToNotesPoly } from "@spotify/basic-pitch";
import { resampleMono, TRANSCRIBE_RATE, type TranscribedNote } from "@clavis/audio";
import type { GraphModel } from "@tensorflow/tfjs";

/*
 * Basic Pitch (Spotify, Apache-2.0) turned into the `Transcriber` shape (T8.19, R31). The pure part
 * lives here so Node tests can run the real model; the worker (`basic-pitch.worker.ts`) loads the
 * model in the browser and calls `transcribeSamples`.
 */

/** Thresholds from the library's own demo, then tightened for piano: fewer ghost notes. */
export const ONSET_THRESHOLD = 0.5;
export const FRAME_THRESHOLD = 0.3;
/** Shortest note kept, in model frames (about 11.6 ms each). */
export const MIN_NOTE_FRAMES = 11;
/** Piano range (A0 to C8) in Hz; notes outside it are model noise. */
export const MIN_HZ = 27.5;
export const MAX_HZ = 4186;

export async function transcribeSamples(
  model: GraphModel | Promise<GraphModel>,
  samples: Float32Array,
  sampleRate: number,
): Promise<TranscribedNote[]> {
  const mono = resampleMono(samples, sampleRate, TRANSCRIBE_RATE);
  if (mono.length < TRANSCRIBE_RATE / 4) return [];
  const frames: number[][] = [];
  const onsets: number[][] = [];
  const basicPitch = new BasicPitch(Promise.resolve(model));
  await basicPitch.evaluateModel(
    mono,
    (f, o) => {
      frames.push(...f);
      onsets.push(...o);
    },
    () => undefined,
  );
  const events = outputToNotesPoly(
    frames,
    onsets,
    ONSET_THRESHOLD,
    FRAME_THRESHOLD,
    MIN_NOTE_FRAMES,
    true,
    MAX_HZ,
    MIN_HZ,
    true,
  );
  return noteFramesToTime(events).map((n) => ({
    startSec: n.startTimeSeconds,
    durationSec: n.durationSeconds,
    midi: n.pitchMidi,
    amplitude: n.amplitude,
  }));
}
