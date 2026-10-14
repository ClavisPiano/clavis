import { encodeTime } from "../events/ulid.js";
import type { LearningEvent } from "../events/schema.js";
import type { GeneratorInfo, SkillGraph, SkillNode } from "../graph/schema.js";
import { createScheduler } from "../scheduler/scheduler.js";
import type { FoldContext } from "./types.js";

/* Test-only helpers: a small fixture graph and an event builder. Not exported from the package. */

export const DAY_MS = 86_400_000;
/** 2026-01-01T00:00:00Z */
export const T0 = 1_767_225_600_000;

const gen = (id: GeneratorInfo["id"], implemented: boolean): GeneratorInfo => ({
  id,
  implemented,
  seedDurationSec: 10,
  awayEligible: true,
  requires: [],
});

const node = (id: string, extra: Partial<SkillNode>): SkillNode => ({
  id,
  strand: "EAR",
  title: id,
  prerequisites: [],
  itemGenerators: ["degreeId"],
  params: {},
  mastery: { minAccuracy: 0.75, maxMedianLatencyMs: 4000, windowAttempts: 4, distinctSessions: 2 },
  keyDependent: false,
  targetLatencyMs: 2000,
  ...extra,
});

/**
 * n1: root. n2: hard prereq n1. n3: key-dependent, hard prereq n1.
 * n4: soft prereq n2 but only an unimplemented generator, so it is never enabled.
 * n5: soft prereq n2, enabled.
 */
export const FIXTURE_GRAPH: SkillGraph = {
  contentVersion: "fixture-1",
  generators: [gen("degreeId", true), gen("cellEcho", true), gen("sightLine", false)],
  nodes: [
    node("n1", {}),
    node("n2", { prerequisites: ["n1"], itemGenerators: ["cellEcho"] }),
    node("n3", {
      prerequisites: ["n1"],
      keyDependent: true,
      mastery: {
        minAccuracy: 0.75,
        maxMedianLatencyMs: 4000,
        windowAttempts: 3,
        distinctSessions: 2,
      },
    }),
    node("n4", { softPrerequisites: ["n2"], itemGenerators: ["sightLine"] }),
    node("n5", { softPrerequisites: ["n2"] }),
  ],
};

export const NODE_IDS = FIXTURE_GRAPH.nodes.map((n) => n.id);

export const ctx = (graph: SkillGraph = FIXTURE_GRAPH): FoldContext => ({
  graph,
  scheduler: createScheduler(),
});

export interface Key {
  tonic: string;
  mode: "major" | "minor";
}
export const KEY_C: Key = { tonic: "C", mode: "major" }; // family A
export const KEY_D: Key = { tonic: "D", mode: "major" }; // family B
export const KEY_E: Key = { tonic: "E", mode: "major" }; // family C

/** Builds valid, uniquely identified events for one device. */
export class Builder {
  private seq = 0;
  constructor(
    readonly deviceId = "dev-a",
    private readonly tag = "A",
  ) {}

  private id(at: number): string {
    this.seq++;
    return encodeTime(at) + this.tag + String(this.seq).padStart(15, "0");
  }

  sessionId(n: number): string {
    return encodeTime(T0) + this.tag + "S" + String(n).padStart(14, "0");
  }

  private base(at: number) {
    return { id: this.id(at), deviceId: this.deviceId, at };
  }

  start(
    at: number,
    sessionId: string,
    o: {
      mode?: "instrument" | "away";
      key?: Key;
      tz?: number;
      budgetSec?: number;
      practice?: boolean;
    } = {},
  ): LearningEvent {
    return {
      ...this.base(at),
      type: "session.started",
      v: 2,
      ...(o.practice !== undefined ? { practice: o.practice } : {}),
      sessionId,
      mode: o.mode ?? "instrument",
      budgetSec: o.budgetSec ?? 600,
      key: o.key ?? KEY_C,
      tzOffsetMin: o.tz ?? 0,
      contentVersion: "fixture-1",
    };
  }

  end(at: number, sessionId: string): LearningEvent {
    return { ...this.base(at), type: "session.ended", v: 1, sessionId, reason: "completed" };
  }

  introduce(
    at: number,
    sessionId: string,
    nodeId: string,
    keyFamily?: "A" | "B" | "C",
  ): LearningEvent {
    return {
      ...this.base(at),
      type: "node.introduced",
      v: 1,
      sessionId,
      nodeId,
      ...(keyFamily ? { keyFamily } : {}),
    };
  }

