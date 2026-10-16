import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { eventFixtures } from "../events/fixtures/index.js";
import type { ContentImported } from "../events/learning.js";
import type { LearningEvent } from "../events/schema.js";
import { allPieces, listPieces } from "../pieces/list.js";
import { UserPieceSchema, userPieceId } from "../pieces/schema.js";
import { applyEvent, foldEvents, initialState } from "./reduce.js";
import { makeSnapshot, restoreSnapshot } from "./snapshot.js";
import { FIXTURE_GRAPH, T0, ctx } from "./test-helpers.js";

const C = ctx(FIXTURE_GRAPH);
const fixture = eventFixtures["content.imported"] as ContentImported;

const ULIDS = [
  "01JBX00000000000000000B001",
  "01JBX00000000000000000B002",
  "01JBX00000000000000000B003",
];

/** An import of piece `n` (0-2) at time `at`, with a distinct event id and title. */
function imported(n: number, at: number, title: string, eventN: number): ContentImported {
  return {
    ...fixture,
    id: `01JBX0000000000000000E${String(eventN).padStart(4, "0")}`,
    at,
    pieceId: userPieceId(ULIDS[n] ?? ""),
    title,
  };
}

const shuffle = <T>(xs: readonly T[], keys: readonly number[]): T[] =>
  xs
    .map((x, i) => ({ x, k: keys[i] ?? 0 }))
    .sort((a, b) => a.k - b.k)
    .map((e) => e.x);

describe("imported pieces state", () => {
  it("starts empty and lists an imported piece with its score and title", () => {
    expect(initialState(C).imported).toEqual({});
    const e = imported(0, T0, "My tune", 1);
    const state = foldEvents([e], C);
    const rec = state.imported[e.pieceId];
    expect(rec?.piece.title).toBe("My tune");
    expect(rec?.piece.score).toEqual(e.score);
    expect(rec?.piece.phrases).toEqual(e.phrases);
    expect(rec?.piece.requiredNodeIds).toEqual([]);
    expect(rec?.source).toBe("musicxml");
    expect(UserPieceSchema.safeParse(rec?.piece).success).toBe(true);
  });

  it("is unlocked at once and ahead of the library, oldest import first", () => {
    const late = imported(1, T0 + 5000, "Second", 2);
    const early = imported(0, T0 + 1000, "First", 1);
    const state = foldEvents([late, early], C);
    const library = [fixturePiece()];
    const pieces = allPieces(library, state);
    expect(pieces.map((p) => p.title)).toEqual(["First", "Second", "piece.lib"]);
    const listed = listPieces(pieces, state);
    expect(listed.map((s) => s.unlocked)).toEqual([true, true, false]);
  });

  it("keeps the last write by (at, id) when a pieceId is imported twice", () => {
    const a = imported(0, T0 + 1000, "Old title", 1);
    const b = imported(0, T0 + 2000, "New title", 2);
    for (const events of [
      [a, b],
      [b, a],
    ]) {
      const state = foldEvents(events, C);
      expect(Object.keys(state.imported)).toEqual([a.pieceId]);
      expect(state.imported[a.pieceId]?.piece.title).toBe("New title");
    }
    // Same time: the larger id wins.
    const c = imported(0, T0 + 3000, "Tie low", 3);
    const d = imported(0, T0 + 3000, "Tie high", 4);
    expect(foldEvents([d, c], C).imported[a.pieceId]?.piece.title).toBe("Tie high");
  });

  it("ignores a stale event applied after a newer one", () => {
    const newer = imported(0, T0 + 2000, "New title", 2);
    const older = imported(0, T0 + 1000, "Old title", 1);
    const state = applyEvent(foldEvents([newer], C), older, C);
    expect(state.imported[older.pieceId]?.piece.title).toBe("New title");
  });

  it("does not disturb other state and survives a snapshot round trip", () => {
    const e = imported(0, T0, "My tune", 1);
    const state = foldEvents([e], C);
    expect(state.eventCount).toBe(1);
    expect(state.warnings).toBe(0);
    const snap = makeSnapshot(state, C.graph.contentVersion);
    expect(restoreSnapshot(snap, C.graph.contentVersion)).toEqual(state);
  });

  it("refold is order independent and idempotent (property)", () => {
    const events = fc.array(
      fc.record({
        piece: fc.integer({ min: 0, max: 2 }),
        at: fc.integer({ min: 0, max: 4 }),
        title: fc.constantFrom("A", "B", "C", "D"),
      }),
      { minLength: 1, maxLength: 8 },
    );
    fc.assert(
      fc.property(events, fc.array(fc.nat(), { minLength: 8, maxLength: 8 }), (specs, keys) => {
        const list: LearningEvent[] = specs.map((s, i) =>
          imported(s.piece, T0 + s.at * 1000, s.title, i + 1),
        );
        const a = foldEvents(list, C);
        const b = foldEvents(shuffle(list, keys), C);
        expect(b).toEqual(a);
        // Replaying every event twice changes nothing.
        expect(foldEvents([...list, ...list], C)).toEqual(a);
        // The winner of each id is its latest event by (at, id).
        for (const [id, rec] of Object.entries(a.imported)) {
          const mine = list.filter((e) => e.type === "content.imported" && e.pieceId === id);
          const last = [...mine].sort((x, y) => x.at - y.at || (x.id < y.id ? -1 : 1)).pop();
          expect(rec.eventId).toBe(last?.id);
        }
      }),
    );
  });
});

function fixturePiece() {
  return {
    id: "piece.lib",
    title: "piece.lib",
    source: "x",
    score: fixture.score,
    phrases: fixture.phrases,
    requiredNodeIds: ["n1"],
    difficulty: 1,
  };
}
