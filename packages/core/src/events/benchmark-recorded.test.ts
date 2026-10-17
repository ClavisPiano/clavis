import { describe, expect, it } from "vitest";
import { MAX_BLOB_BYTES } from "../blobs/index.js";
import { eventFixtures } from "./fixtures/index.js";
import { MAX_BENCHMARK_MS } from "./learning.js";
import { eventRegistry, parseEvent } from "./schema.js";

type Obj = Record<string, unknown>;
const base = eventFixtures["benchmark.recorded"] as Obj;
const code = (patch: Obj): string => {
  const r = parseEvent({ ...base, ...patch });
  return r.ok ? "ok" : r.error.code;
};

describe("benchmark.recorded v1", () => {
  it("is registered at v1 and its fixture parses unchanged", () => {
    expect(Object.keys(eventRegistry["benchmark.recorded"].versions)).toEqual(["1"]);
    expect(parseEvent(base)).toEqual({ ok: true, event: base });
  });

  it.each<[string, Obj, string]>([
    [
      "mp4 take",
      { blobKey: "benchmark-01JBX00000000000000000BM01.m4a", contentType: "audio/mp4" },
      "ok",
    ],
    ["three minutes exactly", { durationMs: MAX_BENCHMARK_MS }, "ok"],
    ["largest blob", { sizeBytes: MAX_BLOB_BYTES }, "ok"],
    ["December", { month: "2025-12" }, "ok"],
    ["longer than three minutes", { durationMs: MAX_BENCHMARK_MS + 1 }, "invalid"],
    ["zero duration", { durationMs: 0 }, "invalid"],
    ["empty blob", { sizeBytes: 0 }, "invalid"],
    ["blob over the cap", { sizeBytes: MAX_BLOB_BYTES + 1 }, "invalid"],
    ["month 13", { month: "2025-13" }, "invalid"],
    ["a full date", { month: "2025-10-01" }, "invalid"],
    ["an imported piece", { pieceId: "piece.user-01jbx00000000000000000bm01" }, "invalid"],
    ["not a piece id", { pieceId: "ode" }, "invalid"],
    ["a codec parameter", { contentType: "audio/webm;codecs=opus" }, "invalid"],
    ["video", { contentType: "video/webm" }, "invalid"],
    [
      "blob key for another benchmark",
      { blobKey: "benchmark-01JBX00000000000000000BM02.webm" },
      "invalid",
    ],
    ["blob key without the prefix", { blobKey: "01JBX00000000000000000BM01.webm" }, "invalid"],
    ["blob key with a path", { blobKey: "a/benchmark-01JBX00000000000000000BM01.webm" }, "invalid"],
    ["not a ULID", { benchmarkId: "bm1" }, "invalid"],
    ["an unknown key", { userId: "u1" }, "invalid"],
    ["v2", { v: 2 }, "unknown_version"],
  ])("%s", (_name, patch, expected) => {
    expect(code(patch)).toBe(expected);
  });
});
