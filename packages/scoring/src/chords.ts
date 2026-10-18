import type {
  AttemptError,
  AttemptOutcome,
  ChordLineTarget,
  InputSource,
  NoteEvent,
} from "@clavis/core";
import { alignPerformance } from "./align/align.js";
import { OVERALL_WEIGHTS, TOLERANCES } from "./align/tolerances.js";
import type { ExpectedNote, NoteResult, PerformedNote } from "./align/types.js";
import type { PartResult } from "./single.js";
import { err, inWindow, req } from "./util.js";

/** A chord line is correct only when the overall alignment score is at least this. */
export const CHORD_PASS_OVERALL = 0.8;
/**
 * Stray notes allowed in a correct take. A key grazed on the way to a chord is not a wrong chord,
 * but a repeated or invented chord is.
 */
export const CHORD_MAX_EXTRA_NOTES = 1;
/**
 * Tones-only lines (`gradeTiming: false`): notes this close are one chord, so a block chord that is
 * pressed a little unevenly still counts. Never narrower than the source's own window.
 */
export const TONES_ONLY_CLUSTER_MS = 300;

export interface ChordLineInput {
  chords: ChordLineTarget["chords"];
  tempoBpm: number;
  notes: readonly NoteEvent[];
  stimulusEndMs: number;
  responseWindowMs: number;
  source: InputSource;
  /** False grades the tones only: no early or late, and `partial` leaves timing out. */
  gradeTiming?: boolean;
}

/** Ids are `c<chord>.<tone>`; the chord index is read back from them. */
const chordIndexOf = (id: string): number => Number(id.slice(1, id.indexOf(".")));

/**
 * A progression of block chords, graded by performance alignment (T5.3). Every chord tone is an
 * expected note, so the alignment says, per tone, whether it was right, wrong, missed or off the
 * beat, and which extra notes were played. The line is correct when every tone has its right
 * pitch (nothing wrong or missed), at most `CHORD_MAX_EXTRA_NOTES` extra notes were played and the
 * overall score reaches `CHORD_PASS_OVERALL`; `partial` is the overall score. A chord rolled
 * within the source's clustering window counts as one chord.
 *
 * Errors, in order of importance: `chord.wrong-tone`, `chord.missed` (a whole chord) or
 * `chord.missing-tone`, `chord.extra`, then `chord.early` and `chord.late`. Each names the chord by
 * its index, numeral and symbol so feedback can say "in the IV chord". Latency is the first note
 * after the reference time, as in the other scorers.
 *
 * With `gradeTiming: false` (a chord read from the staff, T5.10) only the tones count: notes within
 * `TONES_ONLY_CLUSTER_MS` are one chord, nothing is early, late or short, and the overall score is
 * the pitch and completeness terms of the alignment, reweighted to sum to one.
 */
export function scoreChordLine(input: ChordLineInput): PartResult {
  const notes = inWindow(input.notes, input.stimulusEndMs, input.responseWindowMs);
  const first = notes[0];
  const expected: ExpectedNote[] = input.chords.flatMap((c, i) =>
    c.midi.map((midi, k) => ({
      id: `c${String(i)}.${String(k)}`,
      midi,
      onsetBeats: c.onsetBeats,
      durationBeats: c.durationBeats,
    })),
  );
  const performed: PerformedNote[] = notes.map((n) => ({
    midi: n.pitch,
    onsetMs: n.onsetMs,
    ...(n.offsetMs === undefined ? {} : { offsetMs: n.offsetMs }),
    ...(n.velocity === undefined ? {} : { velocity: n.velocity }),
  }));
  const timed = input.gradeTiming !== false;
  const result = alignPerformance({
    expected,
    tempoBpm: input.tempoBpm,
    performed,
    options: timed
      ? { source: input.source }
      : {
          source: input.source,
          clusterWindowMs: Math.max(TONES_ONLY_CLUSTER_MS, TOLERANCES[input.source].clusterMs),
        },
  });

  const byChord = new Map<number, NoteResult[]>();
  for (const r of result.notes) {
    const i = chordIndexOf(r.id);
    byChord.set(i, [...(byChord.get(i) ?? []), r]);
  }
  const label = (i: number): { index: number; roman: string; symbol: string } => {
    const c = req(input.chords[i]);
    return { index: i, roman: c.roman, symbol: c.symbol };
  };

  const wrong: AttemptError[] = [];
  const missed: AttemptError[] = [];
  const timing: AttemptError[] = [];
  let missing = 0;
  let wrongCount = 0;
  for (const [i, results] of byChord) {
    if (results.every((r) => r.cls === "missed")) {
      missed.push(err("chord.missed", label(i)));
      missing += results.length;
      continue;
    }
    for (const r of results) {
      if (r.cls === "wrongPitch") {
        wrongCount++;
        wrong.push(
          err("chord.wrong-tone", {
            ...label(i),
            expected: r.midi,
            played: r.playedMidi ?? r.midi,
          }),
        );
      } else if (r.cls === "missed") {
        missing++;
        missed.push(err("chord.missing-tone", { ...label(i), expected: r.midi }));
      }
    }
    // Timing is reported once per chord, from the tone furthest from the beat.
    const off = results
      .filter((r) => r.cls === "early" || r.cls === "late")
      .sort((a, b) => Math.abs(b.deviationMs ?? 0) - Math.abs(a.deviationMs ?? 0))[0];
    if (off !== undefined && timed) {
      timing.push(
        err(off.cls === "early" ? "chord.early" : "chord.late", {
          ...label(i),
          ms: Math.round(Math.abs(off.deviationMs ?? 0)),
        }),
      );
    }
  }
  const extra: AttemptError[] =
    result.extras.length === 0
      ? []
      : [
          err("chord.extra", {
            count: result.extras.length,
            played: req(result.extras[0]).midi,
          }),
        ];

  const errors = [...wrong, ...missed, ...extra, ...timing];
  if (first === undefined) errors.unshift(err("response.timeout"));
  const { pitchAccuracy, completeness } = result.summary;
  const overall = timed
    ? result.summary.overall
    : (OVERALL_WEIGHTS.pitch * pitchAccuracy + OVERALL_WEIGHTS.completeness * completeness) /
      (OVERALL_WEIGHTS.pitch + OVERALL_WEIGHTS.completeness);
  const outcome: AttemptOutcome = {
    correct:
      first !== undefined &&
      wrongCount === 0 &&
      missing === 0 &&
      result.extras.length <= CHORD_MAX_EXTRA_NOTES &&
      overall >= CHORD_PASS_OVERALL,
    latencyMs: first === undefined ? input.responseWindowMs : first.onsetMs - input.stimulusEndMs,
    retries: 0,
    partial: overall,
  };
  return { outcome, errors };
}