  place(at: number, results: Record<string, "mastered" | "fluent" | "available">): LearningEvent {
    return {
      ...this.base(at),
      type: "placement.completed",
      v: 1,
      placementId: this.id(at),
      results,
    };
  }

  settings(at: number, patch: Record<string, number | boolean>): LearningEvent {
    return { ...this.base(at), type: "settings.changed", v: 2, patch };
  }

  register(at: number): LearningEvent {
    return { ...this.base(at), type: "device.registered", v: 1, platform: "test" };
  }

  /** item.presented at `at`, attempt.completed `latencyMs` later. */
  item(
    at: number,
    sessionId: string,
    nodeId: string,
    itemId: string,
    o: {
      correct?: boolean;
      latencyMs?: number;
      retries?: number;
      partial?: number;
      isNew?: boolean;
      generator?: "degreeId" | "cellEcho";
      presentation?: Record<string, string>;
    } = {},
  ): LearningEvent[] {
    const latencyMs = o.latencyMs ?? 1500;
    return [
      {
        ...this.base(at),
        type: "item.presented",
        v: 1,
        sessionId,
        itemId,
        nodeId,
        generator: o.generator ?? "degreeId",
        block: "ear",
        isNew: o.isNew ?? false,
        presentation: o.presentation ?? {},
      },
      {
        ...this.base(at + latencyMs),
        type: "attempt.completed",
        v: 1,
        sessionId,
        itemId,
        nodeId,
        outcome: {
          correct: o.correct ?? true,
          latencyMs,
          retries: o.retries ?? 0,
          ...(o.partial !== undefined ? { partial: o.partial } : {}),
        },
        inputSource: "midi",
      },
    ];
  }

  /** A piece phrase (MP): `item.presented` in the apply block, then the attempt `latencyMs` later. */
  phrase(
    at: number,
    sessionId: string,
    pieceId: string,
    phrase: number,
    o: {
      correct?: boolean;
      latencyMs?: number;
      presentation?: Record<string, string | number>;
      /** A phrase played by ear (TP.6): its own node and generator. */
      ear?: boolean;
    } = {},
  ): LearningEvent[] {
    const latencyMs = o.latencyMs ?? 8000;
    const nodeId = o.ear === true ? "apply.piece-ear" : "apply.pieces";
    const itemId = `${nodeId}|phrase=${String(phrase)}|piece=${pieceId}`;
    return [
      {
        ...this.base(at),
        type: "item.presented",
        v: 1,
        sessionId,
        itemId,
        nodeId,
        generator: o.ear === true ? "pieceEar" : "pieceLine",
        block: "apply",
        isNew: false,
        presentation: o.presentation ?? { piece: pieceId, phrase, tempoBpm: 60 },
      },
      {
        ...this.base(at + latencyMs),
        type: "attempt.completed",
        v: 1,
        sessionId,
        itemId,
        nodeId,
        outcome: { correct: o.correct ?? true, latencyMs, retries: 0 },
        inputSource: "midi",
      },
    ];
  }

  /** A finished whole-piece run. */
  pieceCompleted(
    at: number,
    sessionId: string,
    pieceId: string,
    phrases: number,
    correctPhrases: number,
  ): LearningEvent {
    return {
      ...this.base(at),
      type: "piece.completed",
      v: 1,
      sessionId,
      pieceId,
      phrases,
      correctPhrases,
    };
  }

  /** One session: start, `count` items on a node, end. Returns events and the end time. */
  session(
    at: number,
    n: number,
    nodeId: string,
    count: number,
    o: {
      mode?: "instrument" | "away";
      key?: Key;
      tz?: number;
      correct?: boolean;
      introduce?: boolean;
      practice?: boolean;
      presentation?: Record<string, string>;
    } = {},
  ): LearningEvent[] {
    const sid = this.sessionId(n);
    const out: LearningEvent[] = [this.start(at, sid, o)];
    let t = at + 1000;
    if (o.introduce) {
      out.push(this.introduce(t, sid, nodeId));
      t += 1000;
    }
    for (let i = 0; i < count; i++) {
      out.push(
        ...this.item(t, sid, nodeId, `${nodeId}:${String(i % 3)}`, {
          ...(o.correct !== undefined ? { correct: o.correct } : {}),
          ...(o.presentation ? { presentation: o.presentation } : {}),
        }),
      );
      t += 5000;
    }
    out.push(this.end(t, sid));
    return out;
  }
}
