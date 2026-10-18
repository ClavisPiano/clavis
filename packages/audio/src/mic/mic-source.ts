import type { NoteEvent, PitchFrame, VoiceRange } from "@clavis/core";
import {
  CAPTURE_PROCESSOR_NAME,
  DEFAULT_CAPTURE_CHUNK,
  type PipelineConfig,
  type MicTake,
  type WorkerInbound,
  type WorkerOutbound,
  type WorkletInbound,
} from "./messages.js";

/** The slice of `Worker` this class uses. */
export interface WorkerLike {
  postMessage(message: WorkerInbound, transfer: Transferable[]): void;
  addEventListener(type: "message", listener: (event: MessageEvent<WorkerOutbound>) => void): void;
  terminate(): void;
}

/** What the bundler provides: where the worklet module lives and how to start the worker. */
export interface MicAssets {
  workletUrl: string;
  createWorker: () => WorkerLike;
}

/** The slice of `AudioContext` used for capture. */
export interface CaptureContext {
  readonly currentTime: number;
  readonly destination: AudioNode;
  readonly audioWorklet: { addModule(url: string): Promise<void> };
  createMediaStreamSource(stream: MediaStream): MediaStreamAudioSourceNode;
  createGain(): GainNode;
}

export interface MicDeps {
  getUserMedia(constraints: MediaStreamConstraints): Promise<MediaStream>;
  createWorkletNode(
    context: CaptureContext,
    name: string,
    options: AudioWorkletNodeOptions,
  ): AudioWorkletNode;
  createChannel(): MessageChannel;
}

const defaultDeps: MicDeps = {
  getUserMedia: (c) => navigator.mediaDevices.getUserMedia(c),
  createWorkletNode: (context, name, options) =>
    new AudioWorkletNode(context as unknown as BaseAudioContext, name, options),
  createChannel: () => new MessageChannel(),
};

/**
 * Defaults chosen for pitch work: browser voice processing (echo cancellation, noise suppression,
 * automatic gain) distorts pitch and dynamics. T1.1 may find that a device needs some of them on,
 * so callers can override any field.
 */
export const DEFAULT_MIC_CONSTRAINTS: MediaTrackConstraints = {
  echoCancellation: false,
  noiseSuppression: false,
  autoGainControl: false,
  channelCount: 1,
};

export interface MicStartOptions {
  context: CaptureContext;
  /** Merged over `DEFAULT_MIC_CONSTRAINTS`. */
  constraints?: MediaTrackConstraints;
  /** Tuning for the tracker and segmenter. Must be structured-cloneable. */
  pipeline?: PipelineConfig;
  /** Samples per worklet chunk. A multiple of 128. Default 2048. */
  chunkSize?: number;
}

export type MicState = "idle" | "starting" | "running" | "paused";
export type NotePhase = "start" | "end";

export interface MicPitchSourceOptions {
  assets: MicAssets;
  /** Replaceable browser entry points, for tests. */
  deps?: Partial<MicDeps>;
}

/**
 * Microphone pitch source. `start()` once (it needs a user gesture on iOS), then keep it running
 * across items and gate it with `pause()` / `resume()`; re-requesting the stream per item would
 * re-prompt or glitch the iOS audio session (architecture 4.2).
 *
 * Signal path: getUserMedia -> MediaStreamSource -> capture AudioWorklet -> (MessageChannel, buffers
 * transferred) -> pitch Worker -> postMessage -> this class. Every `atMs` / `onsetMs` is on the
 * AudioContext clock in ms (`context.currentTime * 1000`), directly comparable with
 * `StimulusPlayer`'s `endAt * 1000`. The stamp is the time the audio reached the worklet, so the
 * true acoustic event is earlier by the device's input latency, which T1.7 calibrates.
 *
 * Note events come in two phases: `start` once the pitch is known (about 120 ms after onset, no
 * `offsetMs`), and `end` with `offsetMs` when the note finishes.
 */
export class MicPitchSource {
  readonly #assets: MicAssets;
  readonly #deps: MicDeps;
  readonly #frameListeners = new Set<(frame: PitchFrame) => void>();
  readonly #noteListeners = new Set<(note: NoteEvent, phase: NotePhase) => void>();
  readonly #modulesAdded = new WeakSet();
  #state: MicState = "idle";
  #stream: MediaStream | undefined;
  #worker: WorkerLike | undefined;
  #nodes: AudioNode[] = [];
  #stopped: (() => void) | undefined;
  #range: VoiceRange | null = null;
  #takeWaiters: ((take: MicTake) => void)[] = [];

  constructor(options: MicPitchSourceOptions) {
    this.#assets = options.assets;
    this.#deps = { ...defaultDeps, ...options.deps };
  }

  get state(): MicState {
    return this.#state;
  }

  onFrame(listener: (frame: PitchFrame) => void): () => void {
    this.#frameListeners.add(listener);
    return () => {
      this.#frameListeners.delete(listener);
    };
  }

  onNote(listener: (note: NoteEvent, phase: NotePhase) => void): () => void {
    this.#noteListeners.add(listener);
    return () => {
      this.#noteListeners.delete(listener);
    };
  }

