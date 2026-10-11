import type { CaptureContext } from "../mic/mic-source.js";
import { OnsetDetector, type OnsetDetectorOptions } from "./onset.js";

/** Name the level processor registers under. Must equal the constant in level.worklet.ts. */
export const LEVEL_PROCESSOR_NAME = "clavis-level-meter";

export interface LevelMessage {
  type: "levels";
  startFrame: number;
  quantum: number;
  sampleRate: number;
  peaks: Float32Array;
}

/** Context time (ms) of each quantum in a message. */
export function levelTimesMs(msg: LevelMessage): number[] {
  return Array.from(
    msg.peaks,
    (_, i) => ((msg.startFrame + i * msg.quantum) / msg.sampleRate) * 1000,
  );
}

export interface LevelMeterOptions {
  workletUrl: string;
  onset?: OnsetDetectorOptions;
  constraints?: MediaTrackConstraints;
}

/**
 * Opens the microphone and reports energy onsets on the AudioContext clock (ms). The stamp is the
 * time the audio reached the worklet, so loopback delta = output latency + input latency + travel.
 */
export class LevelMeter {
  readonly #options: LevelMeterOptions;
  #stream: MediaStream | undefined;
  #nodes: AudioNode[] = [];
  readonly #listeners = new Set<(onsetMs: number) => void>();

  constructor(options: LevelMeterOptions) {
    this.#options = options;
  }

  get running(): boolean {
    return this.#stream !== undefined;
  }

  onOnset(cb: (onsetMs: number) => void): () => void {
    this.#listeners.add(cb);
    return () => {
      this.#listeners.delete(cb);
    };
  }

  async start(context: CaptureContext): Promise<void> {
    if (this.#stream) return;
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        channelCount: 1,
        ...this.#options.constraints,
      },
    });
    try {
      await context.audioWorklet.addModule(this.#options.workletUrl);
      const node = new AudioWorkletNode(
        context as unknown as BaseAudioContext,
        LEVEL_PROCESSOR_NAME,
        {
          numberOfInputs: 1,
          numberOfOutputs: 1,
          outputChannelCount: [1],
          channelCount: 1,
        },
      );
      const detector = new OnsetDetector(this.#options.onset);
      node.port.onmessage = (event: MessageEvent<LevelMessage>) => {
        const msg = event.data;
        const times = levelTimesMs(msg);
        msg.peaks.forEach((level, i) => {
          const onset = detector.push(times[i] ?? 0, level);
          if (onset !== undefined) for (const l of this.#listeners) l(onset);
        });
      };
      const source = context.createMediaStreamSource(stream);
      const mute = context.createGain();
      mute.gain.value = 0;
      source.connect(node);
      node.connect(mute);
      mute.connect(context.destination);
      this.#nodes = [source, node, mute];
      this.#stream = stream;
    } catch (error) {
      for (const t of stream.getTracks()) t.stop();
      throw error;
    }
  }

  stop(): void {
    for (const n of this.#nodes) {
      try {
        n.disconnect();
      } catch {
        // Already disconnected.
      }
    }
    this.#nodes = [];
    for (const t of this.#stream?.getTracks() ?? []) t.stop();
    this.#stream = undefined;
  }
}
