import { FakeInputAdapter, type FakeClock } from "@clavis/audio";
import { loadGraph, loadMilestones } from "@clavis/content";
import {
  LearnerStateService,
  MemoryEventStore,
  composeSession,
  createRng,
  createScheduler,
  createUlidGenerator,
  getGenerator,
  stimulusDurationSec,
  type ExpectedResponse,
  type LearningEvent,
  type Milestone,
  type NoteEvent,
  type ScoreSpec,
  type SkillGraph,
  type StimulusSpec,
} from "@clavis/core";
import { scoreAttempt } from "@clavis/scoring";
import type { NotationMark, NotationPort } from "../notation/port";
import { placementPlanFor } from "../placement";
import { SessionMachine, type SessionDeps, type SessionState } from "./machine";

/* Test-only helpers for the session machine: a manual clock, fake player and a real core stack. */

export const T0 = 1_790_000_000_000;

/** One clock for context time, wall time and timers. Time moves only through `advance`. */
export class TestClock implements FakeClock {
  ctxMs = 5000;
  #seq = 0;
  readonly #timers = new Map<number, { at: number; fn: () => void }>();

  now(): number {
    return this.ctxMs;
  }
  contextNowMs(): number {
    return this.ctxMs;
  }
  wallNow(): number {
    return T0 + this.ctxMs;
  }
  schedule(delayMs: number, fn: () => void): () => void {
    const id = this.#seq++;
    this.#timers.set(id, { at: this.ctxMs + delayMs, fn });
    return () => {
      this.#timers.delete(id);
    };
  }
  pending(): number {
    return this.#timers.size;
  }
  /** Run due timers up to `ms` ahead, in time order. */
  step(ms: number): void {
    const target = this.ctxMs + ms;
    for (;;) {
      let next: [number, { at: number; fn: () => void }] | undefined;
      for (const entry of this.#timers) {
        if (entry[1].at <= target && (!next || entry[1].at < next[1].at)) next = entry;
      }
      if (!next) break;
      this.#timers.delete(next[0]);
      this.ctxMs = Math.max(this.ctxMs, next[1].at);
      next[1].fn();
    }
    this.ctxMs = target;
  }
}

export class FakePlayer {
  readonly plays: { spec: StimulusSpec; startAt: number; endAt: number }[] = [];
  stops = 0;
  loads = 0;
  constructor(private readonly clock: TestClock) {}
  load(): Promise<void> {
    this.loads++;
    return Promise.resolve();
  }
  play(spec: StimulusSpec): { startAt: number; endAt: number } {
    const startAt = this.clock.contextNowMs() / 1000 + 0.1;
    const endAt = startAt + stimulusDurationSec(spec);
    this.plays.push({ spec, startAt, endAt });
    return { startAt, endAt };
  }
  stop(): void {
    this.stops++;
  }
}

/** A notation port that records what it was asked to do, with a controllable `show` delay. */
export class FakeNotation implements NotationPort {
  readonly calls: string[] = [];
  readonly shows: ScoreSpec[] = [];
  readonly marks: NotationMark[][] = [];
  preloadError: Error | undefined;
  showDelayMs = 0;
  constructor(private readonly clock: TestClock) {}
  preload(): Promise<void> {
    this.calls.push("preload");
    return this.preloadError ? Promise.reject(this.preloadError) : Promise.resolve();
  }
  show(score: ScoreSpec): Promise<void> {
    this.calls.push("show");
    this.shows.push(score);
    if (this.showDelayMs <= 0) return Promise.resolve();
    return new Promise((resolve) => {
      this.clock.schedule(this.showDelayMs, resolve);
    });
  }
  highlight(marks: NotationMark[]): void {
    this.calls.push("highlight");
    this.marks.push(marks);
  }
  hide(): void {
    this.calls.push("hide");
  }
  count(name: string): number {
    return this.calls.filter((c) => c === name).length;
  }
}