  async start(options: MicStartOptions): Promise<void> {
    if (this.#state !== "idle") return;
    this.#state = "starting";
    const { context } = options;
    try {
      const stream = await this.#deps.getUserMedia({
        audio: { ...DEFAULT_MIC_CONSTRAINTS, ...options.constraints },
      });
      this.#stream = stream;
      if (!this.#modulesAdded.has(context)) {
        await context.audioWorklet.addModule(this.#assets.workletUrl);
        this.#modulesAdded.add(context);
      }

      const worker = this.#assets.createWorker();
      this.#worker = worker;
      worker.addEventListener("message", (event) => {
        this.#onWorkerMessage(event.data);
      });
      const channel = this.#deps.createChannel();
      const config = options.pipeline;
      worker.postMessage({ type: "init", port: channel.port1, ...(config && { config }) }, [
        channel.port1,
      ]);

      if (this.#range) worker.postMessage(rangeMessage(this.#range), []);

      const node = this.#deps.createWorkletNode(context, CAPTURE_PROCESSOR_NAME, {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [1],
        channelCount: 1,
        channelCountMode: "explicit",
        processorOptions: { chunkSize: options.chunkSize ?? DEFAULT_CAPTURE_CHUNK },
      });
      const inbound: WorkletInbound = { type: "port", port: channel.port2 };
      node.port.postMessage(inbound, [channel.port2]);

      const source = context.createMediaStreamSource(stream);
      // The worklet produces silence; routing it through a muted gain to the destination keeps the
      // browser pulling the node on engines that skip nodes with no path to the output.
      const mute = context.createGain();
      mute.gain.value = 0;
      source.connect(node);
      node.connect(mute);
      mute.connect(context.destination);
      this.#nodes = [source, node, mute];
      this.#state = "running";
    } catch (error) {
      this.#release();
      this.#state = "idle";
      throw error;
    }
  }

  /**
   * Ignore the microphone, e.g. while a stimulus plays plus its tail (T1.6). Frames and notes are
   * dropped and any note in progress is discarded. The stream stays open.
   */
  pause(): void {
    if (this.#state !== "running") return;
    this.#state = "paused";
    this.#worker?.postMessage({ type: "pause" }, []);
  }

  resume(): void {
    if (this.#state !== "paused") return;
    this.#state = "running";
    this.#worker?.postMessage({ type: "resume" }, []);
  }

  /**
   * Tell the pitch worker which register the answer is in (MIDI numbers), or `null` to clear it.
   * Remembered across `start()`, and applies to the next frames without restarting the stream.
   */
  setExpectedRange(range: VoiceRange | null): void {
    this.#range = range;
    this.#worker?.postMessage(rangeMessage(range), []);
  }

  /**
   * The audio heard since the last `resume()`, for transcription after the answer (T8.19). Ask
   * before `pause()`, which discards it. Resolves with an empty take if the worker does not answer.
   */
  async takeAudio(timeoutMs = 1000): Promise<MicTake> {
    const worker = this.#worker;
    const empty: MicTake = {
      samples: new Float32Array(0),
      sampleRate: 0,
      startMs: 0,
      truncated: false,
    };
    if (!worker || this.#state === "idle" || this.#state === "starting") return empty;
    return new Promise<MicTake>((resolve) => {
      const done = (take: MicTake): void => {
        clearTimeout(timer);
        resolve(take);
      };
      const timer = setTimeout(() => {
        this.#takeWaiters = this.#takeWaiters.filter((w) => w !== done);
        resolve(empty);
      }, timeoutMs);
      this.#takeWaiters.push(done);
      worker.postMessage({ type: "take" }, []);
    });
  }

  /** Release the microphone and the worker. A note in progress is ended and delivered first. */
  async stop(): Promise<void> {
    if (this.#state === "idle" || this.#state === "starting") return;
    const worker = this.#worker;
    if (worker) {
      const done = new Promise<void>((resolve) => {
        this.#stopped = resolve;
      });
      worker.postMessage({ type: "stop" }, []);
      await Promise.race([done, new Promise<void>((resolve) => setTimeout(resolve, 500))]);
    }
    this.#release();
    this.#state = "idle";
  }

  #release(): void {
    for (const node of this.#nodes) {
      try {
        node.disconnect();
      } catch {
        // Already disconnected.
      }
    }
    this.#nodes = [];
    for (const track of this.#stream?.getTracks() ?? []) track.stop();
    this.#stream = undefined;
    this.#worker?.terminate();
    this.#worker = undefined;
    this.#stopped = undefined;
  }

  #onWorkerMessage(message: WorkerOutbound): void {
    if (message.type === "stopped") {
      this.#stopped?.();
      return;
    }
    if (message.type === "take") {
      this.#takeWaiters.shift()?.(message.take);
      return;
    }
    // The pause flag is checked here too, because messages posted before the worker saw the pause
    // are still in flight.
    if (this.#state === "paused") return;
    if (message.type === "frame") {
      for (const l of this.#frameListeners) l(message.frame);
    } else {
      for (const l of this.#noteListeners) l(message.note, message.phase);
    }
  }
}

function rangeMessage(range: VoiceRange | null): WorkerInbound {
  return { type: "range", range: range && { minMidi: range.low, maxMidi: range.high } };
}
