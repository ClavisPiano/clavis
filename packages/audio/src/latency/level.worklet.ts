/**
 * AudioWorkletProcessor that reports the peak level of every 128-sample render quantum, batched
 * eight at a time, with the frame of the first quantum. The main thread turns frames into
 * AudioContext time and feeds an `OnsetDetector`.
 *
 * Runs in AudioWorkletGlobalScope: self-contained, no value imports.
 */
export {};

declare const sampleRate: number;
declare const currentFrame: number;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
  constructor(options?: unknown);
}
declare function registerProcessor(
  name: string,
  ctor: new (options?: unknown) => AudioWorkletProcessor,
): void;

// Duplicated from level-meter.ts on purpose (see capture.worklet.ts). A test checks they match.
const PROCESSOR_NAME = "clavis-level-meter";
const BATCH = 8;

class LevelProcessor extends AudioWorkletProcessor {
  #peaks = new Float32Array(BATCH);
  #fill = 0;
  #startFrame = 0;

  process(inputs: Float32Array[][]): boolean {
    const first = inputs[0]?.[0];
    if (!first) return true;
    let peak = 0;
    for (const v of first) peak = Math.max(peak, Math.abs(v));
    if (this.#fill === 0) this.#startFrame = currentFrame;
    this.#peaks[this.#fill++] = peak;
    if (this.#fill === BATCH) {
      this.port.postMessage({
        type: "levels",
        startFrame: this.#startFrame,
        quantum: first.length,
        sampleRate,
        peaks: this.#peaks,
      });
      this.#peaks = new Float32Array(BATCH);
      this.#fill = 0;
    }
    return true;
  }
}

registerProcessor(PROCESSOR_NAME, LevelProcessor);
