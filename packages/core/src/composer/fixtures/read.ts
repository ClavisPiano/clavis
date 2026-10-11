import type { GeneratorId, NodeState, SkillGraph, SkillNode } from "../../graph/schema.js";
import { familyOfParams, keyForFamily } from "../../items/family.js";
import { itemId } from "../../items/ids.js";
import type { Generator, ItemParams } from "../../items/types.js";
import { createScheduler } from "../../scheduler/scheduler.js";
import { initialState } from "../../state/reduce.js";
import type { LearnerState } from "../../state/types.js";
import type { Key } from "../../theory/keys.js";
import {
  FIXTURE_BASS_F3_G_MAJOR,
  spelledToMidi,
  type ScoreSpec,
  type Step,
} from "../../score/index.js";
import { NOW } from "./learners.js";
import { V1_GRAPH } from "./graph.js";

/*
 * Test-only READ fixtures: the real `bassNoteRead` and `rhythmRead` generators are not registered
 * until T3.15, so the composer tests inject simple stubs and a graph that marks them implemented.
 */

export const LANDMARKS = "read.bass.landmarks";
export const STEPS = "read.bass.steps";
export const RHYTHM = "read.rhythm.basic";

const FAMILIES = ["A", "B", "C"] as const;
const POSITIONS: Record<string, string[]> = {
  [LANDMARKS]: ["C2", "F3", "C4", "G2"],
  [STEPS]: ["D2", "E3", "B3", "A2"],
};

function stubDisplay(pos: string, key: Key): ScoreSpec {
  const step = pos.slice(0, 1) as Step;
  const octave = Number(pos.slice(1));
  return {
    ...FIXTURE_BASS_F3_G_MAJOR,
    staves: [
      {
        clef: "bass",
        lines: 5,
        measures: [
          [
            {
              kind: "note",
              id: "n1",
              pitches: [{ step, alter: 0, octave }],
              duration: { value: 1, dots: 0 },
            },
          ],
        ],
      },
    ],
    key,
  };
}

/** Stub: family times positions for key-dependent nodes (R15), exactPitch with a display. */
const stub = (id: GeneratorId, keyDependent: boolean): Generator => ({
  id,
  listItems(node: SkillNode): ItemParams[] {
    if (!keyDependent) return [1, 2, 3, 4].map((n) => ({ pattern: n }));
    const positions = POSITIONS[node.id] ?? POSITIONS[LANDMARKS] ?? [];
    return FAMILIES.flatMap((fam) => positions.map((pos) => ({ fam, pos })));
  },
  generate(node, params, ctx) {
    const fam = familyOfParams(params) ?? "A";
    const key = keyForFamily(fam, "major", ctx.preferredKey, ctx.rng);
    const pos = typeof params.pos === "string" ? params.pos : "C3";
    const midi = spelledToMidi({
      step: pos.slice(0, 1) as Step,
      alter: 0,
      octave: Number(pos.slice(1)),
    });
    return {
      itemId: itemId(node.id, params),
      nodeId: node.id,
      generator: id,
      params,
      presentation: { tonic: key.tonic, mode: key.mode, pos, fam },
      stimulus: { events: [] },
      expected: { play: { kind: "exactPitch", targetMidi: midi }, responseWindowMs: 6000 },
      display: stubDisplay(pos, key),
    };
  },
});

export const STUB_READ_GENERATORS: Partial<Record<GeneratorId, Generator>> = {
  bassNoteRead: stub("bassNoteRead", true),
  rhythmRead: stub("rhythmRead", false),
};

const readNode = (proto: SkillNode, extra: Partial<SkillNode> & { id: string }): SkillNode => ({
  ...proto,
  ...extra,
});

/**
 * V1 graph with `bassNoteRead` and `rhythmRead` implemented, plus a second bass node and the
 * rhythm node. `rhythmRead` is not Away eligible, as in the content graph.
 */
export function readGraph(): SkillGraph {
  const landmarks = V1_GRAPH.nodes.find((n) => n.id === LANDMARKS);
  if (!landmarks) throw new Error("fixture graph lacks the landmarks node");
  return {
    ...V1_GRAPH,
    generators: V1_GRAPH.generators.map((g) =>
      g.id === "bassNoteRead" || g.id === "rhythmRead" ? { ...g, implemented: true } : g,
    ),
    nodes: [
      ...V1_GRAPH.nodes,
      readNode(landmarks, { id: STEPS, prerequisites: [LANDMARKS] }),
      readNode(landmarks, {
        id: RHYTHM,
        itemGenerators: ["rhythmRead"],
        keyDependent: false,
        params: { pitches: 1 },
      }),
    ],
  };
}

export const READ_GRAPH = readGraph();

export interface CardSpec {
  nodeId: string;
  params: ItemParams;
  /** Days from NOW until due; negative is overdue. */
  dueInDays: number;
}

const DAY = 86_400_000;

/** A learner built directly: node states, byFamily, introducedAt and review cards. */
export function readLearner(spec: {
  graph?: SkillGraph;
  nodes: Record<
    string,
    NodeState | { state: NodeState; byFamily?: Record<string, NodeState>; introducedAt?: number }
  >;
  cards?: CardSpec[];
  newToday?: number;
}): LearnerState {
  const graph = spec.graph ?? READ_GRAPH;
  const state = initialState({ graph, scheduler: createScheduler() });
  for (const n of graph.nodes) state.nodes[n.id] = { state: "locked" };
  for (const [id, v] of Object.entries(spec.nodes)) {
    state.nodes[id] = typeof v === "string" ? { state: v } : v;
  }
  for (const c of spec.cards ?? []) {
    state.cards[itemId(c.nodeId, c.params)] = {
      nodeId: c.nodeId,
      lastAttemptAt: NOW - 5 * DAY,
      reps: 3,
      card: {
        due: NOW + c.dueInDays * DAY,
        stability: 5,
        difficulty: 5,
        elapsedDays: 1,
        scheduledDays: 1,
        reps: 3,
        lapses: 0,
        state: "review",
      },
    };
  }
  if (spec.newToday !== undefined) {
    state.daily["2026-03-10"] = {
      newItems: spec.newToday,
      nodesIntroduced: 0,
      sessions: 0,
      practiceSec: 0,
      mode: { instrument: 0, away: 0 },
    };
  }
  return state;
}
