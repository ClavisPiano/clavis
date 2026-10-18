import {
  createUlidGenerator,
  type BenchmarkRecord,
  type BenchmarkRecorded,
  type LearnerState,
} from "@clavis/core";
import type { BlobMeta, PutBlobInput } from "@clavis/store";
import { describe, expect, it, vi } from "vitest";
import {
  ORPHAN_GRACE_MS,
  orphanBenchmarkBlobs,
  saveBenchmark,
  type SaveBenchmarkDeps,
} from "./save";
import type { Take } from "./recorder";

/** 2026-10-17T12:00:00Z */
const NOW = 1_792_238_400_000;

function setup(opts: { signedIn?: boolean; failAppend?: boolean; failRemote?: boolean } = {}) {
  const stored = new Map<string, PutBlobInput>();
  const appended: BenchmarkRecorded[] = [];
  const remoteDeleted: string[] = [];
  let seed = 0;
  const deps: SaveBenchmarkDeps = {
    blobs: {
      put: (input) => {
        stored.set(input.key, input);
        return Promise.resolve({ evicted: [] });
      },
      delete: (key) => {
        stored.delete(key);
        return Promise.resolve();
      },
    },
    append: (events) => {
      if (opts.failAppend) return Promise.reject(new Error("disk full"));
      appended.push(...events);
      return Promise.resolve({} as LearnerState);
    },
    deleteRemote: opts.signedIn
      ? (key) => {
          if (opts.failRemote) return Promise.reject(new Error("offline"));
          remoteDeleted.push(key);
          return Promise.resolve();
        }
      : undefined,
    deviceId: "dev-test",
    newId: createUlidGenerator({
      now: () => NOW,
      randomBytes: (n) => new Uint8Array(n).fill(++seed),
    }),
    now: () => NOW,
    tzOffsetMin: 600,
  };
  return { deps, stored, appended, remoteDeleted };
}

const take = (n = 12): Take => ({
  blob: new Blob([new Uint8Array(n)], { type: "audio/webm" }),
  contentType: "audio/webm",
  durationMs: 61_000,
});

const previous: BenchmarkRecord = {
  benchmarkId: "01JBX00000000000000000BM01",
  pieceId: "piece.hot-cross-buns",
  month: "2026-10",
  blobKey: "benchmark-01JBX00000000000000000BM01.webm",
  contentType: "audio/webm",
  durationMs: 30_000,
  sizeBytes: 100,
  at: NOW - 86_400_000,
  eventId: "01JBX00000000000000000E001",
};

describe("saveBenchmark", () => {
  it("stores the take pinned and logs benchmark.recorded for the local month", async () => {
    const { deps, stored, appended } = setup();
    const { event, replaced } = await saveBenchmark(
      deps,
      { benchmarks: {} },
      "piece.ode-to-joy",
      take(),
    );
    expect(replaced).toBeUndefined();
    expect(event).toMatchObject({
      type: "benchmark.recorded",
      v: 1,
      deviceId: "dev-test",
      at: NOW,
      pieceId: "piece.ode-to-joy",
      month: "2026-10",
      contentType: "audio/webm",
      durationMs: 61_000,
      sizeBytes: 12,
    });
    expect(event.blobKey).toBe(`benchmark-${event.benchmarkId}.webm`);
    expect(appended).toEqual([event]);
    expect(stored.get(event.blobKey)).toMatchObject({ pinned: true, contentType: "audio/webm" });
  });

  it("replacing this month's take deletes the old audio here and on the server", async () => {
    const { deps, stored, remoteDeleted } = setup({ signedIn: true });
    stored.set(previous.blobKey, { key: previous.blobKey, blob: new Blob(["x"]) });
    const { replaced, event } = await saveBenchmark(
      deps,
      { benchmarks: { "2026-10": previous } },
      "piece.ode-to-joy",
      take(),
    );
    expect(replaced).toEqual(previous);
    expect([...stored.keys()]).toEqual([event.blobKey]);
    expect(remoteDeleted).toEqual([previous.blobKey]);
  });

  it("signed out, only the local copy is deleted; a server failure is not fatal", async () => {
    const out = setup();
    await saveBenchmark(
      out.deps,
      { benchmarks: { "2026-10": previous } },
      "piece.ode-to-joy",
      take(),
    );
    expect(out.remoteDeleted).toEqual([]);

    const failing = setup({ signedIn: true, failRemote: true });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const r = await saveBenchmark(
      failing.deps,
      { benchmarks: { "2026-10": previous } },
      "piece.ode-to-joy",
      take(),
    );
    expect(r.replaced).toEqual(previous);
    expect(failing.appended).toHaveLength(1);
    warn.mockRestore();
  });

  it("an earlier month's take is kept", async () => {
    const { deps, remoteDeleted } = setup({ signedIn: true });
    const september = { ...previous, month: "2026-09" };
    const r = await saveBenchmark(
      deps,
      { benchmarks: { "2026-09": september } },
      "piece.ode-to-joy",
      take(),
    );
    expect(r.replaced).toBeUndefined();
    expect(remoteDeleted).toEqual([]);
  });

  it("drops the stored audio when the event cannot be logged", async () => {
    const { deps, stored } = setup({ failAppend: true });
    await expect(
      saveBenchmark(deps, { benchmarks: {} }, "piece.ode-to-joy", take()),
    ).rejects.toThrow("disk full");
    expect(stored.size).toBe(0);
  });

  it("rejects an invalid take before storing anything", async () => {
    const { deps, stored } = setup();
    await expect(
      saveBenchmark(deps, { benchmarks: {} }, "piece.ode-to-joy", {
        ...take(),
        durationMs: 200_000,
      }),
    ).rejects.toThrow();
    expect(stored.size).toBe(0);
  });
});

describe("orphanBenchmarkBlobs", () => {
  const meta = (key: string, createdAt: number): BlobMeta => ({
    key,
    contentType: "audio/webm",
    size: 1,
    createdAt,
    pinned: true,
    uploaded: true,
  });

  it("finds old benchmark audio that no kept benchmark names", () => {
    const old = NOW - ORPHAN_GRACE_MS - 1;
    const blobs = [
      meta(previous.blobKey, old),
      meta("benchmark-01JBX00000000000000000BM02.webm", old),
      meta("benchmark-01JBX00000000000000000BM03.webm", NOW - 1000),
      meta("take.webm", old),
    ];
    expect(orphanBenchmarkBlobs(blobs, { benchmarks: { "2026-10": previous } }, NOW)).toEqual([
      "benchmark-01JBX00000000000000000BM02.webm",
    ]);
  });
});
