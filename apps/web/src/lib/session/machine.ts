import {
  DEFAULT_KEYBOARD_RANGE,
  createRng,
  type AttemptError,
  type AttemptOutcome,
  type ComposeInput,
  type ExpectedResponse,
  type GenerateContext,
  type InputSource,
  type ItemInstance,
  type LearnerState,
  type LearningEvent,
  type NodeState,
  type NoteEvent,
  type PitchFrame,
  type PlannedItem,
  type SessionMode,
  type SessionPlan,
  type SkillGraph,
  type StimulusSpec,
  type VoiceRange,
} from "@clavis/core";
import type { InputAdapter } from "@clavis/audio";
import type { ScoreInput, ScoreResult } from "@clavis/scoring";
import { checkPlayDone, checkSingDone, type DoneCheck } from "./completion";
import { AUTO_ADVANCE_MS, buildFeedback, type FeedbackView } from "./feedback";
import { orientSpec } from "./orient";
import { buildReplaySpec } from "./replay";

/*
 * The session state machine (T2.9, T1.6). No DOM and no audio APIs: everything it touches is
 * injected, so the whole flow runs in unit tests with fakes.
 *
 *   idle -> [headphones] -> preparing -> [orient] -> ( [intro] -> presenting -> listening
 *     (sing, then play) -> feedback )* -> summary
 *
 * `paused` can interrupt any step and `error` ends the session. Time is the AudioContext clock
 * in ms (`clock.contextNowMs()`), the same clock as `player.play().endAt` and the input adapters.
 */

export type Phase = "sing" | "play";

export const DEFAULT_VOICE_RANGE: VoiceRange = { low: 48, high: 72 };
export const DEFAULT_GATE_TAIL_MS = { headphones: 150, speakers: 400 } as const;

export interface LatencyOffsets {
  tapMs?: number;
  micMs?: number;
}

export interface SessionClock {
  /** AudioContext time in ms. */
  contextNowMs(): number;
  /** Epoch ms, for event timestamps and the budget. */
  wallNow(): number;
  /** Run `fn` after `delayMs`. Returns a cancel function. */
  schedule(delayMs: number, fn: () => void): () => void;
}

export interface SessionPlayer {
  play(spec: StimulusSpec): { startAt: number; endAt: number };
  stop(): void;
  load?(): Promise<void>;
}

export interface SessionDeps {
  deviceId: string;
  mode: SessionMode;
  graph: SkillGraph;
  compose(input: ComposeInput): SessionPlan;
  generate(item: PlannedItem, ctx: GenerateContext): ItemInstance;
  player: SessionPlayer;
  /** The main input: the mic at the instrument, the tap keyboard in Away mode. */
  input: InputAdapter;
  /**
   * Away mode only: builds the mic input for sung parts when `input` is not the mic. Called only
   * when the plan has an item that needs singing.
   */
  createSingInput?: () => InputAdapter;
  score(input: ScoreInput): ScoreResult;
  append(events: LearningEvent[]): Promise<void>;
  /** The current derived learner state (already includes events appended so far). */
  getState(): LearnerState;
  clock: SessionClock;
  newId(): string;
  /** Session seed. Each item derives its own rng from it. */
  seed: number;
  /** Minutes east of UTC (R6). */
  tzOffsetMin: number;
  budgetSec?: number;
  latency?: LatencyOffsets;
  /** Remembered answer for "Using headphones?"; undefined when never answered. */
  headphones?: boolean | undefined;
  /** Ask once when the mic is used and the answer is unknown. Default false. */
  askHeadphones?: boolean;
  saveHeadphones?(value: boolean): Promise<void>;
  /** Ids of this device's sessions that started but never ended (abandoned by a reload). */
  openSessions?(): Promise<string[]>;
  gateTailMs?: { headphones: number; speakers: number };
}

export interface ItemView {
  /** 1-based position among the planned items. */
  position: number;
  total: number;
  nodeId: string;
  nodeTitle: string;
  generator: string;
  isNew: boolean;
  block: "ear" | "read";
}

export interface NodeChange {
  nodeId: string;
  title: string;
  from: NodeState;
  to: NodeState;
}

