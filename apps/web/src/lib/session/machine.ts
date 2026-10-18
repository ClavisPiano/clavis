import {
  DEFAULT_KEYBOARD_RANGE,
  createRng,
  nextPlacementStep,
  placementResults,
  scoreNoteIds,
  spawnDrill,
  type AttemptError,
  type AttemptOutcome,
  type ChoiceOption,
  type ComposeInput,
  type ExpectedResponse,
  type GenerateContext,
  type InputSource,
  type ItemInstance,
  type KeyFamily,
  type LearnerState,
  type LearningEvent,
  type NodeState,
  type NoteEvent,
  type PlacementAttempt,
  type PlacementItem,
  type PlacementPlan,
  type PlacementState,
  type PlannedItem,
  type ScoreSpec,
  type SelfAssessment,
  type SessionMode,
  type SessionPlan,
  type SkillGraph,
  type StimulusSpec,
  type VoiceRange,
  newMilestones,
  type EarnedMilestone,
  type Milestone,
} from "@clavis/core";
import type { InputAdapter } from "@clavis/audio";
import type { ScoreInput, ScoreResult } from "@clavis/scoring";
import { checkPlayDone, type DoneCheck } from "./completion";
import { AUTO_ADVANCE_MS, buildFeedback, type FeedbackView } from "./feedback";
import type { NotationMark, NotationPort } from "../notation/port";
import {
  answerLine,
  chordLabels,
  keyboardGuide,
  keyNotes,
  targetPitchClasses,
  type KeyboardGuide,
  type KeyNotes,
} from "./key-notes";
import { orientSpec } from "./orient";
import { buildReplaySpec } from "./replay";
import { noteNamer } from "./spelling";

/*
 * The session state machine (T2.9, T1.6). No DOM and no audio APIs: everything it touches is
 * injected, so the whole flow runs in unit tests with fakes.
 *
 *   idle -> [headphones] -> preparing -> [orient] -> ( [intro] -> presenting -> listening
 *     ([cue], play) -> [selfAssess] -> feedback )* -> summary
 *
 * Items that set `cue` (play it by ear, R29) pause after the stimulus for an ungraded "sing or hum
 * it" step: nothing listens and nothing is timed until `ready()`. Only the played answer is graded.
 *
 * `selfAssess` (spec 8.4, R28) asks "Was that right?" before feedback on some answers to fluent
 * and mastered skills; see `#selfAssessable`.
 *
 * Reading items (`instance.display`) show notation while presenting. Their reference time is the
 * moment the score is painted, or the end of a count-in that starts then (R17).
 *
 * Placement mode (T3.16, R19) reuses the same item presentation and scoring, driven by
 * `nextPlacementStep` instead of the composer:
 *
 *   idle -> preparing -> ( presenting -> listening -> feedback (brief tick) )* -> summary
 *
 * It writes nothing until the last item is answered, then exactly one `placement.completed`. No
 * session, intro, item or attempt events, no warm-up, no headphones question (that answer is an
 * event). Abandoning (`finish`, or leaving the page) writes nothing.
 *
 * `paused` can interrupt any step and `error` ends the session. Time is the AudioContext clock
 * in ms (`clock.contextNowMs()`), the same clock as `player.play().endAt` and the input adapters.
 */

/** The graded part of an item. Only playing is graded (R29); the type stays for the state shape. */
export type Phase = "play";

/** The cue shown after hearing a play-by-ear item (R29). */
export const CUE_PROMPT = "Sing or hum it, out loud or in your head";

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
  /** Extra practice (T2.15): compose with `practice` and write `session.started` with it. */
  practice?: boolean;
  /** Practice only these skills (node ids). Absent means every started skill. */
  skills?: readonly string[];
  /** Learn something new: extra new items for this session on top of the daily allowance. */
  extraNewItems?: number;
  graph: SkillGraph;
  /** Capability milestone statements (T6.3). Absent means the summary shows none. */
  milestones?: readonly Milestone[];
  /** Placement mode (T3.16): present this plan instead of composing a session. */
  placement?: { plan: PlacementPlan };
  compose(input: ComposeInput): SessionPlan;
  generate(item: PlannedItem, ctx: GenerateContext): ItemInstance;
  player: SessionPlayer;
  /** The main input: the mic at the instrument, the tap keyboard in Away mode. */
  input: InputAdapter;
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
  /**
   * Draws the score of reading items (R17). Without it, items that need notation are dropped
   * from the plan and the summary says so.
   */
  notation?: NotationPort;
  /**
   * Offer a practice step before the answer for scale degree items the learner has not yet made
   * fluent: nothing is scored until `ready()`. Default false.
   */
  practiceStep?: boolean;
  /**
   * Seconds-as-ms to wait on feedback before moving on by itself after a correct answer. 0 means
   * never: every answer waits for Next. Undefined keeps the older behaviour, where a faded correct
   * answer shows a brief tick.
   */
  autoContinueMs?: number;
}

/** The session blocks an item can come from. Apply holds piece phrases. */
export type Block = "ear" | "read" | "apply";

export interface ItemView {
  /** 1-based position among the planned items. */
  position: number;
  total: number;
  nodeId: string;
  nodeTitle: string;
  generator: string;
  isNew: boolean;
  block: Block;
  /** What to draw, for reading items. */
  display?: ScoreSpec;
  /** Playable range for the on-screen keyboard, when the item sets one. */
  inputRange?: VoiceRange;
  /** Degree items in the early stages: the notes it may ask for, spelled in the key. */
  keyNotes?: KeyNotes;
  /** Early stages: a keyboard marking the home note and chord. */
  guide?: KeyboardGuide;
  /** Early stages: the rhythm is drawn on a staff while it sounds. */
  showStaff?: true;
  /** Feedback of a play-by-ear item: the answer's score is drawn for the learner to check. */
  revealed?: true;
  /** Buttons to answer with, for choice items (R21). They replace the keyboard. */
  choices?: ChoiceOption[];
  /**
   * Chord lines (T5.3) and hands-together items (T5.5): each chord's numeral and symbol, one per
   * bar for the latter, shown as text beside the staff.
   */
  chords?: { roman: string; symbol: string }[];
  /** Two-hand items (T5.5): the staff says which hand plays what (treble right, bass left). */
  bothHands?: true;
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
  /** Capability milestones first earned in this session (T6.3), oldest first. */
  milestones?: EarnedMilestone[];
  /** Things the learner should know about, such as items skipped because notation did not load. */
  notes?: string[];
  /** Placement only: the node states written by `placement.completed`, in plan order. */
  placed?: PlacedNode[];
  /** A whole-piece run that was played to the end (MP): what `piece.completed` recorded. */
  run?: { pieceId: string; phrases: number; correctPhrases: number };
}

export interface PlacedNode {
  nodeId: string;
  title: string;
  state: PlacementState;
}

