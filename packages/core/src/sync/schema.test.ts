import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  MAX_PUSH_BATCH,
  PullRequest,
  PullResponse,
  PushRequest,
  PushResponse,
  SyncEnvelope,
} from "./schema.js";

const base = { id: "01ARYZ6S410000000000000000", deviceId: "dev1", at: 1_700_000_000_000, v: 1 };
const device = { ...base, type: "device.registered", platform: "web" };

describe("SyncEnvelope", () => {
  it("accepts known events", () => {
    expect(SyncEnvelope.safeParse(device).success).toBe(true);
  });

  it("accepts unknown types and versions that pass the envelope schema", () => {
    expect(SyncEnvelope.safeParse({ ...base, type: "future.thing", extra: [1] }).success).toBe(
      true,
    );
    expect(SyncEnvelope.safeParse({ ...device, v: 99 }).success).toBe(true);
  });

  it("keeps unknown payload fields", () => {
    const r = SyncEnvelope.parse({ ...base, type: "future.thing", extra: [1] });
    expect(r).toEqual({ ...base, type: "future.thing", extra: [1] });
  });

  it("rejects malformed known events", () => {
    expect(SyncEnvelope.safeParse({ ...device, platform: 3 }).success).toBe(false);
    expect(SyncEnvelope.safeParse({ ...device, unexpected: 1 }).success).toBe(false);
  });

  it("rejects bad envelopes and userId", () => {
    for (const bad of [
      null,
      {},
      { ...device, id: "nope" },
      { ...device, deviceId: "" },
      { ...device, at: 1.5 },
      { ...device, v: 0 },
      { ...base, type: 3 },
      { ...device, userId: "u1" },
      { ...base, type: "future.thing", userId: "u1" },
    ]) {
      expect(SyncEnvelope.safeParse(bad).success).toBe(false);
    }
  });
});

describe("PushRequest", () => {
  it("round-trips and enforces the batch cap", () => {
    const req = { events: [device] };
    expect(PushRequest.parse(JSON.parse(JSON.stringify(req)))).toEqual(req);
    expect(PushRequest.safeParse({ events: [] }).success).toBe(true);
    const many = Array.from({ length: MAX_PUSH_BATCH + 1 }, () => device);
    expect(PushRequest.safeParse({ events: many }).success).toBe(false);
    expect(PushRequest.safeParse({ events: [device], extra: 1 }).success).toBe(false);
    expect(PushRequest.safeParse({}).success).toBe(false);
  });
});

describe("responses", () => {
  it("round-trip push and pull responses", () => {
    const push = { accepted: 1, duplicates: 2, lastSeq: 3 };
    expect(PushResponse.parse(JSON.parse(JSON.stringify(push)))).toEqual(push);
    const pull = {
      events: [{ serverSeq: 1, receivedAt: 5, event: device }],
      lastSeq: 1,
      hasMore: false,
    };
    expect(PullResponse.parse(JSON.parse(JSON.stringify(pull)))).toEqual(pull);
    expect(PushResponse.safeParse({ accepted: -1, duplicates: 0, lastSeq: 0 }).success).toBe(false);
  });

  it("round-trips arbitrary push responses (property)", () => {
    fc.assert(
      fc.property(fc.nat(), fc.nat(), fc.nat(), (accepted, duplicates, lastSeq) => {
        const r = { accepted, duplicates, lastSeq };
        expect(PushResponse.parse(JSON.parse(JSON.stringify(r)))).toEqual(r);
      }),
    );
  });
});

describe("PullRequest", () => {
  it("coerces query strings and bounds values", () => {
    expect(PullRequest.parse({ after: "5", limit: "10" })).toEqual({ after: 5, limit: 10 });
    expect(PullRequest.parse({ after: "0" })).toEqual({ after: 0 });
    for (const bad of [
      { after: "-1" },
      { after: "1.5" },
      { after: "abc" },
      { after: "0", limit: "0" },
      { after: "0", limit: "1001" },
      {},
    ]) {
      expect(PullRequest.safeParse(bad).success).toBe(false);
    }
  });
});