export interface Harness {
  clock: TestClock;
  player: FakePlayer;
  input: FakeInputAdapter;
  store: MemoryEventStore;
  service: LearnerStateService;
  graph: SkillGraph;
  machine: SessionMachine;
  deps: SessionDeps;
  /** Events appended during the session, in order. */
  log(): Promise<LearningEvent[]>;
  /** Advance time, letting async work settle after each timer. */
  advance(ms: number): Promise<void>;
  states: SessionState[];
}

export interface HarnessOptions {
  mode?: "instrument" | "away";
  budgetSec?: number;
  practice?: boolean;
  /** Practice only these skills (node ids). */
  skills?: readonly string[];
  /** Learn something new: extra new items for this session. */
  extraNewItems?: number;
  /** Welcome back (R30): the shorter, review-only session. */
  recovery?: boolean;
  inputSource?: "mic" | "tap" | "midi";
  /** The mic transcribes a take (T8.19): `finishTake` returns what this gives. */
  takeNotes?: () => readonly NoteEvent[];
  /** Offer HANDS items (chords): the input can capture them, as MIDI does. */
  polyphonic?: boolean;
  headphones?: boolean | undefined;
  askHeadphones?: boolean;
  latency?: { tapMs?: number; micMs?: number };
  openSessions?: () => Promise<string[]>;
  /** Events to fold before the session starts (earlier history). */
  history?: LearningEvent[];
  seed?: number;
  saveHeadphones?: (v: boolean) => Promise<void>;
  /**
   * Placement mode (T3.16): present the placement plan instead of a composed session. With
   * `inputSource: "midi"` the plan holds the HANDS section (T5.9).
   */
  placement?: boolean;
  /** Draws reading items. Without it, reading items are unavailable. */
  notation?: NotationPort;
  /** Offer the practice step before degree answers. */
  practiceStep?: boolean;
  /** Auto-continue after a correct answer, in ms (0 = never). Undefined keeps the older tick. */
  autoContinueMs?: number;
  /** Makes ids differ from another harness that used the same clock. */
  idSalt?: number;
  /** Capability milestone statements for the summary (T6.3). Defaults to the shipped ones. */
  milestones?: readonly Milestone[];
  /** A graph other than the shipped one, for example with `pieceLine` switched on. */
  graph?: SkillGraph;
}

export async function makeHarness(opts: HarnessOptions = {}): Promise<Harness> {
  const graph = opts.graph ?? loadGraph();
  const clock = new TestClock();
  const store = new MemoryEventStore();
  const service = new LearnerStateService({
    store,
    ctx: { graph, scheduler: createScheduler() },
  });
  if (opts.history) await store.append(opts.history);
  await service.load();
  const player = new FakePlayer(clock);
  const mode = opts.mode ?? "instrument";
  const source = opts.inputSource ?? (mode === "away" ? "tap" : "mic");
  const input = new FakeInputAdapter({
    source,
    clock,
    ...(opts.takeNotes ? { takeNotes: opts.takeNotes } : {}),
  });
  let counter = opts.idSalt ?? 0;
  const newId = createUlidGenerator({
    now: () => T0 + clock.ctxMs,
    randomBytes: (n) => Uint8Array.from({ length: n }, (_, i) => (counter + i) & 0xff),
  });
  const wrappedNewId = (): string => {
    counter++;
    return newId();
  };
  const deps: SessionDeps = {
    deviceId: "device-1",
    mode,
    ...(opts.practice ? { practice: true } : {}),
    ...(opts.practice && opts.skills ? { skills: opts.skills } : {}),
    ...(opts.extraNewItems ? { extraNewItems: opts.extraNewItems } : {}),
    ...(opts.recovery ? { recovery: true } : {}),
    graph,
    milestones: opts.milestones ?? loadMilestones(),
    ...(opts.placement
      ? // As the runtime builds it: the HANDS section only with MIDI input.
        { placement: { plan: placementPlanFor(graph, createRng(opts.seed ?? 1234), source) } }
      : {}),
    ...(opts.notation ? { notation: opts.notation } : {}),
    ...(opts.practiceStep ? { practiceStep: true } : {}),
    ...(opts.autoContinueMs === undefined ? {} : { autoContinueMs: opts.autoContinueMs }),
    compose: opts.polyphonic
      ? (input) => composeSession({ ...input, polyphonic: true })
      : composeSession,
    generate: (item, ctx) => {
      const node = graph.nodes.find((n) => n.id === item.nodeId);
      if (!node) throw new Error(`unknown node ${item.nodeId}`);
      return getGenerator(item.generator).generate(node, item.params, ctx);
    },
    player,
    input,
    score: scoreAttempt,
    append: async (events) => {
      await service.append(events);
    },
    getState: () => service.state,
    clock,
    newId: wrappedNewId,
    seed: opts.seed ?? 1234,
    tzOffsetMin: 600,
    ...(opts.budgetSec === undefined ? {} : { budgetSec: opts.budgetSec }),
    ...(opts.latency ? { latency: opts.latency } : {}),
    headphones: "headphones" in opts ? opts.headphones : true,
    ...(opts.askHeadphones === undefined ? {} : { askHeadphones: opts.askHeadphones }),
    ...(opts.saveHeadphones ? { saveHeadphones: opts.saveHeadphones } : {}),
    ...(opts.openSessions ? { openSessions: opts.openSessions } : {}),
  };
  const machine = new SessionMachine(deps);
  const states: SessionState[] = [];
  machine.subscribe((s) => states.push(s));
  const advance = async (ms: number): Promise<void> => {
    const stepMs = 50;
    for (let left = ms; left > 0; left -= stepMs) {
      clock.step(Math.min(stepMs, left));
      await machine.settled();
    }
  };
  return {
    clock,
    player,
    input,
    store,
    service,
    graph,
    machine,
    deps,
    log: async () => {
      // A held-back attempt (Try again) is written by now, as it would be on moving on.
      machine.commit();
      await machine.settled();
      return store.list();
    },
    advance,
    states,
  };
}

