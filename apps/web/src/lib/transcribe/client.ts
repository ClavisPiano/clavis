import type { TranscribedNote, Transcriber } from "@clavis/audio";
import type { WorkerReply, WorkerRequest } from "./messages";

/** Where `static/models/basic-pitch/model.json` is served. */
export const MODEL_URL = "/models/basic-pitch/model.json";

/** The slice of `Worker` the client uses. */
export interface WorkerLike {
  postMessage(message: WorkerRequest, transfer: Transferable[]): void;
  addEventListener(type: "message", listener: (event: MessageEvent<WorkerReply>) => void): void;
  addEventListener(type: "error", listener: () => void): void;
  terminate(): void;
}

/** What the last transcription cost and found, for the review page (R31). */
export interface TranscribeStats {
  at: number;
  ms: number;
  backend: string;
  seconds: number;
  notes: number;
  ok: boolean;
}

export interface BasicPitchTranscriber extends Transcriber {
  /** Stop the worker and free the model. A later call starts a new one. */
  dispose(): void;
  readonly last: TranscribeStats | undefined;
}

/** Longest wait for a transcription before giving up, in ms. A slow CPU needs several seconds. */
export const TRANSCRIBE_TIMEOUT_MS = 60_000;

/**
 * A `Transcriber` backed by Basic Pitch in a worker, started on the first take so that nothing is
 * downloaded or parsed until a chord item is answered on the mic.
 */
export function createBasicPitchTranscriber(
  createWorker: () => WorkerLike,
  options: { now?: () => number; timeoutMs?: number } = {},
): BasicPitchTranscriber {
  const now = options.now ?? (() => performance.now());
  const timeoutMs = options.timeoutMs ?? TRANSCRIBE_TIMEOUT_MS;
  let worker: WorkerLike | undefined;
  let nextId = 1;
  const pending = new Map<number, (reply: WorkerReply) => void>();
  let last: TranscribeStats | undefined;

  const stop = (): void => {
    worker?.terminate();
    worker = undefined;
    for (const settle of pending.values()) settle({ id: 0, ok: false, error: "stopped" });
    pending.clear();
  };

  const start = (): WorkerLike => {
    const w = createWorker();
    w.addEventListener("message", (event) => {
      pending.get(event.data.id)?.(event.data);
    });
    w.addEventListener("error", stop);
    worker = w;
    return w;
  };

  return {
    get last() {
      return last;
    },
    dispose: stop,
    transcribe(samples, sampleRate): Promise<TranscribedNote[]> {
      const w = worker ?? start();
      const id = nextId++;
      const startedAt = now();
      return new Promise<TranscribedNote[]>((resolve, reject) => {
        const finish = (reply: WorkerReply): void => {
          clearTimeout(timer);
          pending.delete(id);
          last = {
            at: startedAt,
            ms: now() - startedAt,
            backend: reply.ok ? reply.backend : "none",
            seconds: samples.length / sampleRate,
            notes: reply.ok ? reply.notes.length : 0,
            ok: reply.ok,
          };
          if (reply.ok) resolve(reply.notes);
          else reject(new Error(reply.error));
        };
        const timer = setTimeout(() => {
          finish({ id, ok: false, error: "timed out" });
          // A stuck worker would block every later take.
          stop();
        }, timeoutMs);
        pending.set(id, finish);
        // The samples are a copy made for this request, so they can be transferred.
        const copy = samples.slice();
        w.postMessage({ id, samples: copy, sampleRate, modelUrl: MODEL_URL }, [copy.buffer]);
      });
    },
  };
}
