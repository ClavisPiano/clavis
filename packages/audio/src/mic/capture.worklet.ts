/**
 * AudioWorkletProcessor that gathers 128-sample render quanta into larger chunks and posts them
 * straight to the pitch worker over a MessagePort (no hop through the main thread). Buffers are
 * transferred, never copied, and no SharedArrayBuffer is involved.
 *
 * This file runs in AudioWorkletGlobalScope and must stay self-contained: no imports other than
 * erased types. The names below are the only globals it relies on.
 */
import type { CaptureChunk, WorkletInbound } from "./messages.js";

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

// Duplicated from messages.ts on purpose: a value import would make the worklet depend on the
// bundler's chunking. A test checks the two stay equal.
const PROCESSOR_NAME = "clavis-pitch-capture";

class CaptureProcessor extends AudioWorkletProcessor {
  #chunkSize: number;
  #buffer: Float32Array;
  #fill = 0;
  #startFrame = 0;
  #nextFrame = -1;
  #out: MessagePort | undefined;

  constructor(options?: unknown) {
    super(options);
    const opts = (options as { processorOptions?: { chunkSize?: number } } | undefined)
      ?.processorOptions;
    this.#chunkSize = opts?.chunkSize ?? 2048;
    this.#buffer = new Float32Array(this.#chunkSize);
    this.port.onmessage = (event: MessageEvent<WorkletInbound>) => {
      this.#out = event.data.port;
    };
  }

  #post(length: number): void {
    const out = this.#out;
    if (out && length > 0) {
      const samples = length === this.#buffer.length ? this.#buffer : this.#buffer.slice(0, length);
      const chunk: CaptureChunk = {
        type: "chunk",
        samples,
        startFrame: this.#startFrame,
        sampleRate,
      };
      out.postMessage(chunk, [samples.buffer]);
      this.#buffer = new Float32Array(this.#chunkSize);
    }
    this.#fill = 0;
  }

  process(inputs: Float32Array[][]): boolean {
    const channels = inputs[0];
    const first = channels?.[0];
    if (!channels || !first) return true;

    // A discontinuity (the graph was disconnected for a while) ends the partial chunk.
    if (this.#fill > 0 && currentFrame !== this.#nextFrame) this.#post(this.#fill);

    const n = first.length;
    for (let i = 0; i < n; i++) {
      if (this.#fill === 0) this.#startFrame = currentFrame + i;
      let v = first[i] ?? 0;
      for (let c = 1; c < channels.length; c++) v += channels[c]?.[i] ?? 0;
      this.#buffer[this.#fill++] = channels.length > 1 ? v / channels.length : v;
      if (this.#fill === this.#chunkSize) this.#post(this.#chunkSize);
    }
    this.#nextFrame = currentFrame + n;
    return true;
  }
}

registerProcessor(PROCESSOR_NAME, CaptureProcessor);
