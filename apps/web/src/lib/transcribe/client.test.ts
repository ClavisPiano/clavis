import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createBasicPitchTranscriber, MODEL_URL, type WorkerLike } from "./client";
import type { WorkerReply, WorkerRequest } from "./messages";

class FakeWorker implements WorkerLike {
  readonly requests: WorkerRequest[] = [];
  terminated = false;
  #message: ((event: MessageEvent<WorkerReply>) => void) | undefined;
  #error: (() => void) | undefined;
  postMessage(message: WorkerRequest): void {
    this.requests.push(message);
  }
  addEventListener(type: string, listener: unknown): void {
    if (type === "message") this.#message = listener as (e: MessageEvent<WorkerReply>) => void;
    else this.#error = listener as () => void;
  }
  terminate(): void {
    this.terminated = true;
  }
  reply(data: unknown): void {
    this.#message?.({ data } as MessageEvent<WorkerReply>);
  }
  crash(): void {
    this.#error?.();
  }
}

const samples = new Float32Array(22050);

function setup(timeoutMs = 1000) {
  const workers: FakeWorker[] = [];
  const t = createBasicPitchTranscriber(
    () => {
      const w = new FakeWorker();
      workers.push(w);
      return w;
    },
    { timeoutMs },
  );
  return { t, workers };
}

describe("createBasicPitchTranscriber", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("starts its worker on the first take and sends the model url with a copy of the samples", async () => {
    const { t, workers } = setup();
    expect(workers).toHaveLength(0);
    const p = t.transcribe(samples, 22050);
    expect(workers).toHaveLength(1);
    const req = workers[0]?.requests[0];
    expect(req?.modelUrl).toBe(MODEL_URL);
    expect(req?.sampleRate).toBe(22050);
    expect(req?.samples).not.toBe(samples);
    const note = { startSec: 0.5, durationSec: 1, midi: 60, amplitude: 0.9 };
    workers[0]?.reply({ id: req?.id, ok: true, notes: [note], backend: "webgl" });
    expect(await p).toEqual([note]);
    expect(t.last).toMatchObject({ ok: true, backend: "webgl", notes: 1, seconds: 1 });
  });

  it("rejects with the worker's error and records the failure", async () => {
    const { t, workers } = setup();
    const p = t.transcribe(samples, 22050);
    const id = workers[0]?.requests[0]?.id;
    workers[0]?.reply({ id, ok: false, error: "model failed" });
    await expect(p).rejects.toThrow("model failed");
    expect(t.last).toMatchObject({ ok: false, notes: 0 });
  });

  it("ignores a reply that does not match the schema", async () => {
    const { t, workers } = setup(500);
    const p = t.transcribe(samples, 22050);
    const id = workers[0]?.requests[0]?.id;
    workers[0]?.reply({ id, ok: true, notes: [{ midi: "sixty" }], backend: "cpu" });
    workers[0]?.reply("garbage");
    const settled = expect(p).rejects.toThrow("timed out");
    await vi.advanceTimersByTimeAsync(500);
    await settled;
  });

  it("times out, terminates a stuck worker and starts a fresh one for the next take", async () => {
    const { t, workers } = setup(500);
    const p = t.transcribe(samples, 22050);
    const settled = expect(p).rejects.toThrow("timed out");
    await vi.advanceTimersByTimeAsync(500);
    await settled;
    expect(workers[0]?.terminated).toBe(true);
    void t.transcribe(samples, 22050);
    expect(workers).toHaveLength(2);
  });

  it("settles every pending take when the worker crashes", async () => {
    const { t, workers } = setup();
    const a = expect(t.transcribe(samples, 22050)).rejects.toThrow("stopped");
    const b = expect(t.transcribe(samples, 22050)).rejects.toThrow("stopped");
    workers[0]?.crash();
    await a;
    await b;
    expect(workers[0]?.terminated).toBe(true);
  });

  it("dispose stops the worker", async () => {
    const { t, workers } = setup();
    const a = expect(t.transcribe(samples, 22050)).rejects.toThrow("stopped");
    t.dispose();
    await a;
    expect(workers[0]?.terminated).toBe(true);
  });
});
