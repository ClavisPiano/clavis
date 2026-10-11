import { describe, expect, it } from "vitest";
import { FIXTURE_BASS_F3_G_MAJOR } from "@clavis/core";
import { NotationLoadError, createNotationClient, type WorkerLike } from "./client";
import type { NotationRequest, NotationResponse } from "./protocol";

/** A worker whose replies the test drives by hand. */
class FakeWorker implements WorkerLike {
  readonly requests: NotationRequest[] = [];
  terminated = false;
  onmessage: ((event: { data: NotationResponse }) => void) | null = null;
  onerror: ((event: { message?: string }) => void) | null = null;
  postMessage(message: NotationRequest): void {
    this.requests.push(message);
  }
  terminate(): void {
    this.terminated = true;
  }
  reply(msg: NotationResponse): void {
    this.onmessage?.({ data: msg });
  }
}

function setup() {
  const workers: FakeWorker[] = [];
  const client = createNotationClient({
    createWorker: () => {
      const w = new FakeWorker();
      workers.push(w);
      return w;
    },
  });
  return { client, workers };
}

describe("createNotationClient", () => {
  it("starts no worker until it is used", () => {
    const { workers } = setup();
    expect(workers).toHaveLength(0);
  });

  it("preload is idempotent: concurrent calls share one request", async () => {
    const { client, workers } = setup();
    const a = client.preload();
    const b = client.preload();
    expect(workers).toHaveLength(1);
    expect(workers[0]?.requests).toHaveLength(1);
    workers[0]?.reply({ id: 1, type: "ready" });
    await Promise.all([a, b]);
    await client.preload();
    expect(workers[0]?.requests).toHaveLength(1);
  });

  it("a failed load throws NotationLoadError and can be retried with a fresh worker", async () => {
    const { client, workers } = setup();
    const first = client.preload();
    workers[0]?.reply({ id: 1, type: "error", message: "wasm failed" });
    const err = await first.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NotationLoadError);
    expect((err as Error).message).toContain("wasm failed");
    expect(workers[0]?.terminated).toBe(true);

    const second = client.preload();
    expect(workers).toHaveLength(2);
    workers[1]?.reply({ id: 2, type: "ready" });
    await second;
  });

  it("a worker script error rejects preload with NotationLoadError", async () => {
    const { client, workers } = setup();
    const p = client.preload();
    workers[0]?.onerror?.({ message: "failed to fetch module" });
    await expect(p).rejects.toBeInstanceOf(NotationLoadError);
  });

  it("matches render replies to requests by id", async () => {
    const { client, workers } = setup();
    const load = client.preload();
    workers[0]?.reply({ id: 1, type: "ready" });
    await load;

    const a = client.render(FIXTURE_BASS_F3_G_MAJOR, { widthPx: 300 });
    const b = client.render(FIXTURE_BASS_F3_G_MAJOR, { widthPx: 600 });
    await Promise.resolve();
    const reqs = workers[0]?.requests.filter((r) => r.type === "render") ?? [];
    expect(reqs).toHaveLength(2);
    // Answer out of order.
    workers[0]?.reply({ id: reqs[1]?.id ?? 0, type: "rendered", svg: "<svg>b</svg>", noteIds: [] });
    workers[0]?.reply({
      id: reqs[0]?.id ?? 0,
      type: "rendered",
      svg: "<svg>a</svg>",
      noteIds: ["n1"],
    });
    expect((await a).svg).toBe("<svg>a</svg>");
    expect((await b).svg).toBe("<svg>b</svg>");
  });

  it("a render error is a plain error, not a load error", async () => {
    const { client, workers } = setup();
    const load = client.preload();
    workers[0]?.reply({ id: 1, type: "ready" });
    await load;
    const r = client.render(FIXTURE_BASS_F3_G_MAJOR, { widthPx: 300 });
    await Promise.resolve();
    workers[0]?.reply({ id: 2, type: "error", message: "bad score" });
    const err = await r.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(NotationLoadError);
  });
});