/** How long the correct/incorrect tick shows in placement before the next item. */
export const PLACEMENT_TICK_MS = 500;

/** Self-assessment is asked on every this-many-th eligible attempt of a session (R28). */
export const SELF_ASSESS_EVERY = 3;

/** Error codes that mean a part of the answer was never given (a timeout or silence). */
const NO_ANSWER_CODES: ReadonlySet<string> = new Set(["response.timeout", "sing.none"]);

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
      /** Practice step: input is not scored until `ready()`, and the response window has not started. */
      practice: boolean;
      /** Cue step (R29): sing or hum it, ungraded. Like practice, nothing is scored until `ready()`. */
      cue: boolean;
      /** The stimulus can be heard again (not for reading items). */
      canHear: boolean;
      /** The target note alone can be heard again (the stimulus also has a cadence). */
      canHearNote: boolean;
    }
  | {
      kind: "feedback";
      item: ItemView;
      feedback: FeedbackView;
      canReplay: boolean;
      /** The attempt is still held back, so Try again can discard it and ask the item again. */
      canRetry: boolean;
      /** A correct answer moves on by itself after this long (ms), unless the learner steps in. */
      autoContinueMs?: number;
      /** For the guide keyboard: the pitch classes asked for and the notes the learner played. */
      answerKeys?: { targetPcs: number[]; played: number[] };
    }
  | {
      /** Before feedback (spec 8.4): the learner says whether they think the answer was right. */
      kind: "selfAssess";
      item: ItemView;
      /** The attempt is still held back, so Try again can discard it and ask the item again. */
      canRetry: boolean;
    }
  | { kind: "paused"; resumeTo: SessionState["kind"] }
  | { kind: "summary"; summary: SessionSummary }
  /** The plan has no items (nothing due, nothing new). Nothing was written. */
  | { kind: "nothing" }
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
  block: Block;
  phases: Phase[];
  phaseIdx: number;
  stimulusEndMs: number;
  /** Reference time for scoring: the stimulus end, or the moment of Ready after a practice or cue step. */
  refMs: Partial<Record<Phase, number>>;
  phaseStartMs: number;
  /** In the practice or cue step: the first phase is open for trying, not yet for answering. */
  practicing: boolean;
  gateMs: number;
  /** Quiet time after the stimulus before answers count. Zero when nothing was played. */
  tailMs: number;
  playNotes: NoteEvent[];
  /** The option picked, for choice items. */
  choice?: { id: string; atMs: number };
}

type Listener = (state: SessionState) => void;

const NODE_RANK_ORDER: readonly NodeState[] = [
  "locked",
  "available",
  "learning",
  "fluent",
  "mastered",
];

/** Before the skill is fluent: the stage in which hints, guides and practice are offered. */
function isEarly(stage: NodeState): boolean {
  return NODE_RANK_ORDER.indexOf(stage) < NODE_RANK_ORDER.indexOf("fluent");
}

/** The stimulus with only its target notes, moved to the start. Whole when it has none. */
export function targetOnly(spec: StimulusSpec): StimulusSpec {
  const targets = spec.events.filter((e) => e.role === "target");
  if (targets.length === 0) return spec;
  const first = Math.min(...targets.map((e) => e.atSec));
  return { ...spec, events: targets.map((e) => ({ ...e, atSec: e.atSec - first })) };
}

/**
 * "Major or minor?" or "Major, minor or diminished?" from the option labels. Labels that are not
 * plain words (progressions such as "I-V-vi-IV") ask "Which one did you hear?" instead.
 */
export function choiceQuestion(options: readonly ChoiceOption[]): string {
  if (options.some((o) => !/^[A-Z][a-z]+$/.test(o.label))) return "Which one did you hear?";
  const labels = options.map((o, i) => (i === 0 ? o.label : o.label.toLowerCase()));
  const last = labels[labels.length - 1] ?? "";
  return `${labels.slice(0, -1).join(", ")} or ${last}?`;
}

/** A single-line left-hand pattern (broken, Alberti, pop), T5.7. */
function isLeftHandLine(instance: ItemInstance): boolean {
  return instance.generator === "lhPatternVariants" && instance.expected.play?.kind === "line";
}

/**
 * Chord labels shown beside the staff: each chord of a chord line (T5.3), unless reading the chord
 * is the task (T5.10), or the chords a left-hand pattern line (T5.7) or a hands-together item
 * (T5.5) is built on, from its presentation.
 */
function chordLabelsOf(instance: ItemInstance): { chords?: { roman: string; symbol: string }[] } {
  const play = instance.expected.play;
  if (play?.kind === "chordLine") {
    if (play.showLabels === false) return {};
    return { chords: play.chords.map((c) => ({ roman: c.roman, symbol: c.symbol })) };
  }
  const { prog, symbols } = instance.presentation;
  const strings = (v: unknown): v is string[] =>
    Array.isArray(v) && v.every((x) => typeof x === "string");
  if (isLeftHandLine(instance) && strings(prog) && strings(symbols)) {
    return { chords: prog.map((roman, i) => ({ roman, symbol: symbols[i] ?? "" })) };
  }
  // Hands together (T5.5): one chord per bar, from the presentation.
  const chords = play?.kind === "performance" ? chordLabels(instance) : undefined;
  return chords ? { chords } : {};
}

export function promptFor(expected: ExpectedResponse, mode: SessionMode, display = false): string {
  const play = expected.play;
  if (play?.kind === "choice") return choiceQuestion(play.options);
  if (display && play) {
    if (play.kind === "rhythm") return mode === "away" ? "Tap the rhythm" : "Play the rhythm";
    if (mode === "away") return "Find it on the keyboard";
    if (play.kind === "exactPitch") return "Play this note";
    if (play.kind === "sequence") return "Play these notes";
    if (play.kind === "line") return "Play this phrase";
    if (play.kind === "chordLine") {
      return play.chords.length === 1
        ? "Play this chord with your left hand"
        : "Play these chords with your left hand";
    }
    if (play.kind === "performance") {
      const hands = new Set(play.notes.map((n) => n.hand));
      return hands.size > 1 ? "Play this with both hands" : "Play this phrase";
    }
  }
  if (play?.kind === "rhythm") return mode === "away" ? "Tap the rhythm" : "Play the rhythm";
  return mode === "away" ? "Tap it on the keyboard" : "Play it";
}

export class SessionMachine {
  readonly #d: SessionDeps;
  readonly #listeners = new Set<Listener>();
  #state: SessionState = { kind: "idle" };

