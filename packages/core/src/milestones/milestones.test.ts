import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { LearningEvent } from "../events/schema.js";
import { compareEvents } from "../events/validate.js";
import { foldEvents, type LearnerState } from "../state/index.js";
import { Builder, DAY_MS, FIXTURE_GRAPH, T0, ctx } from "../state/test-helpers.js";
import { newMilestones, milestones, upcomingMilestones } from "./milestones.js";
import { MilestoneSchema, type Milestone } from "./schema.js";

const C = ctx();
const fold = (events: readonly LearningEvent[]): LearnerState => foldEvents(events, C);
const MORNING = T0 + 6 * 3_600_000;

const CONTENT: Milestone[] = [
  { nodeId: "n1", statement: "You can do the first thing." },
  { nodeId: "n2", statement: "You can do the second thing." },
  { nodeId: "n3", statement: "You can do the third thing." },
];

/** n1 mastered on the second day (sessions 1 and 2). */
function masterN1(b: Builder): LearningEvent[] {
  return [
    ...b.session(MORNING, 1, "n1", 3, { introduce: true }),
    ...b.session(MORNING + DAY_MS, 2, "n1", 3),
  ];
}

describe("MilestoneSchema", () => {
  it("accepts a statement and rejects empty, long and extra fields", () => {
    expect(MilestoneSchema.safeParse(CONTENT[0]).success).toBe(true);
    expect(MilestoneSchema.safeParse({ nodeId: "n1", statement: "" }).success).toBe(false);
    expect(MilestoneSchema.safeParse({ nodeId: "n1", statement: "x".repeat(141) }).success).toBe(
      false,
    );
    expect(MilestoneSchema.safeParse({ ...CONTENT[0], extra: 1 }).success).toBe(false);
  });
});

describe("milestones", () => {
  it("has none for a fresh learner or a node still being learned", () => {
    const b = new Builder();
    expect(milestones(fold([]), FIXTURE_GRAPH, CONTENT)).toEqual([]);
    const s = fold(b.session(MORNING, 1, "n1", 3, { introduce: true }));
    expect(milestones(s, FIXTURE_GRAPH, CONTENT)).toEqual([]);
  });

  it("gives exactly one milestone for a first mastery, with its time and learner day", () => {
    const b = new Builder();
    const events = masterN1(b);
    const s = fold(events);
    expect(s.nodes.n1?.state).toBe("mastered");
    const got = milestones(s, FIXTURE_GRAPH, CONTENT);
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({
      nodeId: "n1",
      title: "n1",
      statement: "You can do the first thing.",
      day: "2026-01-02",
    });
    // The mastering attempt is in the second session.
    expect(got[0]?.at).toBeGreaterThan(MORNING + DAY_MS);
  });

  it("skips mastered nodes that have no statement", () => {
    const b = new Builder();
    const s = fold(masterN1(b));
    expect(milestones(s, FIXTURE_GRAPH, CONTENT.slice(1))).toEqual([]);
  });

  it("counts a placement as mastery on the placement day", () => {
    const b = new Builder();
    const s = fold([b.place(MORNING, { n1: "mastered", n2: "fluent" })]);
    const got = milestones(s, FIXTURE_GRAPH, CONTENT);
    expect(got.map((m) => m.nodeId)).toEqual(["n1"]);
    expect(got[0]).toMatchObject({ at: MORNING, day: "2026-01-01" });
  });

  it("keeps the first date when a node drops from mastered and regains it", () => {
    const b = new Builder();
    const first = fold(masterN1(b));
    const firstAt = first.nodes.n1?.firstMastered;
    expect(firstAt).toBeDefined();

    // Four misses on day 3 drop it.
    const dropped = [
      ...masterN1(b),
      ...b.session(MORNING + 2 * DAY_MS, 3, "n1", 4, { correct: false }),
    ];
    const afterDrop = fold(dropped);
    expect(afterDrop.nodes.n1?.state).not.toBe("mastered");

    // Good answers over later days regain it.
    const regained = [
      ...dropped,
      ...b.session(MORNING + 3 * DAY_MS, 4, "n1", 4),
      ...b.session(MORNING + 4 * DAY_MS, 5, "n1", 4),
      ...b.session(MORNING + 5 * DAY_MS, 6, "n1", 4),
    ];
    const afterRegain = fold(regained);
    expect(afterRegain.nodes.n1?.state).toBe("mastered");
    expect(afterRegain.nodes.n1?.firstMastered).toEqual(firstAt);

    for (const s of [afterDrop, afterRegain]) {
      const got = milestones(s, FIXTURE_GRAPH, CONTENT);
      expect(got).toHaveLength(1);
      expect(got[0]).toMatchObject({ nodeId: "n1", at: firstAt?.at, day: firstAt?.day });
    }
  });

  it("orders oldest first", () => {
    const b = new Builder();
    const s = fold([
      ...masterN1(b),
      ...b.session(MORNING + 2 * DAY_MS, 3, "n2", 3, { introduce: true }),
      ...b.session(MORNING + 3 * DAY_MS, 4, "n2", 3),
    ]);
    expect(milestones(s, FIXTURE_GRAPH, CONTENT).map((m) => m.nodeId)).toEqual(["n1", "n2"]);
  });

  it("is independent of event order and duplicates (property)", () => {
    const b = new Builder();
    const events = [
      ...masterN1(b),
      ...b.session(MORNING + 2 * DAY_MS, 3, "n2", 3, { introduce: true }),
      ...b.session(MORNING + 3 * DAY_MS, 4, "n2", 3),
      ...b.session(MORNING + 4 * DAY_MS, 5, "n1", 4, { correct: false }),
    ];
    const expected = milestones(fold([...events].sort(compareEvents)), FIXTURE_GRAPH, CONTENT);
    expect(expected.length).toBeGreaterThan(0);
    fc.assert(
      fc.property(
        fc.shuffledSubarray(events, { minLength: events.length, maxLength: events.length }),
        fc.constantFrom(...events),
        (shuffled, dup) => {
          const withDup = [...shuffled, dup];
          expect(milestones(fold(withDup), FIXTURE_GRAPH, CONTENT)).toEqual(expected);
        },
      ),
      { numRuns: 50 },
    );
  });
});