// ---- answering helpers ----

export function noteAt(pitch: number, onsetMs: number, source: NoteEvent["source"]): NoteEvent {
  return { pitch, onsetMs, confidence: 1, source };
}

/** Emit a correct answer for `expected`'s played part. Returns the time of the last onset. */
export function playCorrect(
  adapter: FakeInputAdapter,
  expected: ExpectedResponse,
  startMs: number,
): number {
  const play = expected.play;
  if (!play) return startMs;
  const source = adapter.source;
  let last = startMs;
  switch (play.kind) {
    case "pitchClass":
    case "exactPitch":
      adapter.emitNote(noteAt(play.targetMidi, startMs, source));
      break;
    case "sequence":
      play.midi.forEach((m, i) => {
        last = startMs + i * 400;
        adapter.emitNote(noteAt(m, last, source));
      });
      break;
    case "line": {
      const beatMs = 60000 / play.tempoBpm;
      play.midi.forEach((m, i) => {
        last = startMs + (play.onsetsBeats[i] ?? 0) * beatMs;
        adapter.emitNote(noteAt(m, last, source));
      });
      break;
    }
    case "chordLine": {
      const beatMs = 60000 / play.tempoBpm;
      for (const c of play.chords) {
        last = startMs + c.onsetBeats * beatMs;
        for (const m of c.midi) adapter.emitNote(noteAt(m, last, source));
      }
      break;
    }
    case "performance": {
      const beatMs = 60000 / play.tempoBpm;
      for (const n of play.notes) {
        const at = startMs + n.onsetBeats * beatMs;
        last = Math.max(last, at);
        adapter.emitNote(noteAt(n.midi, at, source));
      }
      break;
    }
    case "rhythm": {
      const beatMs = 60000 / play.tempoBpm;
      for (const b of play.onsetsBeats) {
        last = startMs + b * beatMs;
        adapter.emitNote(noteAt(play.pitch ?? 60, last, source));
      }
      break;
    }
  }
  return last;
}

/**
 * The event log of a machine built by hand (not the harness's own), after its held-back attempt
 * has been written, as it is on moving on.
 */
export async function logOf(r: { machine: SessionMachine; h: Harness }): Promise<LearningEvent[]> {
  r.machine.commit();
  await r.machine.settled();
  return r.h.log();
}
