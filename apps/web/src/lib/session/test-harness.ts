import { FakeInputAdapter, type FakeClock } from "@clavis/audio";
import { loadGraph } from "@clavis/content";
import {
  LearnerStateService,
  MemoryEventStore,
  composeSession,
  createRng,
  createScheduler,
  createUlidGenerator,
  getGenerator,
  placementPlan,
  stimulusDurationSec,
  type ExpectedResponse,
  type LearningEvent,
  type NoteEvent,
  type PitchFrame,
  type SkillGraph,
  type StimulusSpec,
} from "@clavis/core";
import { scoreAttempt } from "@clavis/scoring";
import type { NotationPort } from "../notation/port";
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

export interface Harness {
  clock: TestClock;
  player: FakePlayer;
  input: FakeInputAdapter;
  singInput: FakeInputAdapter;
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
  /** Learn something new: extra new items for this session. */
  extraNewItems?: number;
  inputSource?: "mic" | "tap";
  headphones?: boolean | undefined;
  askHeadphones?: boolean;
  latency?: { tapMs?: number; micMs?: number };
  openSessions?: () => Promise<string[]>;
  /** Events to fold before the session starts (earlier history). */
  history?: LearningEvent[];
  withSingInput?: boolean;
  seed?: number;
  saveHeadphones?: (v: boolean) => Promise<void>;
  /** Placement mode (T3.16): present the placement plan instead of a composed session. */
  placement?: boolean;
  /** Draws reading items. Without it, reading items are unavailable. */
  notation?: NotationPort;
  /** Makes ids differ from another harness that used the same clock. */
  idSalt?: number;
}

export async function makeHarness(opts: HarnessOptions = {}): Promise<Harness> {
  const graph = loadGraph();
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
  const input = new FakeInputAdapter({
    source: opts.inputSource ?? (mode === "away" ? "tap" : "mic"),
    clock,
  });
  const singInput = new FakeInputAdapter({ source: "mic", clock });
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
    ...(opts.extraNewItems ? { extraNewItems: opts.extraNewItems } : {}),
    graph,
    ...(opts.placement
      ? { placement: { plan: placementPlan(graph, createRng(opts.seed ?? 1234)) } }
      : {}),
    ...(opts.notation ? { notation: opts.notation } : {}),
    compose: composeSession,
    generate: (item, ctx) => {
      const node = graph.nodes.find((n) => n.id === item.nodeId);
      if (!node) throw new Error(`unknown node ${item.nodeId}`);
      return getGenerator(item.generator).generate(node, item.params, ctx);
    },
    player,
    input,
    ...(opts.withSingInput ? { createSingInput: () => singInput } : {}),
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
    singInput,
    store,
    service,
    graph,
    machine,
    deps,
    log: () => store.list(),
    advance,
    states,
  };
}

// ---- answering helpers ----

export function noteAt(pitch: number, onsetMs: number, source: NoteEvent["source"]): NoteEvent {
  return { pitch, onsetMs, confidence: 1, source };
}

/** Frames of a steady sung pitch (hz from MIDI), every 20 ms for `ms`. */
export function sungFrames(midi: number, startMs: number, ms = 300): PitchFrame[] {
  const hz = 440 * 2 ** ((midi - 69) / 12);
  const out: PitchFrame[] = [];
  for (let t = 0; t <= ms; t += 20) out.push({ hz, confidence: 1, atMs: startMs + t });
  return out;
}

/** Emit a correct answer for `expected`'s sung part through `adapter`. Returns the end time. */
export function singCorrect(
  adapter: FakeInputAdapter,
  expected: ExpectedResponse,
  startMs: number,
): number {
  const sing = expected.sing;
  if (!sing) return startMs;
  const midis = sing.kind === "sungPitch" ? [sing.targetMidi] : sing.midi;
  let t = startMs;
  for (const m of midis) {
    for (const f of sungFrames(m, t)) adapter.emitFrame(f);
    t += 400;
  }
  return t;
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
