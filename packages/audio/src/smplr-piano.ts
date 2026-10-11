import { SplendidGrandPiano } from "smplr";
import type { Instrument, InstrumentNote } from "./instrument.js";

/**
 * Notes (MIDI) present in the self-hosted sample set. smplr pitch-shifts the nearest sample for
 * the notes in between. KEEP IN SYNC with apps/web/scripts/fetch-samples.mjs.
 */
export const PIANO_SAMPLE_NOTES: readonly number[] = [
  35, 41, 45, 48, 55, 59, 62, 65, 69, 72, 76, 79, 83, 86, 89, 96,
];

/** smplr velocity range (1..127) covered by the shipped layers PP, MP and MF. */
export const PIANO_VELOCITY_RANGE: readonly [number, number] = [41, 100];

/** Default location of the self-hosted samples (served from apps/web/static). */
export const DEFAULT_PIANO_BASE_URL = "/samples/piano";

/** Map a 0..1 velocity into the shipped layer range, rounded to a MIDI velocity. */
export function mapVelocity(
  velocity: number,
  range: readonly [number, number] = PIANO_VELOCITY_RANGE,
): number {
  const v = Math.min(1, Math.max(0, velocity));
  return Math.round(range[0] + v * (range[1] - range[0]));
}

export interface SmplrPianoOptions {
  /** Returns the shared context. Called at load(), so it can create the context lazily. */
  getContext: () => BaseAudioContext;
  /** Where the sample files live. Default `/samples/piano`. A trailing slash is ignored. */
  baseUrl?: string;
  onLoadProgress?: (loaded: number, total: number) => void;
}

/** Sampled piano via smplr's SplendidGrandPiano, loading the self-hosted subset. */
export class SmplrPianoInstrument implements Instrument {
  readonly #options: SmplrPianoOptions;
  #piano: ReturnType<typeof SplendidGrandPiano> | undefined;
  #loading: Promise<void> | undefined;

  constructor(options: SmplrPianoOptions) {
    this.#options = options;
  }

  load(): Promise<void> {
    this.#loading ??= this.#doLoad().catch((e: unknown) => {
      this.#loading = undefined; // allow a retry after a network failure
      throw e;
    });
    return this.#loading;
  }

  async #doLoad(): Promise<void> {
    const onProgress = this.#options.onLoadProgress;
    const piano = SplendidGrandPiano(this.#options.getContext(), {
      baseUrl: (this.#options.baseUrl ?? DEFAULT_PIANO_BASE_URL).replace(/\/$/, ""),
      // Safari cannot decode ogg; the shipped files are m4a only.
      formats: ["m4a"],
      notesToLoad: {
        notes: [...PIANO_SAMPLE_NOTES],
        velocityRange: [PIANO_VELOCITY_RANGE[0], PIANO_VELOCITY_RANGE[1]],
        fallback: "nearest",
      },
      ...(onProgress && {
        onLoadProgress: (p: { loaded: number; total: number }) => {
          onProgress(p.loaded, p.total);
        },
      }),
    });
    await piano.ready;
    this.#piano = piano;
  }

  start({ midi, time, duration, velocity }: InstrumentNote): void {
    if (!this.#piano) throw new Error("SmplrPianoInstrument.start called before load() resolved");
    this.#piano.start({ note: midi, time, duration, velocity: mapVelocity(velocity) });
  }

  stopAll(time?: number): void {
    if (!this.#piano) return;
    // Notes beyond smplr's scheduler lookahead sit in its queue, not yet in the audio graph.
    this.#piano.scheduler.stop();
    if (time === undefined) this.#piano.stop();
    else this.#piano.stop({ time });
  }
}
