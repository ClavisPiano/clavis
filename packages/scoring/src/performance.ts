import type {
  AttemptError,
  AttemptOutcome,
  Hand,
  InputSource,
  NoteEvent,
  PerformanceTarget,
} from "@clavis/core";
import { alignPerformance } from "./align/align.js";
import type { ExpectedNote, NoteResult, PerformedNote } from "./align/types.js";
import { CHORD_MAX_EXTRA_NOTES, CHORD_PASS_OVERALL } from "./chords.js";
import type { PartResult } from "./single.js";
import { err, inWindow, req } from "./util.js";

/** A performance is correct only when the overall alignment score is at least this (as R26). */
export const PERFORMANCE_PASS_OVERALL = CHORD_PASS_OVERALL;
/** Stray notes allowed in a correct take (as R26): a grazed key is not a wrong performance. */
export const PERFORMANCE_MAX_EXTRA_NOTES = CHORD_MAX_EXTRA_NOTES;

/** A note played up to this many beats off its place, apart from its other hand, still counts. */
const STRAY_WINDOW_BEATS = 0.5;
/** Onsets closer than this (in beats) are the same beat. */
const BEAT_EPS = 1e-6;

export interface PerformanceInput {
  notes: PerformanceTarget["notes"];
  tempoBpm: number;
  beatsPerBar: number;
  played: readonly NoteEvent[];
  stimulusEndMs: number;
  responseWindowMs: number;
  source: InputSource;
}

/** Where a note sits: 1-based bar, 1-based beat within the bar (fractional off the beat). */
function place(onsetBeats: number, beatsPerBar: number): { measure: number; beat: number } {
  const bar = Math.floor((onsetBeats + BEAT_EPS) / beatsPerBar);
  const beat = Math.max(0, onsetBeats - bar * beatsPerBar);
  return { measure: bar + 1, beat: Math.round((beat + 1) * 1000) / 1000 };
}

/**
 * A grand-staff performance, graded by performance alignment (R27). Every note of both hands is an
 * expected note, so the alignment says, per note, whether it was right, wrong, missed or off the
 * beat, and which extra notes were played. The rule is the chord line's (R26): correct when no
 * note is wrong or missed, at most `PERFORMANCE_MAX_EXTRA_NOTES` extra notes were played and the
 * overall score reaches `PERFORMANCE_PASS_OVERALL`; `partial` is the overall score.
 *
 * Errors, in order of importance: `note.wrong` and `note.missed` (one per note), `note.extra` (one
 * per extra note), then `note.early` and `note.late` (one per hand and onset, from the note
 * furthest off the beat, so a late chord is one error). Each carries `measure`, `beat` and `hand`
 * so feedback can say "bar 3: LH late", and the note's `id` (where there is one) so the staff can
 * mark it. An extra note takes the place of the matched note nearest to it in time and the hand
 * whose notes in that bar lie nearest in pitch. Latency is the first note after the reference time.
 */
export function scorePerformance(input: PerformanceInput): PartResult {
  const played = inWindow(input.played, input.stimulusEndMs, input.responseWindowMs);
  const first = played[0];
  const byId = new Map(input.notes.map((n) => [n.id, n]));
  const expected: ExpectedNote[] = input.notes.map((n) => ({
    id: n.id,
    midi: n.midi,
    onsetBeats: n.onsetBeats,
    durationBeats: n.durationBeats,
    hand: n.hand,
  }));
  const performed: PerformedNote[] = played.map((n) => ({
    midi: n.pitch,
    onsetMs: n.onsetMs,
    ...(n.offsetMs === undefined ? {} : { offsetMs: n.offsetMs }),
    ...(n.velocity === undefined ? {} : { velocity: n.velocity }),
  }));
  const result = alignPerformance({
    expected,
    tempoBpm: input.tempoBpm,
    performed,
    // One hand a little ahead of the other is early or late, not a missed note plus an extra.
    options: { source: input.source, strayWindowBeats: STRAY_WINDOW_BEATS },
  });

  const where = (r: NoteResult) => {
    const n = req(byId.get(r.id));
    return { id: n.id, ...place(n.onsetBeats, input.beatsPerBar), hand: n.hand };
  };

  const wrong: AttemptError[] = [];
  const missed: AttemptError[] = [];
  /** The furthest-off note of each (hand, onset), in score order. */
  const offBeat = new Map<string, NoteResult>();
  for (const r of result.notes) {
    if (r.cls === "wrongPitch") {
      wrong.push(
        err("note.wrong", { ...where(r), expected: r.midi, played: r.playedMidi ?? r.midi }),
      );
    } else if (r.cls === "missed") {
      missed.push(err("note.missed", { ...where(r), expected: r.midi }));
    } else if (r.cls === "early" || r.cls === "late") {
      const n = req(byId.get(r.id));
      const key = `${n.hand}@${String(n.onsetBeats)}`;
      const prev = offBeat.get(key);
      if (prev === undefined || Math.abs(r.deviationMs ?? 0) > Math.abs(prev.deviationMs ?? 0)) {
        offBeat.set(key, r);
      }
    }
  }
  const timing: AttemptError[] = [...offBeat.values()].map((r) =>
    err(r.cls === "early" ? "note.early" : "note.late", {
      ...where(r),
      ms: Math.round(Math.abs(r.deviationMs ?? 0)),
    }),
  );

  // Extra notes: placed by the matched note nearest in time, and given the nearer hand in pitch.
  const anchors = result.notes.flatMap((r) => {
    const p = r.performedIndex === undefined ? undefined : performed[r.performedIndex];
    return p === undefined ? [] : [{ r, onsetMs: p.onsetMs }];
  });
  const extra: AttemptError[] = result.extras.map((x) => {
    const nearest = anchors.reduce<{ r: NoteResult; onsetMs: number } | undefined>(
      (best, a) =>
        best === undefined || Math.abs(a.onsetMs - x.onsetMs) < Math.abs(best.onsetMs - x.onsetMs)
          ? a
          : best,
      undefined,
    );
    const at = nearest === undefined ? undefined : req(byId.get(nearest.r.id));
    const pos = place(at?.onsetBeats ?? 0, input.beatsPerBar);
    const inBar = input.notes.filter(
      (n) => place(n.onsetBeats, input.beatsPerBar).measure === pos.measure,
    );
    const pool = inBar.length > 0 ? inBar : input.notes;
    const hand: Hand = pool.reduce(
      (best, n) => (Math.abs(n.midi - x.midi) < Math.abs(best.midi - x.midi) ? n : best),
      req(pool[0]),
    ).hand;
    return err("note.extra", { ...pos, hand, played: x.midi });
  });

  const errors = [...wrong, ...missed, ...extra, ...timing];
  if (first === undefined) errors.unshift(err("response.timeout"));
  const overall = result.summary.overall;
  const outcome: AttemptOutcome = {
    correct:
      first !== undefined &&
      wrong.length === 0 &&
      missed.length === 0 &&
      result.extras.length <= PERFORMANCE_MAX_EXTRA_NOTES &&
      overall >= PERFORMANCE_PASS_OVERALL,
    latencyMs: first === undefined ? input.responseWindowMs : first.onsetMs - input.stimulusEndMs,
    retries: 0,
    partial: overall,
  };
  return { outcome, errors };
}
