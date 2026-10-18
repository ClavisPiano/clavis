/**
 * Polyphonic transcription of a recorded take (T8.19, R31). The transcriber is injected: the web
 * app supplies Basic Pitch in a worker, tests supply a stub. Nothing here depends on the model.
 */

/** Sample rate the model wants. */
export const TRANSCRIBE_RATE = 22_050;

/** One note found in the take. Times are seconds from the first sample. */
export interface TranscribedNote {
  startSec: number;
  durationSec: number;
  /** MIDI note number. */
  midi: number;
  /** 0 to 1, the model's strength for the note. */
  amplitude: number;
}

export interface Transcriber {
  /** Mono samples at `sampleRate`; the transcriber resamples as it needs. */
  transcribe(samples: Float32Array, sampleRate: number): Promise<TranscribedNote[]>;
}
