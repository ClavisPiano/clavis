import { describe, expect, it } from "vitest";
import { z } from "zod";
import { eventFixtures, legacyEventFixtures } from "./fixtures/index.js";
import {
  eventRegistry,
  parseEvent,
  parseEventWith,
  type EventRegistry,
  type LearningEvent,
} from "./schema.js";
import { MemoryEventStore } from "./memory-store.js";

type Obj = Record<string, unknown>;
const fx = (type: string): Obj => eventFixtures[type] as Obj;
const code = (input: unknown): string => {
  const r = parseEvent(input);
  return r.ok ? "ok" : r.error.code;
};
const withField = (type: string, patch: Obj): Obj => ({ ...fx(type), ...patch });

describe("fixtures", () => {
  it("has a fixture for every registered type", () => {
    expect(Object.keys(eventFixtures).sort()).toEqual(Object.keys(eventRegistry).sort());
  });

  it.each(Object.keys(eventFixtures))("%s parses and round-trips", (type) => {
    const first = parseEvent(eventFixtures[type]);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.event).toEqual(eventFixtures[type]);
    const second = parseEvent(JSON.parse(JSON.stringify(first.event)));
    expect(second).toEqual(first);
  });

  it("old v1 fixtures still parse and upcast to v2", () => {
    expect(legacyEventFixtures).toHaveLength(3);
    for (const old of legacyEventFixtures) {
      expect((old as Obj).v).toBe(1);
      const r = parseEvent(old);
      expect(r.ok).toBe(true);
      if (!r.ok) continue;
      expect(r.event).toEqual({ ...(old as Obj), v: 2 });
    }
  });

  it("are all accepted by a store", async () => {
    const store = new MemoryEventStore();
    const events = Object.values(eventFixtures) as LearningEvent[];
    expect(await store.append(events)).toEqual({ inserted: events.length });
  });

  it("does not ship node.transitioned or task.completed (M5)", () => {
    expect(Object.keys(eventRegistry)).not.toContain("node.transitioned");
    expect(Object.keys(eventRegistry)).not.toContain("task.completed");
  });
});

describe("learning event negatives", () => {
  it("rejects wrong session mode and key mode", () => {
    expect(code(withField("session.started", { mode: "solo" }))).toBe("invalid");
    expect(code(withField("session.started", { key: { tonic: "C", mode: "dorian" } }))).toBe(
      "invalid",
    );
    expect(code(withField("session.started", { key: { tonic: "H", mode: "major" } }))).toBe(
      "invalid",
    );
    expect(code(withField("session.started", { key: { tonic: "C#", mode: "major" } }))).toBe(
      "invalid",
    );
    expect(code(withField("session.started", { key: { tonic: "C#", mode: "minor" } }))).toBe("ok");
    expect(code(withField("session.started", { tzOffsetMin: 841 }))).toBe("invalid");
    expect(code(withField("session.started", { budgetSec: 0 }))).toBe("invalid");
  });

  it("rejects negative latency, bad retries and partial > 1", () => {
    const outcome = (o: Obj): Obj => ({
      outcome: { correct: true, latencyMs: 100, retries: 0, ...o },
    });
    expect(code(withField("attempt.completed", outcome({ latencyMs: -1 })))).toBe("invalid");
    expect(code(withField("attempt.completed", outcome({ retries: -1 })))).toBe("invalid");
    expect(code(withField("attempt.completed", outcome({ retries: 1.5 })))).toBe("invalid");
    expect(code(withField("attempt.completed", outcome({ partial: 1.01 })))).toBe("invalid");
    expect(code(withField("attempt.completed", outcome({ partial: 1 })))).toBe("ok");
    expect(code(withField("attempt.completed", { subScores: { sing: 2 } }))).toBe("invalid");
    expect(code(withField("attempt.completed", { inputSource: "voice" }))).toBe("invalid");
  });

  it("rejects an unknown block or generator", () => {
    expect(code(withField("item.presented", { block: "warmup" }))).toBe("invalid");
    expect(code(withField("item.presented", { generator: "nope" }))).toBe("invalid");
  });

  it("rejects non-ULID session and placement ids", () => {
    for (const type of ["session.started", "item.presented", "session.ended"]) {
      expect(code(withField(type, { sessionId: "session-1" }))).toBe("invalid");
    }
    expect(code(withField("placement.completed", { placementId: "p1" }))).toBe("invalid");
  });

  it("rejects extra keys, including nested ones", () => {
    for (const type of Object.keys(eventFixtures)) {
      expect(code(withField(type, { userId: "u1" }))).toBe("invalid");
    }
    expect(code(withField("session.started", { key: { tonic: "C", mode: "major", x: 1 } }))).toBe(
      "invalid",
    );
    expect(
      code(
        withField("attempt.completed", {
          outcome: { correct: true, latencyMs: 1, retries: 0, x: 1 },
        }),
      ),
    ).toBe("invalid");
    expect(code(withField("attempt.completed", { errors: [{ code: "a", extra: 1 }] }))).toBe(
      "invalid",
    );
  });

  it("rejects non-JSON presentation values", () => {
    const bad: unknown[] = [
      { n: Number.NaN },
      { n: Number.POSITIVE_INFINITY },
      { f: () => 1 },
      { u: undefined },
      { d: new Date(0) },
      { nested: { deep: [1, Number.NaN] } },
      { s: Symbol("x") },
      { b: 1n },
    ];
    for (const presentation of bad) {
      expect(code(withField("item.presented", { presentation }))).toBe("invalid");
    }
    expect(code(withField("item.presented", { presentation: [1] }))).toBe("invalid");
    expect(code(withField("item.presented", { presentation: {} }))).toBe("ok");
  });

  it("rejects non-JSON error detail", () => {
    expect(
      code(withField("attempt.completed", { errors: [{ code: "a", detail: { n: Number.NaN } }] })),
    ).toBe("invalid");
  });

  it("rejects bad placement results", () => {
    expect(code(withField("placement.completed", { results: { n1: "locked" } }))).toBe("invalid");
    expect(code(withField("placement.completed", { results: { n1: "mastered" } }))).toBe("ok");
  });

  it("rejects bad piece.completed values", () => {
    expect(code(withField("piece.completed", { pieceId: "hot-cross-buns" }))).toBe("invalid");
    expect(code(withField("piece.completed", { pieceId: "piece.Hot_Cross" }))).toBe("invalid");
    expect(code(withField("piece.completed", { phrases: 0, correctPhrases: 0 }))).toBe("invalid");
    expect(code(withField("piece.completed", { phrases: 2, correctPhrases: 3 }))).toBe("invalid");
    expect(code(withField("piece.completed", { correctPhrases: -1 }))).toBe("invalid");
    expect(code(withField("piece.completed", { phrases: 2.5 }))).toBe("invalid");
    expect(code(withField("piece.completed", { phrases: 4, correctPhrases: 3 }))).toBe("ok");
    expect(code(withField("piece.completed", { extra: true }))).toBe("invalid");
  });

  it("rejects bad node.introduced and session.ended values", () => {
    expect(code(withField("node.introduced", { keyFamily: "D" }))).toBe("invalid");
    expect(code(withField("session.ended", { reason: "crashed" }))).toBe("invalid");
  });
});

