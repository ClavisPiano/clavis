/**
 * Browser entry for the microphone pipeline: `@clavis/audio/web`.
 *
 * Kept apart from the main entry because the `?worker` suffixes are Vite-only. Importing this from
 * a Vite app makes Vite emit the worklet and the worker as separate hashed files and hands back
 * their URLs. Nothing else in the package depends on the bundler, so the Node tests never load
 * this file.
 */
import captureWorkletUrl from "./mic/capture.worklet.ts?worker&url";
import PitchWorker from "./mic/pitch.worker.ts?worker";
import levelWorkletUrl from "./latency/level.worklet.ts?worker&url";
import { LevelMeter, type LevelMeterOptions } from "./latency/level-meter.js";
import { MicPitchSource, type MicAssets, type MicPitchSourceOptions } from "./mic/mic-source.js";

export const micAssets: MicAssets = {
  workletUrl: captureWorkletUrl,
  createWorker: () => new PitchWorker({ name: "clavis-pitch" }),
};

/** A `MicPitchSource` wired to the bundled worklet and worker. */
export function createMicPitchSource(
  options: Omit<MicPitchSourceOptions, "assets"> = {},
): MicPitchSource {
  return new MicPitchSource({ ...options, assets: micAssets });
}

/** A `LevelMeter` (energy onsets for latency calibration) wired to the bundled worklet. */
export function createLevelMeter(options: Omit<LevelMeterOptions, "workletUrl"> = {}): LevelMeter {
  return new LevelMeter({ ...options, workletUrl: levelWorkletUrl });
}