  #sessionId = "";
  #plan: SessionPlan | undefined;
  #items: { planned: PlannedItem; block: Block }[] = [];
  #pendingIntros = new Set<string>();
  #introFamilies = new Map<string, KeyFamily>();
  #notes: string[] = [];
  #notationShown = false;
  /** The notation engine loaded, so staffs beside the audio can be drawn. */
  #staffReady = false;
  #nodesBefore: Record<string, NodeState> = {};
  /** Node records when the session started, to tell which milestones are new. */
  #recordsBefore: LearnerState["nodes"] = {};
  #priorAttempts: Record<string, number> = {};
  #sessionAttempts: Record<string, number> = {};
  #attempts = 0;
  #correct = 0;
  #headphones: boolean | undefined;
  #headphonesAnswer: ((v: boolean) => void) | undefined;
  #latency: LatencyOffsets;
  /** Placement mode: answers so far, in presentation order. */
  #placementAttempts: PlacementAttempt[] = [];
  #placementSkippedReading = false;
  /** Whole-piece run (MP): whether each phrase was played correctly, in order. */
  #runResults: boolean[] = [];
  /**
   * The attempt of the item on the feedback screen, written only when the learner moves on, pauses
   * or ends the session. Until then Try again can drop it (a key press the app missed).
   */
  #pending:
    | {
        events: LearningEvent[];
        correct: boolean;
        nodeId: string;
        /** The attempt counted towards the self-assessment cadence. */
        eligible: boolean;
      }
    | undefined;
  /** Attempts in this session that could be self-assessed, asked or not (R28). */
  #assessable = 0;
  /** While self-assessing: the feedback to show once the learner has answered. */
  #afterAssess: { shown: SessionState; correct: boolean; errors: AttemptError[] } | undefined;
  #runSummary: SessionSummary["run"];

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
      phase:
        s.kind === "listening"
          ? s.practice
            ? "listening-practice"
            : s.cue
              ? "listening-cue"
              : `listening-${s.phase}`
          : s.kind,
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
      this.commit();
      this.#advance();
    }
  }

  /** Write the held-back attempt now. Safe to call at any time; Try again is no longer offered. */
  commit(): void {
    const pending = this.#pending;
    if (!pending) return;
    this.#pending = undefined;
    void this.#enqueue(() => this.#d.append(pending.events));
  }

  /**
   * Feedback: throw this attempt away and ask the item again, for when an answer was not heard.
   * Nothing is written for the discarded attempt.
   */
  retry(): void {
    const pending = this.#pending;
    const kind = this.#state.kind;
    if ((kind !== "feedback" && kind !== "selfAssess") || !this.#cur || !pending) return;
    this.#pending = undefined;
    this.#afterAssess = undefined;
    if (pending.eligible) this.#assessable--;
    this.#attempts--;
    if (pending.correct) this.#correct--;
    this.#sessionAttempts[pending.nodeId] = (this.#sessionAttempts[pending.nodeId] ?? 1) - 1;
    this.#cancelTimers();
    this.#d.player.stop();
    this.#playStimulus();
  }

  /**
   * Skip the current item (logged as an incorrect attempt). On the self-assessment question it
   * goes on to feedback without an answer. Elsewhere it acts like `next`.
   */
  skip(): void {
    const s = this.#state;
    if (s.kind === "presenting" || s.kind === "listening") {
      void this.#enqueue(() => this.#completeItem(true));
    } else if (s.kind === "selfAssess") {
      this.#leaveSelfAssess();
    } else {
      this.next();
    }
  }

  /** End the listening phase now and score what was heard. */
  answerDone(): void {
    if (this.#state.kind === "listening" && !this.#cur?.practicing) this.#endPhase();
  }

  /** Practice or cue step: stop and open the answer. Timing starts now. */
  ready(): void {
    const cur = this.#cur;
    if (this.#state.kind !== "listening" || !cur?.practicing) return;
    cur.practicing = false;
    this.#openPhase(cur.phaseIdx, true);
  }

  /**
   * Hear the item again while listening: the cadence and note (`full`) or the target note alone
   * (`note`). Anything played so far is discarded, and the answer window restarts afterwards.
   */
  hear(what: "full" | "note"): void {
    const s = this.#state;
    const cur = this.#cur;
    if (s.kind !== "listening" || !cur || !s.canHear) return;
    if (what === "note" && !s.canHearNote) return;
    this.#d.player.stop();
    this.#playStimulus(what === "note" ? targetOnly(cur.instance.stimulus) : undefined);
  }

  /** Choice items (R21): the learner picked an option. The first pick is the answer. */
  answerChoice(id: string): void {
    const cur = this.#cur;
    if (this.#state.kind !== "listening" || !cur || cur.choice) return;
    const play = cur.instance.expected.play;
    if (play?.kind !== "choice" || !play.options.some((o) => o.id === id)) return;
    cur.choice = { id, atMs: this.#d.clock.contextNowMs() };
    this.#endPhase();
  }

  /**
   * Self-assessment (spec 8.4): record what the learner thinks of the answer, then show feedback
   * as usual. It goes on the held-back attempt and never changes the rating.
   */
  selfAssess(answer: SelfAssessment): void {
    const pending = this.#pending;
    if (this.#state.kind !== "selfAssess" || !pending) return;
    this.#pending = {
      ...pending,
      events: pending.events.map((e) =>
        e.type === "attempt.completed" ? { ...e, selfAssessment: answer } : e,
      ),
    };
    this.#leaveSelfAssess();
  }

  /** Feedback: hear the reference and your attempt back to back. */
  replay(): void {
    const s = this.#state;
    const cur = this.#cur;
    if (s.kind !== "feedback" || !cur) return;
    this.#cancelTimers();
    this.#d.player.stop();
    this.#d.player.play(buildReplaySpec(cur.instance, { notes: cur.playNotes }));
  }

  /** The app went to the background. Stops sound and input; `resume` picks the step back up. */
  pause(): void {
    const s = this.#state;
    if (s.kind === "idle" || s.kind === "preparing" || s.kind === "headphones") return;
    if (s.kind === "paused" || s.kind === "summary" || s.kind === "error") return;
    if (s.kind === "nothing") return;
    // The app may be closed from the background, so a held-back attempt is written now.
    const committed =
      (s.kind === "feedback" || s.kind === "selfAssess") && this.#pending !== undefined;
    this.commit();
    let before: SessionState = s;
    const after = this.#afterAssess;
    if (s.kind === "selfAssess" && after && this.#cur) {
      // The attempt is now written without an answer, so the question is dropped: resuming shows
      // the feedback it was holding back.
      this.#markScore(this.#cur, after.correct, after.errors);
      before = after.shown;
      this.#afterAssess = undefined;
    }
    if (committed && before.kind === "feedback") before = { ...before, canRetry: false };
    this.#beforePause = before;
    this.#pausedAt = this.#d.clock.wallNow();
    this.#stopActivity();
    this.#setState({ kind: "paused", resumeTo: before.kind });
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
        this.#scheduleFeedbackAdvance(before);
        break;
      default:
        this.#setState(before);
    }
  }

  /** The learner taps Finish. */
  finish(): void {
    const kind = this.#state.kind;
    if (kind === "idle" || kind === "preparing" || kind === "headphones") return;
    if (kind === "summary" || kind === "error" || kind === "nothing") return;
    // Placement finishes only by running out of items; stopping early writes nothing.
    const reason = this.#attempts > 0 && !this.#d.placement ? "completed" : "abandoned";
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
    this.#hideNotation();
    this.#stopActivity();
    this.#d.input.stop();
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
    this.#d.input.setExpectedRange?.(null);
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
    if (this.#d.placement) return this.#preparePlacement(this.#d.placement.plan);
    const d = this.#d;
    this.#setState({ kind: "preparing" });
    const before = d.getState();
    this.#nodesBefore = this.#nodeStates(before);
    this.#recordsBefore = before.nodes;
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
      ...(d.practice ? { practice: true } : {}),
      ...(d.practice && d.skills ? { skills: d.skills } : {}),
      ...(d.extraNewItems ? { extraNewItems: d.extraNewItems } : {}),
      seed: d.seed,
    });
    const planned =
      plan.blocks.ear.length + plan.blocks.read.length + (plan.blocks.apply?.length ?? 0);
    if (d.practice && planned === 0) {
      throw new Error(
        d.skills
          ? "Nothing to practise in the skills you chose yet. Pick again from Practise a skill."
          : "Nothing to practise yet. Finish a regular session first, then come back.",
      );
    }
    if (planned === 0) {
      // An empty plan is not a session: no events, no inputs, just a screen that says so.
      this.#plan = plan;
      this.#setState({ kind: "nothing" });
      return;
    }
    this.#plan = plan;
    this.#items = [
      ...plan.blocks.ear.map((planned) => ({ planned, block: "ear" as const })),
      ...plan.blocks.read.map((planned) => ({ planned, block: "read" as const })),
      ...(plan.blocks.apply ?? []).map((planned) => ({ planned, block: "apply" as const })),
    ];
    const introductions = introductionsOf(plan);
    for (const intro of introductions) {
      if (intro.keyFamily !== undefined) this.#introFamilies.set(intro.nodeId, intro.keyFamily);
    }
    this.#pendingIntros = new Set(introductions.map((i) => i.nodeId));

    await this.#prepareNotation();

    // The mic is only used as the played input. Nobody is graded on their voice (R29).
    const micUsed = d.input.source === "mic";
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
    } catch (e) {
      const what = e instanceof Error ? e.message : String(e);
      throw new Error(`Could not start audio or the microphone: ${what}`, { cause: e });
    }
    d.input.pause();

    this.#sessionId = d.newId();
    this.#startedWall = d.clock.wallNow();
    const events: LearningEvent[] = [
      {
        ...this.#base(),
        type: "session.started" as const,
        v: 2 as const,
        ...(d.practice ? { practice: true } : {}),
        sessionId: this.#sessionId,
        mode: d.mode,
        budgetSec: Math.round(plan.budgetSec),
        key: plan.key,
        tzOffsetMin: d.tzOffsetMin,
        contentVersion: d.graph.contentVersion,
      },
      ...[...this.#pendingIntros].map((nodeId) => {
        const keyFamily = this.#introFamilies.get(nodeId);
        return {
          ...this.#base(),
          type: "node.introduced" as const,
          sessionId: this.#sessionId,
          nodeId,
          ...(keyFamily === undefined ? {} : { keyFamily }),
        };
      }),
    ];
    await d.append(events);

    if (plan.orient) this.#startOrient();
    else this.#beginItems();
  }

  /** Placement start: preload notation, open the input, then present the first item. Writes nothing. */
  async #preparePlacement(plan: PlacementPlan): Promise<void> {
    const d = this.#d;
    this.#setState({ kind: "preparing" });
    this.#nodesBefore = this.#nodeStates(d.getState());
    this.#items = [];
    const reading = plan.stages.some((s) =>
      s.items.some((i) => this.#needsNotation({ generator: i.generator })),
    );
    if (reading) {
      let ready = false;
      if (d.notation) {
        try {
          await d.notation.preload();
          ready = true;
        } catch {
          ready = false;
        }
      }
      if (!ready) {
        this.#placementSkippedReading = true;
        const hands = plan.stages.some((s) => s.section === "HANDS");
        this.#notes.push(
          `${hands ? "Reading and hands were" : "Reading was"} skipped because notation could not load.`,
        );
      }
    }
    try {
      await d.player.load?.();
      await d.input.start();
    } catch (e) {
      const what = e instanceof Error ? e.message : String(e);
      throw new Error(`Could not start audio or the microphone: ${what}`, { cause: e });
    }
    d.input.pause();
    this.#startedWall = d.clock.wallNow();
    this.#placementAdvance();
  }

  /** The next placement item, or the end when the plan (with its early stops) is done. */
  #placementAdvance(): void {
    const plan = this.#d.placement?.plan;
    if (!plan) return;
    let step = nextPlacementStep(plan, this.#placementAttempts);
    // READ and HANDS both draw a score, and they come last, so without notation placement ends.
    if (step.kind === "item" && step.item.section !== "EAR" && this.#placementSkippedReading) {
      step = { kind: "done", completed: step.completed, skippedStageIds: [] };
    }
    if (step.kind === "done") {
      void this.#enqueue(() => this.#end("completed"));
      return;
    }
    this.#loadPlacementItem(step.item);
  }

  #loadPlacementItem(item: PlacementItem): void {
    const d = this.#d;
    const index = this.#placementAttempts.length;
    const planned: PlannedItem = {
      itemId: item.itemId,
      nodeId: item.nodeId,
      generator: item.generator,
      params: item.params,
      isNew: false,
      estimatedSec: 0,
    };
    const rng = createRng((d.seed + Math.imul(index + 1, 0x9e3779b1)) >>> 0);
    // C major throughout (R19). Family A items (bass reading, HANDS) take the preferred key as is.
    const instance = d.generate(planned, {
      rng,
      preferredKey: { tonic: "C", mode: "major" },
      keyboardRange: DEFAULT_KEYBOARD_RANGE,
      mode: "instrument",
    });
    this.#cur = {
      index,
      planned,
      instance,
      // HANDS items belong to Apply in a session (R26), so they present the same way here.
      block: item.section === "EAR" ? "ear" : item.section === "READ" ? "read" : "apply",
      phases: ["play"],
      phaseIdx: 0,
      stimulusEndMs: 0,
      refMs: {},
      phaseStartMs: 0,
      practicing: false,
      gateMs: 0,
      tailMs: 0,
      playNotes: [],
    };
    // Nothing is logged for a placement item.
    this.#presentedLogged = true;
    this.#presentCurrent();
  }

  /** Does the planned item draw a score (its generator needs notation)? */
  #needsNotation(planned: Pick<PlannedItem, "generator">): boolean {
    return (
      this.#d.graph.generators
        .find((g) => g.id === planned.generator)
        ?.requires.includes("notation") === true
    );
  }

  /**
   * Load the notation engine when reading items are planned. If it cannot load (or there is no
   * port), those items are dropped, with any introduction that only they carried, and the summary
   * says so. The rest of the session carries on.
   */
  async #prepareNotation(): Promise<void> {
    const reading = this.#items.filter(({ planned }) => this.#needsNotation(planned));
    const port = this.#d.notation;
    if (reading.length === 0) {
      // Rhythm echo draws a staff beside the audio in the early stages. If notation cannot load
      // the items still play, just without it.
      if (port && this.#items.some(({ planned }) => planned.generator === "rhythmEcho")) {
        this.#staffReady = await port.preload().then(
          () => true,
          () => false,
        );
      }
      return;
    }
    let ready = false;
    if (port) {
      try {
        await port.preload();
        ready = true;
        this.#staffReady = true;
      } catch {
        ready = false;
      }
    }
    if (ready) return;
    this.#items = this.#items.filter(({ planned }) => !this.#needsNotation(planned));
    const remaining = new Set(this.#items.map(({ planned }) => planned.nodeId));
    for (const nodeId of [...this.#pendingIntros]) {
      if (!remaining.has(nodeId)) this.#pendingIntros.delete(nodeId);
    }
    this.#notes.push("Reading items were skipped because notation could not load.");
  }

  #hideNotation(): void {
    if (!this.#notationShown) return;
    this.#notationShown = false;
    this.#d.notation?.hide();
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
    if (this.#d.placement) {
      this.#placementAdvance();
      return;
    }
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

  #loadItem(index: number, entry: { planned: PlannedItem; block: Block }): void {
    const d = this.#d;
    const plan = this.#plan;
    if (!plan) return;
    const rng = createRng((d.seed + Math.imul(index + 1, 0x9e3779b1)) >>> 0);
    const instance = d.generate(entry.planned, {
      rng,
      preferredKey: plan.key,
      keyboardRange: DEFAULT_KEYBOARD_RANGE,
      mode: d.mode,
    });
    this.#cur = {
      index,
      planned: entry.planned,
      instance,
      block: entry.block,
      phases: ["play"],
      phaseIdx: 0,
      stimulusEndMs: 0,
      refMs: {},
      phaseStartMs: 0,
      practicing: false,
      gateMs: 0,
      tailMs: 0,
      playNotes: [],
    };
    this.#presentedLogged = false;
    this.#presentCurrent();
  }

  #presentCurrent(): void {
    const cur = this.#cur;
    if (!cur) return;
    const nodeId = cur.planned.nodeId;
    if (this.#pendingIntros.has(nodeId)) {
      this.#hideNotation();
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
    const node = this.#d.graph.nodes.find((n) => n.id === cur.planned.nodeId);
    const stage = this.#d.getState().nodes[cur.planned.nodeId]?.state ?? "locked";
    // The early stages name the notes of the key, so the key is not a second puzzle.
    const early = isEarly(stage);
    const notes = early ? keyNotes(cur.instance, node) : undefined;
    const guide = early ? keyboardGuide(cur.instance) : undefined;
    const play = cur.instance.expected.play;
    const bothHands =
      play?.kind === "performance" && new Set(play.notes.map((n) => n.hand)).size > 1;
    return {
      position: cur.index + 1,
      // Placement stops early, so it has no fixed total.
      total: this.#d.placement ? 0 : this.#items.length,
      nodeId: cur.planned.nodeId,
      nodeTitle: this.#nodeTitle(cur.planned.nodeId),
      generator: cur.instance.generator,
      isNew: cur.planned.isNew,
      block: cur.block,
      ...(cur.instance.display ? { display: cur.instance.display } : {}),
      ...(cur.instance.inputRange ? { inputRange: cur.instance.inputRange } : {}),
      ...(notes ? { keyNotes: notes } : {}),
      ...(guide ? { guide } : {}),
      ...(this.#staffFor(cur) ? { showStaff: true as const } : {}),
      ...(cur.instance.expected.play?.kind === "choice"
        ? { choices: cur.instance.expected.play.options }
        : {}),
      ...chordLabelsOf(cur.instance),
      ...(bothHands ? { bothHands: true as const } : {}),
    };
  }

  #tailMs(): number {
    // Exact-key inputs (keys, MIDI) hear no speaker bleed, so only the mic needs the tail.
    const mic = this.#d.input.source !== "tap" && this.#d.input.source !== "midi";
    if (!mic) return 0;
    const tails = this.#d.gateTailMs ?? DEFAULT_GATE_TAIL_MS;
    return this.#headphones === true ? tails.headphones : tails.speakers;
  }

  /** Play the stimulus with the input gated shut, then open it after the tail (T1.6). */
  #playStimulus(spec?: StimulusSpec): void {
    const cur = this.#cur;
    if (!cur) return;
    const d = this.#d;
    cur.phaseIdx = 0;
    cur.practicing = false;
    cur.playNotes = [];
    cur.refMs = {};
    this.#unsubscribeInput();
    this.#cancelTimers();
    d.input.pause();
    const display = cur.instance.display ?? this.#staffFor(cur);
    if (display && d.notation) {
      this.#presentNotation(cur, display, d.notation);
      return;
    }
    this.#hideNotation();
    const { endAt } = d.player.play(spec ?? cur.instance.stimulus);
    cur.stimulusEndMs = endAt * 1000;
    cur.tailMs = this.#tailMs();
    this.#setState({
      kind: "presenting",
      item: this.#itemView(cur),
      prompt: "Listen",
    });
    const openIn = cur.stimulusEndMs + cur.tailMs - d.clock.contextNowMs();
    this.#schedule(openIn, () => {
      this.#beginPhase(0);
    });
  }

  /**
   * Reading items (R17): show the score, and once it is painted take the reference time from the
   * AudioContext clock. A count-in starts then and its end is the reference; with nothing to play
   * the reference is the paint time and there is no gate tail. Runs in the serialized queue; a
   * pause or skip while painting makes the continuation stale.
   */
  #presentNotation(cur: Current, display: ScoreSpec, port: NotationPort): void {
    const d = this.#d;
    const token = this.#token;
    this.#setState({
      kind: "presenting",
      item: this.#itemView(cur),
      prompt: cur.instance.display ? this.#promptFor(cur) : "Listen",
    });
    void this.#enqueue(async () => {
      this.#notationShown = true;
      await port.show(display);
      if (token !== this.#token || this.#cur !== cur) return;
      const shownAt = d.clock.contextNowMs();
      if (cur.instance.stimulus.events.length === 0) {
        cur.stimulusEndMs = shownAt;
        cur.tailMs = 0;
        this.#beginPhase(0);
        return;
      }
      const { endAt } = d.player.play(cur.instance.stimulus);
      cur.stimulusEndMs = endAt * 1000;
      cur.tailMs = this.#tailMs();
      this.#schedule(cur.stimulusEndMs + cur.tailMs - d.clock.contextNowMs(), () => {
        this.#beginPhase(0);
      });
    });
  }

  #promptFor(cur: Current): string {
    // Broken and pop left-hand patterns (T5.7) are lines, but the hand matters.
    if (isLeftHandLine(cur.instance) && this.#d.mode === "instrument") {
      return "Play this pattern with your left hand";
    }
    return promptFor(cur.instance.expected, this.#d.mode, cur.instance.display !== undefined);
  }

  #beginPhase(index: number): void {
    const cur = this.#cur;
    if (!cur) return;
    const hold = index === 0 ? this.#holdFor(cur) : undefined;
    if (hold) {
      // Nothing listens and no clock runs until the learner is ready (`ready()`).
      cur.practicing = true;
      cur.phaseIdx = 0;
      this.#setState(this.#listeningState(cur, 0, hold));
      return;
    }
    this.#openPhase(index, false);
  }

  /** The step to hold before the answer opens: the cue to sing or hum (R29), or practice. */
  #holdFor(cur: Current): "cue" | "practice" | undefined {
    if (cur.instance.cue === true && !this.#d.placement) return "cue";
    return this.#wantsPractice(cur) ? "practice" : undefined;
  }

  /**
   * Practice before answering: scale degree items, until the skill is fluent and in every practice
   * round. Not in placement.
   */
  #wantsPractice(cur: Current): boolean {
    const d = this.#d;
    if (d.practiceStep !== true || d.placement) return false;
    const g = cur.instance.generator;
    if (g !== "degreeSing" && g !== "degreeId") return false;
    // Practice rounds always let the learner try first, whatever the stage: that is what they are
    // for. Regular sessions offer it until the skill is fluent.
    if (d.practice === true) return true;
    const state = d.getState().nodes[cur.planned.nodeId]?.state ?? "locked";
    return isEarly(state);
  }

  /** The staff drawn beside the audio (not a reading item): early stages, once notation loaded. */
  #staffFor(cur: Current): ScoreSpec | undefined {
    const staff = cur.instance.staff;
    if (!staff || !this.#staffReady || !this.#d.notation) return undefined;
    const stage = this.#d.getState().nodes[cur.planned.nodeId]?.state ?? "locked";
    return isEarly(stage) ? staff : undefined;
  }

  #listeningState(cur: Current, index: number, hold?: "cue" | "practice"): SessionState {
    const phase = cur.phases[index] ?? "play";
    const events = cur.instance.stimulus.events;
    const canHear = cur.instance.display === undefined && events.length > 0;
    const canHearNote =
      canHear && events.some((e) => e.role === "target") && events.some((e) => e.role !== "target");
    return {
      kind: "listening",
      item: this.#itemView(cur),
      phase,
      phaseIndex: index,
      phaseCount: cur.phases.length,
      prompt:
        hold === "cue" ? CUE_PROMPT : hold === "practice" ? "Find the note" : this.#promptFor(cur),
      practice: hold === "practice",
      cue: hold === "cue",
      canHear,
      canHearNote,
    };
  }

  /** Open a phase for answers. After practice or the cue the reference time is now, not the stimulus end. */
  #openPhase(index: number, afterPractice: boolean): void {
    const cur = this.#cur;
    if (!cur) return;
    const d = this.#d;
    const phase = cur.phases[index];
    if (!phase) return;
    cur.phaseIdx = index;
    const now = d.clock.contextNowMs();
    const ref = index === 0 && !afterPractice ? cur.stimulusEndMs : now;
    cur.refMs[phase] = ref;
    cur.phaseStartMs = ref;
    // Events before this time are the stimulus, never answers.
    cur.gateMs =
      index === 0 && !afterPractice ? cur.stimulusEndMs + cur.tailMs : now + this.#tailMs();
    const adapter = d.input;
    this.#unsubs.push(
      adapter.onNote((n) => {
        this.#onNote(n);
      }),
    );
    if (cur.instance.inputRange) adapter.setExpectedRange?.(cur.instance.inputRange);
    adapter.resume();
    this.#setState(this.#listeningState(cur, index));
    const deadline = ref + cur.instance.expected.responseWindowMs;
    this.#schedule(deadline - now, () => {
      this.#endPhase();
    });
  }

  #offset(source: InputSource): number {
    if (source === "tap") return this.#latency.tapMs ?? 0;
    if (source === "mic") return this.#latency.micMs ?? 0;
    // MIDI timestamps come from the device driver, so there is nothing to calibrate (R3).
    return 0;
  }

  #onNote(raw: NoteEvent): void {
    const cur = this.#cur;
    if (this.#state.kind !== "listening" || !cur) return;
    if (cur.practicing) return;
    const note: NoteEvent = { ...raw, onsetMs: raw.onsetMs - this.#offset(raw.source) };
    if (note.offsetMs !== undefined) note.offsetMs -= this.#offset(raw.source);
    if (note.onsetMs < cur.gateMs) return;
    // Choice items are answered with buttons; stray notes from the mic mean nothing.
    if (cur.instance.expected.play?.kind === "choice") return;
    cur.playNotes.push(note);
    this.#check();
  }

  #check(): void {
    const cur = this.#cur;
    if (!cur || this.#state.kind !== "listening") return;
    const now = this.#d.clock.contextNowMs();
    let result: DoneCheck = { done: false };
    if (cur.instance.expected.play) {
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
    this.#cancelTimers();
    this.#unsubscribeInput();
    this.#d.input.pause();
    this.#d.input.setExpectedRange?.(null);
    void this.#enqueue(() => this.#completeItem(false));
  }

  /** Grade the played answer (R29). The cue is never graded. */
  #score(cur: Current): {
    outcome: AttemptOutcome;
    subScores: ScoreResult["subScores"];
    errors: AttemptError[];
    source: InputSource;
  } {
    const expected = cur.instance.expected;
    const isChoice = expected.play?.kind === "choice";
    const source: InputSource = isChoice ? "tap" : this.#playSource(cur);
    const result = this.#d.score({
      expected,
      notes: cur.playNotes,
      ...(cur.choice ? { choice: cur.choice } : {}),
      stimulusEndMs: cur.refMs.play ?? cur.stimulusEndMs,
      source,
    });
    return { outcome: result.outcome, subScores: result.subScores, errors: result.errors, source };
  }

  /**
   * Where the played answer came from. The input can be the mic and the on-screen keys together;
   * an answer made only on the keys is graded as tapped (exact keys, no octave guessing).
   */
  #playSource(cur: Current): InputSource {
    const notes = cur.playNotes;
    return notes.length > 0 && notes.every((n) => n.source === "tap")
      ? "tap"
      : this.#d.input.source;
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
        outcome = { correct: false, latencyMs: expected.responseWindowMs, retries: 0 };
        errors = [{ code: "response.skipped" }];
        source = d.input.source;
      } else {
        const scored = this.#score(cur);
        outcome = { ...scored.outcome, latencyMs: Math.max(0, scored.outcome.latencyMs) };
        subScores = scored.subScores;
        errors = scored.errors;
        source = scored.source;
      }

      if (d.placement) {
        this.#finishPlacementItem(cur, outcome);
        return;
      }

      const nodeState = d.getState().nodes[nodeId]?.state ?? "locked";
      const attemptIndex =
        (this.#priorAttempts[nodeId] ?? 0) + (this.#sessionAttempts[nodeId] ?? 0);
      this.#sessionAttempts[nodeId] = (this.#sessionAttempts[nodeId] ?? 0) + 1;
      const answer = answerLine(cur.instance);
      // The score being read from, or the one revealed after answering by ear.
      const written = cur.instance.display ?? cur.instance.reveal;
      const built = buildFeedback({
        nodeState,
        attemptIndex,
        correct: outcome.correct,
        errors,
        mode: cur.instance.presentation.mode === "minor" ? "minor" : "major",
        ...(written ? { names: noteNamer(written) } : {}),
        ...(answer === undefined ? {} : { answer }),
      });

      // Play by ear: stay on the revealed score until the learner moves on.
      const reveal = cur.instance.reveal !== undefined && d.notation !== undefined;
      // With an auto-continue setting, every correct answer follows it, so nothing advances on
      // its own clock; without one, a faded correct answer shows a brief tick.
      const autoContinueMs =
        d.autoContinueMs !== undefined && d.autoContinueMs > 0 && outcome.correct && !reveal
          ? d.autoContinueMs
          : undefined;
      const feedback =
        reveal || d.autoContinueMs !== undefined ? { ...built, autoAdvance: false } : built;

      const attemptEvent: LearningEvent = {
        ...this.#base(),
        type: "attempt.completed" as const,
        v: 2 as const,
        sessionId: this.#sessionId,
        itemId: cur.instance.itemId,
        nodeId,
        outcome,
        ...(Object.keys(subScores).length > 0 ? { subScores } : {}),
        inputSource: source,
        ...(errors.length > 0 ? { errors } : {}),
      };
      // A failed chord line or performance spawns at most one micro-drill (T5.8, R27), written
      // with the attempt so Try again drops both. Practice never moves a card, so it spawns none.
      const drill = this.#plan?.practice
        ? undefined
        : spawnDrill({
            nodeId,
            params: cur.instance.params,
            expected,
            correct: outcome.correct,
            errors,
          });
      const events: LearningEvent[] = [attemptEvent];
      if (drill) {
        events.push({
          ...this.#base(),
          type: "drill.spawned" as const,
          sessionId: this.#sessionId,
          sourceItemId: cur.instance.itemId,
          nodeId,
          itemIds: [drill.itemId],
        });
      }
      // Piece runs and revealed scores write at once; everything else waits so it can be retried.
      // Placement returned above, so it never gets here: Try again cannot reach its attempts.
      const retryable = !this.#plan?.run && !reveal;
      const eligible = retryable && this.#selfAssessable(nodeState, skipped, errors);
      const ask = eligible && this.#assessable % SELF_ASSESS_EVERY === 0;
      if (eligible) this.#assessable++;
      if (retryable) {
        this.#pending = { events, correct: outcome.correct, nodeId, eligible };
      } else {
        await d.append(events);
      }
      this.#attempts++;
      if (outcome.correct) this.#correct++;
      if (this.#plan?.run) this.#runResults.push(outcome.correct);

      if (this.#hasEnded()) return;
      const shown: SessionState = {
        kind: "feedback",
        item: this.#itemView(cur),
        feedback,
        canReplay: !feedback.autoAdvance,
        canRetry: retryable,
        ...(autoContinueMs === undefined ? {} : { autoContinueMs }),
        ...(this.#itemView(cur).guide
          ? {
              answerKeys: {
                targetPcs: targetPitchClasses(cur.instance),
                played: cur.playNotes.map((n) => n.pitch).slice(-8),
              },
            }
          : {}),
      };
      if (this.#state.kind === "paused") {
        // Backgrounded while saving (only attempts written at once, which are never asked): show
        // the feedback when the learner comes back.
        this.#markScore(cur, outcome.correct, errors);
        this.#beforePause = shown;
        return;
      }
      if (ask) {
        // Nothing on screen gives the result away until the learner has answered.
        this.#afterAssess = { shown, correct: outcome.correct, errors };
        this.#setState({ kind: "selfAssess", item: shown.item, canRetry: true });
        return;
      }
      this.#showFeedback(
        cur,
        reveal ? { ...shown, item: { ...shown.item, revealed: true } } : shown,
        outcome.correct,
        errors,
        reveal,
      );
    } finally {
      this.#completing = false;
    }
  }

  /**
   * Self-assessment (spec 8.4, R28): only for skills at fluent or mastered, and never in placement
   * (which returns before this), extra practice or when no answer was given. Piece runs and
   * revealed scores are excluded by the caller. Of the eligible attempts, every
   * `SELF_ASSESS_EVERY`-th in the session is asked, starting with the first.
   */
  #selfAssessable(
    nodeState: NodeState,
    skipped: boolean,
    errors: readonly AttemptError[],
  ): boolean {
    if (nodeState !== "fluent" && nodeState !== "mastered") return false;
    if (this.#d.placement || this.#d.practice === true || skipped) return false;
    return !errors.some((e) => NO_ANSWER_CODES.has(e.code));
  }

  /** From the self-assessment question to the feedback it held back. */
  #leaveSelfAssess(): void {
    const after = this.#afterAssess;
    const cur = this.#cur;
    if (this.#state.kind !== "selfAssess" || !after || !cur) return;
    this.#afterAssess = undefined;
    this.#showFeedback(cur, after.shown, after.correct, after.errors, false);
  }

  /** Show feedback: mark a reading item's score, draw a revealed score, start the timers. */
  #showFeedback(
    cur: Current,
    shown: SessionState,
    correct: boolean,
    errors: readonly AttemptError[],
    reveal: boolean,
  ): void {
    this.#markScore(cur, correct, errors);
    this.#setState(shown);
    if (reveal) this.#revealScore(cur, correct, errors);
    this.#scheduleFeedbackAdvance(shown);
  }

  /** Reading items: mark the score being read from right and wrong. */
  #markScore(cur: Current, correct: boolean, errors: readonly AttemptError[]): void {
    if (cur.instance.display && this.#notationShown) {
      this.#d.notation?.highlight(feedbackMarks(cur.instance.display, correct, errors));
    }
  }

  /** A faded correct answer, or the auto-continue setting, moves on by itself. */
  #scheduleFeedbackAdvance(shown: SessionState): void {
    if (shown.kind !== "feedback") return;
    if (shown.feedback.autoAdvance) {
      this.#schedule(AUTO_ADVANCE_MS, () => {
        this.next();
      });
    } else if (shown.autoContinueMs !== undefined) {
      this.#schedule(shown.autoContinueMs, () => {
        this.next();
      });
    }
  }

  /**
   * Play by ear: draw the answer's score now that the learner has answered, marking what was right
   * and wrong. Runs in the serialized queue; moving on or pausing first makes it stale.
   */
  #revealScore(cur: Current, correct: boolean, errors: readonly AttemptError[]): void {
    const port = this.#d.notation;
    const score = cur.instance.reveal;
    if (port === undefined || score === undefined) return;
    const token = this.#token;
    void this.#enqueue(async () => {
      this.#notationShown = true;
      await port.show(score);
      if (token !== this.#token || this.#cur !== cur) return;
      port.highlight(feedbackMarks(score, correct, errors));
    });
  }

  /** Placement: remember the answer (nothing is stored yet), show a brief tick, then move on. */
  #finishPlacementItem(cur: Current, outcome: AttemptOutcome): void {
    this.#placementAttempts.push({
      itemId: cur.instance.itemId,
      nodeId: cur.planned.nodeId,
      correct: outcome.correct,
      latencyMs: Math.max(0, outcome.latencyMs),
      targetLatencyMs: cur.instance.targetLatencyMs ?? cur.instance.expected.responseWindowMs,
    });
    this.#attempts++;
    if (outcome.correct) this.#correct++;
    if (this.#hasEnded()) return;
    const shown: SessionState = {
      kind: "feedback",
      item: this.#itemView(cur),
      feedback: { correct: outcome.correct, lines: [], detailed: false, autoAdvance: true },
      canReplay: false,
      canRetry: false,
    };
    if (this.#state.kind === "paused") {
      this.#beforePause = shown;
      return;
    }
    this.#setState(shown);
    this.#schedule(PLACEMENT_TICK_MS, () => {
      this.next();
    });
  }

  /** Read through a method: the flag can change while `#completeItem` awaits. */
  #hasEnded(): boolean {
    return this.#ended;
  }

  async #end(reason: "completed" | "abandoned"): Promise<void> {
    if (this.#ended || this.#state.kind === "summary") return;
    this.#ended = true;
    this.#stopActivity();
    this.#hideNotation();
    const d = this.#d;
    const pending = this.#pending;
    this.#pending = undefined;
    if (pending) await d.append(pending.events);
    d.input.stop();
    const elapsedSec = Math.round(this.elapsedSec());
    let placed: PlacedNode[] | undefined;
    const placement = d.placement;
    if (placement && reason === "completed") {
      // The one and only write of a placement (R19).
      const results = placementResults(this.#placementAttempts, d.graph);
      await d.append([
        {
          ...this.#base(),
          type: "placement.completed" as const,
          placementId: d.newId(),
          results,
        },
      ]);
      placed = placement.plan.stages.flatMap((stage) => {
        const state = results[stage.nodeId];
        return state === undefined
          ? []
          : [{ nodeId: stage.nodeId, title: this.#nodeTitle(stage.nodeId), state }];
      });
    }
    // A whole-piece run that played every phrase (MP). A run left unfinished writes nothing here;
    // its phrases are still ordinary attempts.
    const run = this.#plan?.run;
    if (run && reason === "completed" && this.#sessionId !== "") {
      const phrases = this.#items.length;
      if (phrases > 0 && this.#runResults.length === phrases) {
        const correctPhrases = this.#runResults.filter(Boolean).length;
        await d.append([
          {
            ...this.#base(),
            type: "piece.completed" as const,
            sessionId: this.#sessionId,
            pieceId: run.pieceId,
            phrases,
            correctPhrases,
          },
        ]);
        this.#runSummary = { pieceId: run.pieceId, phrases, correctPhrases };
      }
    }
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
    const earned =
      placed || !d.milestones
        ? []
        : newMilestones({ nodes: this.#recordsBefore }, d.getState(), d.graph, d.milestones);
    this.#setState({
      kind: "summary",
      summary: {
        reason,
        items: this.#attempts,
        correct: this.#correct,
        accuracy: this.#attempts === 0 ? 0 : this.#correct / this.#attempts,
        elapsedSec,
        nodeChanges,
        ...(earned.length > 0 ? { milestones: earned } : {}),
        ...(this.#notes.length > 0 ? { notes: [...this.#notes] } : {}),
        ...(placed ? { placed } : {}),
        ...(this.#runSummary ? { run: this.#runSummary } : {}),
      },
    });
  }
}

/** Introductions from the plan, with the key family each key-dependent node opens in (R16). */
function introductionsOf(plan: SessionPlan): { nodeId: string; keyFamily?: KeyFamily }[] {
  return plan.introductions.map((nodeId) => {
    const keyFamily = plan.introductionKeyFamilies[nodeId];
    return keyFamily === undefined ? { nodeId } : { nodeId, keyFamily };
  });
}

/**
 * Marks for feedback on a reading item: every written note is shown as the target, a wrong note
 * in a sequence is marked, and a correct answer marks everything right.
 */
export function feedbackMarks(
  display: ScoreSpec,
  correct: boolean,
  errors: readonly AttemptError[],
): NotationMark[] {
  const ids = scoreNoteIds(display);
  if (correct) return ids.map((noteId) => ({ noteId, kind: "right" }));
  const wrong = new Set<string>();
  for (const e of errors) {
    const index = e.detail?.index;
    // A wrong tone or a missed chord marks its chord (one score note per chord).
    const marksNote =
      e.code === "sequence.wrong-note" ||
      e.code === "chord.wrong-tone" ||
      e.code === "chord.missing-tone" ||
      e.code === "chord.missed";
    const id = marksNote && typeof index === "number" ? ids[index] : undefined;
    if (id !== undefined) wrong.add(id);
    // A performance (R27) names the note by id; a chord tone `n3.1` marks its chord `n3`.
    const noteId = e.detail?.id;
    if ((e.code === "note.wrong" || e.code === "note.missed") && typeof noteId === "string") {
      const base = noteId.split(".")[0] ?? noteId;
      if (ids.includes(base)) wrong.add(base);
    }
  }
  return ids.map((noteId) => ({ noteId, kind: wrong.has(noteId) ? "wrong" : "target" }));
}
