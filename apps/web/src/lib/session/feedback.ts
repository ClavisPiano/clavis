import { conceptTip, type TipMode } from "@clavis/content";
import type { AttemptError, NodeState } from "@clavis/core";

/*
 * Summary feedback (spec 8): the result, then at most two issues in plain words, faded by node
 * state. Error codes come from @clavis/scoring; unknown codes fall back to a generic line.
 */

export const MAX_ISSUES = 2;

const CONFUSION_PREFIX = "degree.confusion.";

function num(detail: AttemptError["detail"], key: string): number | undefined {
  const v = detail?.[key];
  return typeof v === "number" ? v : undefined;
}

/** "Note 3" from a zero-based index in the error detail. */
function noteLabel(detail: AttemptError["detail"]): string {
  const i = num(detail, "index");
  return i === undefined ? "A note" : `Note ${String(i + 1)}`;
}

/** "sang" for errors from the sung part, "played" otherwise (scoring tags each error). */
function verb(detail: AttemptError["detail"]): string {
  return detail?.part === "sing" ? "sang" : "played";
}

/** Names a MIDI note for reading items, e.g. "E2". Absent for ear items. */
export type NoteNamer = (midi: number) => string;

/** One short sentence for an error code. With `names` (reading items) notes are named. */
export function describeError(error: AttemptError, names?: NoteNamer): string {
  const { code, detail } = error;
  if (names) {
    const expected = num(detail, "expected");
    const played = num(detail, "played");
    if (expected !== undefined && played !== undefined) {
      if (code === "pitch.wrong") {
        return `You played ${names(played)}. This note is ${names(expected)}.`;
      }
      if (code === "pitch.octave") {
        return `Right note, wrong octave. You played ${names(played)}. This note is ${names(expected)}.`;
      }
      if (code === "sequence.wrong-note") {
        return `${noteLabel(detail)}: you played ${names(played)}; the target was ${names(expected)}`;
      }
    }
  }
  if (code.startsWith(CONFUSION_PREFIX)) {
    const [expected, played] = code.slice(CONFUSION_PREFIX.length).split("-");
    if (expected !== undefined && played !== undefined && expected !== "" && played !== "") {
      return `You ${verb(detail)} ${played}; the target was ${expected}`;
    }
    return detail?.part === "sing"
      ? "You sang a different note from the target"
      : "That was a different note from the target";
  }
  switch (code) {
    case "pitch.wrong":
      return "That was not the target note";
    case "pitch.octave":
      return "Right note, wrong octave";
    case "response.timeout":
      return "No answer was heard in time";
    case "response.skipped":
      return "Skipped";
    case "sing.flat":
      return "A little flat";
    case "sing.sharp":
      return "A little sharp";
    case "sing.none":
      return "No steady sung note was heard";
    case "rhythm.late":
      return `${noteLabel(detail)} was late`;
    case "rhythm.early":
      return `${noteLabel(detail)} was early`;
    case "rhythm.missed":
      return `${noteLabel(detail)} was missed`;
    case "rhythm.extra":
      return "There was an extra tap";
    case "rhythm.tempo-drift": {
      const ratio = num(detail, "ratio");
      if (ratio === undefined) return "The tempo drifted";
      return ratio > 1 ? "You rushed the tempo" : "You dragged the tempo";
    }
    case "sequence.wrong-note": {
      const expected = detail?.expectedDegree;
      const played = detail?.playedDegree;
      if (typeof expected === "string" && typeof played === "string") {
        return `${noteLabel(detail)}: you ${verb(detail)} ${played}; the target was ${expected}`;
      }
      return `${noteLabel(detail)} was not the target`;
    }
    case "sequence.missing":
      return `${noteLabel(detail)} was missing`;
    case "sequence.extra":
      return "There was an extra note";
    default:
      return "Something was off";
  }
}

/** At most two issue lines, in the order scoring ranked them, without repeats. */
export function issueLines(
  errors: readonly AttemptError[],
  max = MAX_ISSUES,
  names?: NoteNamer,
): string[] {
  const lines: string[] = [];
  for (const e of errors) {
    const line = describeError(e, names);
    if (!lines.includes(line)) lines.push(line);
    if (lines.length >= max) break;
  }
  return lines;
}

/**
 * Fading (spec 8.3). `attemptIndex` is how many attempts this node has had before this one.
 * learning: every attempt. fluent: every second attempt. mastered: only when something was wrong.
 */
export function showDetail(state: NodeState, attemptIndex: number, correct: boolean): boolean {
  switch (state) {
    case "fluent":
      return attemptIndex % 2 === 0;
    case "mastered":
      return !correct;
    default:
      return true;
  }
}

export interface FeedbackView {
  correct: boolean;
  /** Issue lines to show. Empty when detail is faded out or nothing was wrong. */
  lines: string[];
  /** True when the detailed summary is shown (learning, or a faded-in attempt). */
  detailed: boolean;
  /** Correct and faded out: show a brief tick and move on by itself. */
  autoAdvance: boolean;
  /**
   * One-line concept explanation for a listed issue (spec 13), shown with a link to the node's
   * card. Only on detailed attempts before the node is mastered. An attempt can be correct
   * overall and still carry an issue (a wrong sung note before a right played one).
   */
  tip?: string;
}

export function buildFeedback(opts: {
  nodeState: NodeState;
  attemptIndex: number;
  correct: boolean;
  errors: readonly AttemptError[];
  /** The item's mode: degree labels mean different notes in major and minor. */
  mode?: TipMode;
  /** Reading items: names the notes in pitch errors. */
  names?: NoteNamer;
}): FeedbackView {
  const detailed = showDetail(opts.nodeState, opts.attemptIndex, opts.correct);
  const tip =
    detailed && opts.nodeState !== "mastered"
      ? conceptTip(opts.errors, opts.mode ?? "major")
      : undefined;
  return {
    correct: opts.correct,
    detailed,
    lines: detailed ? issueLines(opts.errors, MAX_ISSUES, opts.names) : [],
    autoAdvance: !detailed && opts.correct,
    ...(tip ? { tip: tip.text } : {}),
  };
}

/** How long the faded tick stays before auto-advance. */
export const AUTO_ADVANCE_MS = 800;