export interface SessionSummary {
  reason: "completed" | "abandoned";
  items: number;
  correct: number;
  /** 0..1, 0 when no items were attempted. */
  accuracy: number;
  elapsedSec: number;
  nodeChanges: NodeChange[];
}

export type SessionState =
  | { kind: "idle" }
  | { kind: "headphones" }
  | { kind: "preparing" }
  | { kind: "intro"; nodeId: string; title: string; description: string | undefined }
  | { kind: "orient"; playing: boolean; includeScale: boolean }
  | { kind: "presenting"; item: ItemView; prompt: string }
  | {
      kind: "listening";
      item: ItemView;
      phase: Phase;
      phaseIndex: number;
      phaseCount: number;
      prompt: string;
    }
  | { kind: "feedback"; item: ItemView; feedback: FeedbackView; canReplay: boolean }
  | { kind: "paused"; resumeTo: SessionState["kind"] }
  | { kind: "summary"; summary: SessionSummary }
  | { kind: "error"; message: string };

/** What the Playwright hook needs (exposed on `window` only in fake mode). */
export interface DebugInfo {
  phase: string;
  expected: ExpectedResponse | undefined;
  stimulusEndMs: number | undefined;
  phaseStartMs: number | undefined;
}

interface Current {
  index: number;
  planned: PlannedItem;
  instance: ItemInstance;
  block: "ear" | "read";
  phases: Phase[];
  phaseIdx: number;
  stimulusEndMs: number;
  /** Reference time per phase for scoring (stimulus end for the first, phase start after). */
  refMs: Partial<Record<Phase, number>>;
  phaseStartMs: number;
  gateMs: number;
  playNotes: NoteEvent[];
  singFrames: PitchFrame[];
}

type Listener = (state: SessionState) => void;

export function phasesFor(expected: ExpectedResponse, mode: SessionMode): Phase[] {
  const sing = expected.sing !== undefined;
  const play = expected.play !== undefined;
  // R12: at the instrument, sing then play. In Away mode the sung part stands alone.
  if (mode === "away") return sing ? ["sing"] : ["play"];
  if (sing && play) return ["sing", "play"];
  return play ? ["play"] : ["sing"];
}

export function promptFor(
  phase: Phase,
  phases: readonly Phase[],
  expected: ExpectedResponse,
  mode: SessionMode,
): string {
  if (phase === "sing") return "Sing it";
  if (phases.length > 1) return "Now play it";
  const play = expected.play;
  if (play?.kind === "rhythm") return mode === "away" ? "Tap the rhythm" : "Play the rhythm";
  return mode === "away" ? "Tap it on the keyboard" : "Play it";
}

