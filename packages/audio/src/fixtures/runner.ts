import { runPipelineOnPcm, type PipelineOptions, type PipelineResult } from "../pitch/pipeline.js";
import { readWav } from "./wav.js";

/**
 * Fixture runner: the same DSP as the in-browser worker, run over a WAV file in Node.
 *
 * This module does no file I/O itself (the package also builds for the browser). Callers pass the
 * bytes, or a `readFile` function such as `(p) => fs.promises.readFile(p)`.
 */

export interface FixtureResult extends PipelineResult {
  sampleRate: number;
  durationMs: number;
}

export function runWavBytes(bytes: Uint8Array, options: PipelineOptions = {}): FixtureResult {
  const wav = readWav(bytes);
  const result = runPipelineOnPcm(wav.samples, wav.sampleRate, options);
  return {
    ...result,
    sampleRate: wav.sampleRate,
    durationMs: (wav.samples.length / wav.sampleRate) * 1000,
  };
}

export async function runWavFile(
  path: string,
  readFile: (path: string) => Promise<Uint8Array>,
  options: PipelineOptions = {},
): Promise<FixtureResult> {
  return runWavBytes(await readFile(path), options);
}
