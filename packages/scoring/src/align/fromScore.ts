import type { Hand, ScoreSpec, StaffSpec } from "@clavis/core";
import type { ExpectedNote } from "./types.js";

const STEP_SEMITONES = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 } as const;

/*
 * `scoring` may only `import type` from core, so the small bits of duration and pitch arithmetic
 * are repeated here. They match core's `durationBeats` and `spelledToMidi`.
 */

/** The hand that reads a staff (R27): treble is the right hand, bass the left. */
const HAND: Record<StaffSpec["clef"], Hand | undefined> = {
  treble: "rh",
  bass: "lh",
  percussion: undefined,
};

/** Expected notes of one staff, in its own document order. */
function staffNotes(staff: StaffSpec, beatValue: number): ExpectedNote[] {
  const hand = HAND[staff.clef];
  const out: ExpectedNote[] = [];
  /** Open ties by midi: the note that a continuing tie extends. */
  const open = new Map<number, ExpectedNote>();
  let t = 0;
  for (const measure of staff.measures) {
    for (const el of measure) {
      const beats = (beatValue / el.duration.value) * (el.duration.dots === 1 ? 1.5 : 1);
      if (el.kind === "note") {
        const tie = el.duration.tie;
        const tiedIn = tie === "stop" || tie === "continue";
        const tiesOn = tie === "start" || tie === "continue";
        el.pitches.forEach((p, k) => {
          const midi = (p.octave + 1) * 12 + STEP_SEMITONES[p.step] + p.alter;
          const prev = tiedIn ? open.get(midi) : undefined;
          let n: ExpectedNote;
          if (prev !== undefined) {
            prev.durationBeats += beats;
            n = prev;
          } else {
            n = {
              id: el.pitches.length === 1 ? el.id : `${el.id}.${String(k)}`,
              midi,
              onsetBeats: t,
              durationBeats: beats,
              ...(hand === undefined ? {} : { hand }),
            };
            out.push(n);
          }
          if (tiesOn) open.set(midi, n);
          else open.delete(midi);
        });
      }
      t += beats;
    }
  }
  return out;
}

/**
 * Expected notes of every staff of a score, tagged with the hand of their staff (R27). Beats are
 * of the meter's beat value (quarter when there is no meter), as in core's `lineNotes`, and beat 0
 * is the start of the first measure. Rests only advance time. A note tied to the previous one of
 * the same pitch on the same staff lengthens it and adds no note. A chord note gets the ids `n3.0`,
 * `n3.1`, ... so ids stay unique. Notes are in onset order; notes that start together keep staff
 * order (treble first) and then document order.
 */
export function expectedFromScore(score: ScoreSpec): ExpectedNote[] {
  const beatValue = score.meter?.beatValue ?? 4;
  // Array.prototype.sort is stable, so equal onsets keep the staff-by-staff order.
  return score.staves
    .flatMap((staff) => staffNotes(staff, beatValue))
    .sort((a, b) => a.onsetBeats - b.onsetBeats);
}