const dedupe = (errors: AttemptError[]): AttemptError[] => {
  const seen = new Set<string>();
  return errors.filter((e) => {
    const key = JSON.stringify(e);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

export class SessionMachine {
  readonly #d: SessionDeps;
  readonly #listeners = new Set<Listener>();
  #state: SessionState = { kind: "idle" };

  #sessionId = "";
  #plan: SessionPlan | undefined;
  #items: { planned: PlannedItem; block: "ear" | "read" }[] = [];
  #pendingIntros = new Set<string>();
  #nodesBefore: Record<string, NodeState> = {};
  #priorAttempts: Record<string, number> = {};
  #sessionAttempts: Record<string, number> = {};
  #attempts = 0;
  #correct = 0;
  #singInput: InputAdapter | undefined;
  #headphones: boolean | undefined;
  #headphonesAnswer: ((v: boolean) => void) | undefined;
  #latency: LatencyOffsets;

  #startedWall = 0;
  #pausedMs = 0;
  #pausedAt: number | undefined;

  #token = 0;
  #cur: Current | undefined;
  #index = -1;
  #presentedLogged = false;
  #cancels: (() => void)[] = [];
  #unsubs: (() => void)[] = [];
  #quietCancel: (() => void) | undefined;
  #completing = false;
  #ended = false;
  #beforePause: SessionState | undefined;
  #chain: Promise<void> = Promise.resolve();

  constructor(deps: SessionDeps) {
    this.#d = deps;
    this.#headphones = deps.headphones;
    this.#latency = deps.latency ?? {};
  }

  // ---------------------------------------------------------------- observation

  get state(): SessionState {
    return this.#state;
  }

  get sessionId(): string {
    return this.#sessionId;
  }

  get plan(): SessionPlan | undefined {
    return this.#plan;
  }

  get headphones(): boolean | undefined {
    return this.#headphones;
  }

  subscribe(listener: Listener): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  elapsedSec(): number {
    if (this.#startedWall === 0) return 0;
    const now = this.#pausedAt ?? this.#d.clock.wallNow();
    return Math.max(0, (now - this.#startedWall - this.#pausedMs) / 1000);
  }

  get budgetSec(): number {
    return this.#plan?.budgetSec ?? this.#d.budgetSec ?? 0;
  }

  debug(): DebugInfo {
    const cur = this.#cur;
    const s = this.#state;
    return {
      phase: s.kind === "listening" ? `listening-${s.phase}` : s.kind,
      expected:
        s.kind === "listening" || s.kind === "presenting" ? cur?.instance.expected : undefined,
      stimulusEndMs: cur?.stimulusEndMs,
      phaseStartMs: cur?.phaseStartMs,
    };
  }

  /** Resolves when background work (saving events, preparing) has settled. For tests. */
  async settled(): Promise<void> {
    let chain: Promise<void>;
    do {
      chain = this.#chain;
      await chain;
    } while (chain !== this.#chain);
  }

  // ---------------------------------------------------------------- commands

  /** Compose, open the inputs, write `session.started`, and begin. Call from a user gesture. */
  start(): Promise<void> {
    if (this.#state.kind !== "idle") return Promise.resolve();
    return this.#enqueue(() => this.#prepare());
  }

  /** Answer the "Using headphones?" prompt. */
  answerHeadphones(value: boolean): void {
    this.#headphonesAnswer?.(value);
  }

  /** Continue from an intro card, the orient block or feedback. */
  next(): void {
    const s = this.#state;
    if (s.kind === "intro") {
      this.#pendingIntros.delete(s.nodeId);
      this.#presentCurrent();
    } else if (s.kind === "orient") {
      this.#d.player.stop();
      this.#cancelTimers();
      this.#beginItems();
    } else if (s.kind === "feedback") {
      this.#cancelTimers();
      this.#d.player.stop();
      this.#advance();
    }
  }

  /** Skip the current item (logged as an incorrect attempt). Elsewhere it acts like `next`. */
  skip(): void {
    const s = this.#state;
    if (s.kind === "presenting" || s.kind === "listening") {
      void this.#enqueue(() => this.#completeItem(true));
    } else {
      this.next();
    }
  }

  /** End the listening phase now and score what was heard. */
  answerDone(): void {
    if (this.#state.kind === "listening") this.#endPhase();
  }

  /** Feedback: hear the reference and your attempt back to back. */
  replay(): void {
    const s = this.#state;
    const cur = this.#cur;
    if (s.kind !== "feedback" || !cur) return;
    this.#cancelTimers();
    this.#d.player.stop();
    this.#d.player.play(
      buildReplaySpec(cur.instance, { notes: cur.playNotes, frames: cur.singFrames }),
    );
  }

  /** The app went to the background. Stops sound and input; `resume` picks the step back up. */
  pause(): void {
    const s = this.#state;
    if (s.kind === "idle" || s.kind === "preparing" || s.kind === "headphones") return;
    if (s.kind === "paused" || s.kind === "summary" || s.kind === "error") return;
    this.#beforePause = s;
    this.#pausedAt = this.#d.clock.wallNow();
    this.#stopActivity();
    this.#setState({ kind: "paused", resumeTo: s.kind });
  }

  resume(): void {
    if (this.#state.kind !== "paused") return;
    const before = this.#beforePause;
    this.#beforePause = undefined;
    if (this.#pausedAt !== undefined) {
      this.#pausedMs += this.#d.clock.wallNow() - this.#pausedAt;
      this.#pausedAt = undefined;
    }
    if (!before) return;
    switch (before.kind) {
      case "presenting":
      case "listening":
        // The stimulus is played again and anything heard so far is discarded.
        this.#playStimulus();
        break;
      case "orient":
        this.#startOrient();
        break;
      case "feedback":
        this.#setState(before);
        // Pausing cancelled the auto-advance timer, and auto-advancing feedback has no Next button.
        if (before.feedback.autoAdvance) {
          this.#schedule(AUTO_ADVANCE_MS, () => {
            this.next();
          });
        }
        break;
      default:
        this.#setState(before);
    }
  }

  /** The learner taps Finish. */
  finish(): void {
    const kind = this.#state.kind;
    if (kind === "idle" || kind === "preparing" || kind === "headphones") return;
    if (kind === "summary" || kind === "error") return;
    const reason = this.#attempts > 0 ? "completed" : "abandoned";
    void this.#enqueue(() => this.#end(reason));
  }

  // ---------------------------------------------------------------- internals

  #setState(state: SessionState): void {
    this.#state = state;
    for (const l of [...this.#listeners]) l(state);
  }

  #enqueue(fn: () => Promise<void>): Promise<void> {
    const run = this.#chain.then(fn).catch((e: unknown) => {
      this.#fail(e);
    });
    this.#chain = run;
    return run;
  }

  #fail(e: unknown): void {
    this.#stopActivity();
    this.#d.input.stop();
    this.#singInput?.stop();
    this.#setState({ kind: "error", message: e instanceof Error ? e.message : String(e) });
  }

  #schedule(delayMs: number, fn: () => void): void {
    const token = this.#token;
    const cancel = this.#d.clock.schedule(Math.max(0, delayMs), () => {
      if (token === this.#token) fn();
    });
    this.#cancels.push(cancel);
  }

  #cancelTimers(): void {
    for (const c of this.#cancels) c();
    this.#cancels = [];
    this.#quietCancel?.();
    this.#quietCancel = undefined;
  }

  #unsubscribeInput(): void {
    for (const u of this.#unsubs) u();
    this.#unsubs = [];
  }

  /** Stop sound, timers and listening. Stale callbacks are ignored through the token. */
  #stopActivity(): void {
    this.#token++;
    this.#cancelTimers();
    this.#unsubscribeInput();
    this.#d.player.stop();
    this.#d.input.pause();
    this.#singInput?.pause();
  }

  /** Envelope fields shared by every event; the caller adds `type` and the payload. */
  #base() {
    return {
      id: this.#d.newId(),
      deviceId: this.#d.deviceId,
      at: this.#d.clock.wallNow(),
      v: 1 as const,
    };
  }

  #nodeTitle(nodeId: string): string {
    return this.#d.graph.nodes.find((n) => n.id === nodeId)?.title ?? nodeId;
  }

  #nodeStates(state: LearnerState): Record<string, NodeState> {
    const out: Record<string, NodeState> = {};
    for (const n of this.#d.graph.nodes) out[n.id] = state.nodes[n.id]?.state ?? "locked";
    return out;
  }

  async #prepare(): Promise<void> {
    const d = this.#d;
    this.#setState({ kind: "preparing" });
    const before = d.getState();
    this.#nodesBefore = this.#nodeStates(before);
    for (const [id, list] of Object.entries(before.attempts)) this.#priorAttempts[id] = list.length;

    // A session left open by a reload is closed as abandoned before a new one starts.
    const open = (await d.openSessions?.()) ?? [];
    if (open.length > 0) {
      await d.append(
        open.map((sessionId) => ({
          ...this.#base(),
          type: "session.ended" as const,
          sessionId,
          reason: "abandoned" as const,
        })),
      );
    }

    const state = d.getState();
    const now = d.clock.wallNow();
    const plan = d.compose({
      state,
      graph: d.graph,
      now,
      tzOffsetMin: d.tzOffsetMin,
      mode: d.mode,
      ...(d.budgetSec === undefined ? {} : { budgetSec: d.budgetSec }),
      seed: d.seed,
    });
    this.#plan = plan;
    this.#items = [
      ...plan.blocks.ear.map((planned) => ({ planned, block: "ear" as const })),
      ...plan.blocks.read.map((planned) => ({ planned, block: "read" as const })),
    ];
    this.#pendingIntros = new Set(plan.introductions);

    // Which inputs does this plan need?
    const needsMic = this.#items.some(({ planned }) =>
      d.graph.generators.find((g) => g.id === planned.generator)?.requires.includes("mic"),
    );
    if (d.mode === "away" && d.input.source !== "mic" && needsMic && d.createSingInput) {
      this.#singInput = d.createSingInput();
    }
    const micUsed = d.input.source === "mic" || this.#singInput !== undefined;
    if (d.askHeadphones === true && micUsed && this.#headphones === undefined) {
      const answer = await new Promise<boolean>((resolve) => {
        this.#headphonesAnswer = resolve;
        this.#setState({ kind: "headphones" });
      });
      this.#headphonesAnswer = undefined;
      this.#headphones = answer;
      await d.saveHeadphones?.(answer);
      this.#setState({ kind: "preparing" });
    }

    try {
      await d.player.load?.();
      await d.input.start();
      await this.#singInput?.start();
    } catch (e) {
      const what = e instanceof Error ? e.message : String(e);
      throw new Error(`Could not start audio or the microphone: ${what}`, { cause: e });
    }
    d.input.pause();
    this.#singInput?.pause();

    this.#sessionId = d.newId();
    this.#startedWall = d.clock.wallNow();
    const events: LearningEvent[] = [
      {
        ...this.#base(),
        type: "session.started" as const,
        sessionId: this.#sessionId,
        mode: d.mode,
        budgetSec: Math.round(plan.budgetSec),
        key: plan.key,
        tzOffsetMin: d.tzOffsetMin,
        contentVersion: d.graph.contentVersion,
      },
      ...plan.introductions.map((nodeId) => ({
        ...this.#base(),
        type: "node.introduced" as const,
        sessionId: this.#sessionId,
        nodeId,
      })),
    ];
    await d.append(events);

    if (plan.orient) this.#startOrient();
    else this.#beginItems();
  }

  #startOrient(): void {
    const plan = this.#plan;
    if (!plan?.orient) {
      this.#beginItems();
      return;
    }
    const { includeScale } = plan.orient;
    this.#setState({ kind: "orient", playing: true, includeScale });
    const { endAt } = this.#d.player.play(orientSpec(plan.key, includeScale));
    const wait = endAt * 1000 - this.#d.clock.contextNowMs();
    this.#schedule(wait, () => {
      if (this.#state.kind === "orient") this.#setState({ ...this.#state, playing: false });
    });
  }

  #beginItems(): void {
    this.#cur = undefined;
    this.#index = -1;
    this.#advance();
  }

  /** Move to the next planned item, or end the session when none is left or time is up. */
  #advance(): void {
    this.#index++;
    const next = this.#items[this.#index];
    if (!next) {
      void this.#enqueue(() => this.#end("completed"));
      return;
    }
    const overBySec = this.elapsedSec() - this.budgetSec;
    if (this.#attempts > 0 && overBySec > next.planned.estimatedSec) {
      void this.#enqueue(() => this.#end("completed"));
      return;
    }
    this.#loadItem(this.#index, next);
  }

  #loadItem(index: number, entry: { planned: PlannedItem; block: "ear" | "read" }): void {
    const d = this.#d;
    const plan = this.#plan;
    if (!plan) return;
    const settings = d.getState().settings;
    const rng = createRng((d.seed + Math.imul(index + 1, 0x9e3779b1)) >>> 0);
    const instance = d.generate(entry.planned, {
      rng,
      preferredKey: plan.key,
      voiceRange: {
        low: settings.voiceRangeLow ?? DEFAULT_VOICE_RANGE.low,
        high: settings.voiceRangeHigh ?? DEFAULT_VOICE_RANGE.high,
      },
      keyboardRange: DEFAULT_KEYBOARD_RANGE,
      mode: d.mode,
    });
    this.#cur = {
      index,
      planned: entry.planned,
      instance,
      block: entry.block,
      phases: phasesFor(instance.expected, d.mode),
      phaseIdx: 0,
      stimulusEndMs: 0,
      refMs: {},
      phaseStartMs: 0,
      gateMs: 0,
      playNotes: [],
      singFrames: [],
    };
    this.#presentedLogged = false;
    this.#presentCurrent();
  }

  #presentCurrent(): void {
    const cur = this.#cur;
    if (!cur) return;
    const nodeId = cur.planned.nodeId;
    if (this.#pendingIntros.has(nodeId)) {
      const node = this.#d.graph.nodes.find((n) => n.id === nodeId);
      this.#setState({
        kind: "intro",
        nodeId,
        title: node?.title ?? nodeId,
        description: node?.description,
      });
      return;
    }
    if (!this.#presentedLogged) {
      this.#presentedLogged = true;
      const event: LearningEvent = {
        ...this.#base(),
        type: "item.presented",
        sessionId: this.#sessionId,
        itemId: cur.instance.itemId,
        nodeId,
        generator: cur.instance.generator,
        block: cur.block,
        isNew: cur.planned.isNew,
        presentation: cur.instance.presentation,
      };
      void this.#enqueue(() => this.#d.append([event]));
    }
    this.#playStimulus();
  }

  #itemView(cur: Current): ItemView {
    return {
      position: cur.index + 1,
      total: this.#items.length,
      nodeId: cur.planned.nodeId,
      nodeTitle: this.#nodeTitle(cur.planned.nodeId),
      generator: cur.instance.generator,
      isNew: cur.planned.isNew,
      block: cur.block,
    };
  }

  #adapterFor(phase: Phase): InputAdapter {
    return phase === "sing" ? (this.#singInput ?? this.#d.input) : this.#d.input;
  }

  #tailMs(): number {
    const mic = this.#d.input.source !== "tap" || this.#singInput !== undefined;
    if (!mic) return 0;
    const tails = this.#d.gateTailMs ?? DEFAULT_GATE_TAIL_MS;
    return this.#headphones === true ? tails.headphones : tails.speakers;
  }

  /** Play the stimulus with the input gated shut, then open it after the tail (T1.6). */
  #playStimulus(): void {
    const cur = this.#cur;
    if (!cur) return;
    const d = this.#d;
    cur.phaseIdx = 0;
    cur.playNotes = [];
    cur.singFrames = [];
    cur.refMs = {};
    this.#unsubscribeInput();
    this.#cancelTimers();
    d.input.pause();
    this.#singInput?.pause();
    const { endAt } = d.player.play(cur.instance.stimulus);
    cur.stimulusEndMs = endAt * 1000;
    this.#setState({
      kind: "presenting",
      item: this.#itemView(cur),
      prompt: "Listen",
    });
    const openIn = cur.stimulusEndMs + this.#tailMs() - d.clock.contextNowMs();
    this.#schedule(openIn, () => {
      this.#beginPhase(0);
    });
  }

  #beginPhase(index: number): void {
    const cur = this.#cur;
    if (!cur) return;
    const d = this.#d;
    const phase = cur.phases[index];
    if (!phase) return;
    cur.phaseIdx = index;
    const now = d.clock.contextNowMs();
    const ref = index === 0 ? cur.stimulusEndMs : now;
    cur.refMs[phase] = ref;
    cur.phaseStartMs = ref;
    // Events before this time are the stimulus (or the voice that just stopped), never answers.
    cur.gateMs = index === 0 ? cur.stimulusEndMs + this.#tailMs() : now + this.#tailMs();
    const adapter = this.#adapterFor(phase);
    this.#unsubs.push(
      adapter.onNote((n) => {
        this.#onNote(n, phase);
      }),
      adapter.onFrame((f) => {
        this.#onFrame(f, phase);
      }),
    );
    adapter.resume();
    this.#setState({
      kind: "listening",
      item: this.#itemView(cur),
      phase,
      phaseIndex: index,
      phaseCount: cur.phases.length,
      prompt: promptFor(phase, cur.phases, cur.instance.expected, d.mode),
    });
    const deadline = ref + cur.instance.expected.responseWindowMs;
    this.#schedule(deadline - now, () => {
      this.#endPhase();
    });
  }

  #offset(source: InputSource): number {
    if (source === "tap") return this.#latency.tapMs ?? 0;
    if (source === "mic") return this.#latency.micMs ?? 0;
    return 0;
  }

  #onNote(raw: NoteEvent, phase: Phase): void {
    const cur = this.#cur;
    if (this.#state.kind !== "listening" || cur?.phases[cur.phaseIdx] !== phase) return;
    const note: NoteEvent = { ...raw, onsetMs: raw.onsetMs - this.#offset(raw.source) };
    if (note.offsetMs !== undefined) note.offsetMs -= this.#offset(raw.source);
    if (note.onsetMs < cur.gateMs) return;
    if (phase === "play") cur.playNotes.push(note);
    this.#check();
  }

  #onFrame(raw: PitchFrame, phase: Phase): void {
    const cur = this.#cur;
    if (this.#state.kind !== "listening" || cur?.phases[cur.phaseIdx] !== phase) return;
    const frame: PitchFrame = { ...raw, atMs: raw.atMs - this.#offset("mic") };
    if (frame.atMs < cur.gateMs) return;
    if (phase === "sing") cur.singFrames.push(frame);
    this.#check();
  }

  #check(): void {
    const cur = this.#cur;
    if (!cur || this.#state.kind !== "listening") return;
    const phase = cur.phases[cur.phaseIdx];
    const now = this.#d.clock.contextNowMs();
    let result: DoneCheck = { done: false };
    if (phase === "sing" && cur.instance.expected.sing) {
      result = checkSingDone(cur.instance.expected.sing, cur.singFrames, now);
    } else if (phase === "play" && cur.instance.expected.play) {
      result = checkPlayDone(cur.instance.expected.play, cur.playNotes, now);
    }
    this.#quietCancel?.();
    this.#quietCancel = undefined;
    if (result.done) {
      this.#endPhase();
    } else if (result.recheckInMs !== undefined) {
      const token = this.#token;
      this.#quietCancel = this.#d.clock.schedule(result.recheckInMs, () => {
        if (token === this.#token) this.#check();
      });
    }
  }

  #endPhase(): void {
    const cur = this.#cur;
    if (!cur || this.#state.kind !== "listening") return;
    const phase = cur.phases[cur.phaseIdx];
    if (!phase) return;
    this.#cancelTimers();
    this.#unsubscribeInput();
    this.#adapterFor(phase).pause();
    const nextIdx = cur.phaseIdx + 1;
    if (nextIdx < cur.phases.length) {
      this.#beginPhase(nextIdx);
    } else {
      void this.#enqueue(() => this.#completeItem(false));
    }
  }

  #score(cur: Current): {
    outcome: AttemptOutcome;
    subScores: ScoreResult["subScores"];
    errors: AttemptError[];
    source: InputSource;
  } {
    const d = this.#d;
    const expected = cur.instance.expected;
    const parts: ScoreResult[] = [];
    let sing: ScoreResult | undefined;
    let play: ScoreResult | undefined;
    if (cur.phases.includes("sing") && expected.sing) {
      sing = d.score({
        expected,
        notes: [],
        frames: cur.singFrames,
        stimulusEndMs: cur.refMs.sing ?? cur.stimulusEndMs,
        source: this.#adapterFor("sing").source,
        part: "sing",
      });
      parts.push(sing);
    }
    if (cur.phases.includes("play") && expected.play) {
      play = d.score({
        expected,
        notes: cur.playNotes,
        frames: [],
        stimulusEndMs: cur.refMs.play ?? cur.stimulusEndMs,
        source: d.input.source,
        part: "play",
      });
      parts.push(play);
    }
    const main = play ?? sing;
    if (!main) throw new Error("item has nothing to score");
    const subScores: ScoreResult["subScores"] = {};
    if (sing?.subScores.sing !== undefined) subScores.sing = sing.subScores.sing;
    if (play?.subScores.play !== undefined) subScores.play = play.subScores.play;
    return {
      outcome: main.outcome,
      subScores,
      errors: dedupe(parts.flatMap((p) => p.errors)),
      source: play ? d.input.source : this.#adapterFor("sing").source,
    };
  }

  async #completeItem(skipped: boolean): Promise<void> {
    const cur = this.#cur;
    const s = this.#state;
    if (!cur || this.#completing || this.#ended) return;
    if (s.kind !== "presenting" && s.kind !== "listening") return;
    this.#completing = true;
    try {
      this.#stopActivity();
      const d = this.#d;
      const expected = cur.instance.expected;
      const nodeId = cur.planned.nodeId;
      let outcome: AttemptOutcome;
      let subScores: ScoreResult["subScores"] = {};
      let errors: AttemptError[] = [];
      let source: InputSource;
      if (skipped) {
        const last = cur.phases[cur.phases.length - 1] ?? "play";
        outcome = { correct: false, latencyMs: expected.responseWindowMs, retries: 0 };
        errors = [{ code: "response.skipped" }];
        source = this.#adapterFor(last).source;
      } else {
        const scored = this.#score(cur);
        outcome = { ...scored.outcome, latencyMs: Math.max(0, scored.outcome.latencyMs) };
        subScores = scored.subScores;
        errors = scored.errors;
        source = scored.source;
      }

      const nodeState = d.getState().nodes[nodeId]?.state ?? "locked";
      const attemptIndex =
        (this.#priorAttempts[nodeId] ?? 0) + (this.#sessionAttempts[nodeId] ?? 0);
      this.#sessionAttempts[nodeId] = (this.#sessionAttempts[nodeId] ?? 0) + 1;
      const feedback = buildFeedback({
        nodeState,
        attemptIndex,
        correct: outcome.correct,
        errors,
        mode: cur.instance.presentation.mode === "minor" ? "minor" : "major",
      });

      await d.append([
        {
          ...this.#base(),
          type: "attempt.completed" as const,
          sessionId: this.#sessionId,
          itemId: cur.instance.itemId,
          nodeId,
          outcome,
          ...(Object.keys(subScores).length > 0 ? { subScores } : {}),
          inputSource: source,
          ...(errors.length > 0 ? { errors } : {}),
        },
      ]);
      this.#attempts++;
      if (outcome.correct) this.#correct++;

      if (this.#hasEnded()) return;
      const shown: SessionState = {
        kind: "feedback",
        item: this.#itemView(cur),
        feedback,
        canReplay: !feedback.autoAdvance,
      };
      if (this.#state.kind === "paused") {
        // Backgrounded while saving: show the feedback when the learner comes back.
        this.#beforePause = shown;
        return;
      }
      this.#setState(shown);
      if (feedback.autoAdvance) {
        this.#schedule(AUTO_ADVANCE_MS, () => {
          this.next();
        });
      }
    } finally {
      this.#completing = false;
    }
  }

  /** Read through a method: the flag can change while `#completeItem` awaits. */
  #hasEnded(): boolean {
    return this.#ended;
  }

  async #end(reason: "completed" | "abandoned"): Promise<void> {
    if (this.#ended || this.#state.kind === "summary") return;
    this.#ended = true;
    this.#stopActivity();
    const d = this.#d;
    d.input.stop();
    this.#singInput?.stop();
    const elapsedSec = Math.round(this.elapsedSec());
    if (this.#sessionId !== "") {
      await d.append([
        { ...this.#base(), type: "session.ended" as const, sessionId: this.#sessionId, reason },
      ]);
    }
    const after = this.#nodeStates(d.getState());
    const nodeChanges: NodeChange[] = [];
    for (const [nodeId, to] of Object.entries(after)) {
      const from = this.#nodesBefore[nodeId] ?? "locked";
      if (from !== to) nodeChanges.push({ nodeId, title: this.#nodeTitle(nodeId), from, to });
    }
    this.#setState({
      kind: "summary",
      summary: {
        reason,
        items: this.#attempts,
        correct: this.#correct,
        accuracy: this.#attempts === 0 ? 0 : this.#correct / this.#attempts,
        elapsedSec,
        nodeChanges,
      },
    });
  }
}
