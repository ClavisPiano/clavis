import type { ScoreSpec } from "@clavis/core";
import type { NotationRenderer } from "@clavis/notation";
import type { NotationRequest, NotationResponse } from "./protocol";

/** The notation engine could not be loaded (chunk missing offline, WASM failure, worker crash). */
export class NotationLoadError extends Error {
  override readonly name = "NotationLoadError";
}

/** The part of `Worker` the client uses, so tests can supply a fake. */
export interface WorkerLike {
  postMessage(message: NotationRequest): void;
  terminate(): void;
  onmessage: ((event: { data: NotationResponse }) => void) | null;
  onerror: ((event: { message?: string }) => void) | null;
}

export interface NotationClient extends NotationRenderer {
  /** Stops the worker. A later call starts a fresh one. */
  dispose(): void;
}

export interface NotationClientOptions {
  /** Defaults to the bundled Verovio module worker. */
  createWorker?: () => WorkerLike;
}

function defaultWorker(): WorkerLike {
  return new Worker(new URL("./verovio.worker.ts", import.meta.url), {
    type: "module",
  }) as unknown as WorkerLike;
}

type WithoutId<T> = T extends unknown ? Omit<T, "id"> : never;

interface Pending {
  resolve: (res: NotationResponse) => void;
  reject: (err: Error) => void;
}

/**
 * Promise RPC over postMessage with request ids. The worker starts on the first call and is shared
 * by later ones. `preload()` is idempotent: concurrent calls share one promise, and a failed load
 * (which discards the worker) can be retried.
 */
export function createNotationClient(options: NotationClientOptions = {}): NotationClient {
  const createWorker = options.createWorker ?? defaultWorker;
  let worker: WorkerLike | undefined;
  let loading: Promise<void> | undefined;
  let nextId = 1;
  const pending = new Map<number, Pending>();

  function stop(reason: Error): void {
    worker?.terminate();
    worker = undefined;
    loading = undefined;
    const all = [...pending.values()];
    pending.clear();
    for (const p of all) p.reject(reason);
  }

  function ensureWorker(): WorkerLike {
    if (worker) return worker;
    const w = createWorker();
    w.onmessage = (event) => {
      const msg = event.data;
      const p = pending.get(msg.id);
      if (!p) return;
      pending.delete(msg.id);
      p.resolve(msg);
    };
    w.onerror = (event) => {
      // A script that fails to load or throws at top level kills the worker for good.
      const text = event.message ?? "";
      stop(new NotationLoadError(text.length > 0 ? text : "The notation worker failed"));
    };
    worker = w;
    return w;
  }

  function call(req: WithoutId<NotationRequest>): Promise<NotationResponse> {
    const w = ensureWorker();
    const id = nextId++;
    return new Promise<NotationResponse>((resolve, reject) => {
      pending.set(id, { resolve, reject });
      w.postMessage({ ...req, id });
    });
  }

  function preload(): Promise<void> {
    loading ??= (async () => {
      let res: NotationResponse;
      try {
        res = await call({ type: "preload" });
      } catch (err) {
        loading = undefined;
        if (err instanceof NotationLoadError) throw err;
        throw new NotationLoadError("Could not start the notation worker", { cause: err });
      }
      if (res.type === "error") {
        // Drop the worker so a retry starts from scratch.
        const err = new NotationLoadError(res.message);
        stop(err);
        throw err;
      }
    })();
    return loading;
  }

  return {
    preload,
    async render(score: ScoreSpec, opts: { widthPx: number }) {
      await preload();
      const res = await call({ type: "render", score, widthPx: opts.widthPx });
      if (res.type === "error") throw new Error(res.message);
      if (res.type !== "rendered") throw new Error("Unexpected notation response");
      return { svg: res.svg, noteIds: res.noteIds };
    },
    dispose() {
      stop(new Error("Notation client disposed"));
    },
  };
}