describe("upcasters (test-only registry)", () => {
  const base = { id: "01JBX00000000000000000A001", deviceId: "d", at: 1 };
  const V1 = z.strictObject({
    ...base,
    id: z.string(),
    deviceId: z.string(),
    at: z.int(),
    type: z.literal("fake.thing"),
    v: z.literal(1),
    name: z.string(),
  });
  const V2 = z.strictObject({
    id: z.string(),
    deviceId: z.string(),
    at: z.int(),
    type: z.literal("fake.thing"),
    v: z.literal(2),
    label: z.string(),
    count: z.int(),
  });
  const registry: EventRegistry = {
    "fake.thing": {
      versions: { 1: V1, 2: V2 },
      upcast: (event, from) => {
        if (from === 2) return event;
        const { name, ...rest } = event as Obj & { name: string };
        return { ...rest, v: 2, label: name, count: 0 };
      },
    },
  };
  const v1 = { ...base, type: "fake.thing", v: 1, name: "hello" };
  const v2 = { ...base, type: "fake.thing", v: 2, label: "hello", count: 3 };

  it("upcasts v1 fixtures to v2", () => {
    expect(parseEventWith(registry, v1)).toEqual({
      ok: true,
      event: { ...base, type: "fake.thing", v: 2, label: "hello", count: 0 },
    });
  });

  it("passes latest-version events through unchanged", () => {
    expect(parseEventWith(registry, v2)).toEqual({ ok: true, event: v2 });
  });

  it("rejects unknown versions and invalid payloads", () => {
    const r = parseEventWith(registry, { ...v1, v: 3 });
    expect(r.ok ? "ok" : r.error.code).toBe("unknown_version");
    const bad = parseEventWith(registry, { ...v1, name: 5 });
    expect(bad.ok ? "ok" : bad.error.code).toBe("invalid");
    const old = parseEventWith(registry, { ...v1, label: "x" });
    expect(old.ok ? "ok" : old.error.code).toBe("invalid");
    const unk = parseEventWith(registry, { ...v1, type: "other" });
    expect(unk.ok ? "ok" : unk.error.code).toBe("unknown_type");
  });

  it("fails if an upcaster produces a shape the latest schema rejects", () => {
    const broken: EventRegistry = {
      "fake.thing": { versions: { 1: V1, 2: V2 }, upcast: (e) => e },
    };
    const r = parseEventWith(broken, v1);
    expect(r.ok ? "ok" : r.error.code).toBe("invalid");
  });
});