describe("newMilestones", () => {
  const b = new Builder();
  const empty = fold([]);
  const mastered = fold(masterN1(b));
  const both = fold([
    ...masterN1(b),
    ...b.session(MORNING + 2 * DAY_MS, 3, "n2", 3, { introduce: true }),
    ...b.session(MORNING + 3 * DAY_MS, 4, "n2", 3),
  ]);
  const dropped = fold([
    ...masterN1(b),
    ...b.session(MORNING + 2 * DAY_MS, 3, "n1", 4, { correct: false }),
  ]);

  const ids = (before: LearnerState, after: LearnerState, content = CONTENT): string[] =>
    newMilestones(before, after, FIXTURE_GRAPH, content).map((m) => m.nodeId);

  it.each([
    ["nothing changed", empty, empty, []],
    ["first mastery", empty, mastered, ["n1"]],
    ["already earned before", mastered, mastered, []],
    ["a second node, not the first again", mastered, both, ["n2"]],
    ["two at once", empty, both, ["n1", "n2"]],
    ["a regained node is not new", mastered, dropped, []],
    ["a drop after the first mastery is not new", dropped, dropped, []],
  ] as const)("%s", (_name, before, after, expected) => {
    expect(ids(before, after)).toEqual(expected);
  });

  it("ignores nodes without a statement", () => {
    expect(ids(empty, both, CONTENT.slice(1))).toEqual(["n2"]);
  });
});

describe("upcomingMilestones", () => {
  it("lists fluent, then learning, nodes that are not yet mastered", () => {
    const b = new Builder();
    const s = fold([
      ...masterN1(b),
      ...b.session(MORNING + 2 * DAY_MS, 3, "n2", 3, { introduce: true }),
      b.place(MORNING + 3 * DAY_MS, { n3: "fluent" }),
    ]);
    const got = upcomingMilestones(s, FIXTURE_GRAPH, CONTENT);
    expect(got.map((m) => [m.nodeId, m.state])).toEqual([
      ["n3", "fluent"],
      ["n2", "learning"],
    ]);
    expect(upcomingMilestones(s, FIXTURE_GRAPH, CONTENT, 1)).toHaveLength(1);
  });
});
