import type { AttemptError, AttemptOutcome, DegreeLabels, NoteEvent } from "@clavis/core";
import type { PartResult } from "./single.js";
import { degreeLabel, err, inWindow, pc, req } from "./util.js";

export type AlignOp =
  | { op: "match"; expectedIndex: number; playedIndex: number }
  | { op: "sub"; expectedIndex: number; playedIndex: number }
  | { op: "missing"; expectedIndex: number }
  | { op: "extra"; playedIndex: number };

export interface Alignment {
  distance: number;
  ops: AlignOp[];
}

/** Levenshtein alignment with backtrace. Ties prefer match/substitution over gaps. */
export function align<T>(
  expected: readonly T[],
  played: readonly T[],
  eq: (a: T, b: T) => boolean = (a, b) => a === b,
): Alignment {
  const n = expected.length;
  const m = played.length;
  const d: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  const at = (i: number, j: number): number => d[i]?.[j] ?? 0;
  const set = (i: number, j: number, v: number): void => {
    req(d[i])[j] = v;
  };
  for (let i = 0; i <= n; i++) set(i, 0, i);
  for (let j = 0; j <= m; j++) set(0, j, j);
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      const cost = eq(expected[i - 1] as T, played[j - 1] as T) ? 0 : 1;
      set(i, j, Math.min(at(i - 1, j - 1) + cost, at(i - 1, j) + 1, at(i, j - 1) + 1));
    }
  }
  const ops: AlignOp[] = [];
  let i = n;
  let j = m;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0) {
      const same = eq(expected[i - 1] as T, played[j - 1] as T);
      if (at(i, j) === at(i - 1, j - 1) + (same ? 0 : 1)) {
        ops.push({ op: same ? "match" : "sub", expectedIndex: i - 1, playedIndex: j - 1 });
        i--;
        j--;
        continue;
      }
    }
    if (i > 0 && at(i, j) === at(i - 1, j) + 1) {
      ops.push({ op: "missing", expectedIndex: i - 1 });
      i--;
    } else {
      ops.push({ op: "extra", playedIndex: j - 1 });
      j--;
    }
  }
  ops.reverse();
  return { distance: at(n, m), ops };
}

export interface SequenceScore {
  correct: boolean;
  partial: number;
  distance: number;
  errors: AttemptError[];
}

type Detail = Record<string, number | string | boolean>;

/** Compare played MIDI numbers to expected ones. Errors: wrong-note, missing, extra. */
export function compareSequences(
  expected: readonly number[],
  played: readonly number[],
  opts: { octaveAgnostic: boolean; degreeLabels?: DegreeLabels | undefined },
): SequenceScore {
  const eq = opts.octaveAgnostic
    ? (a: number, b: number) => pc(a) === pc(b)
    : (a: number, b: number) => a === b;
  const { distance, ops } = align(expected, played, eq);
  const wrong: AttemptError[] = [];
  const missing: AttemptError[] = [];
  const extra: AttemptError[] = [];
  for (const o of ops) {
    if (o.op === "sub") {
      const e = req(expected[o.expectedIndex]);
      const p = req(played[o.playedIndex]);
      const detail: Detail = { index: o.expectedIndex, expected: e, played: p };
      const el = degreeLabel(opts.degreeLabels, e);
      const pl = degreeLabel(opts.degreeLabels, p);
      if (el !== undefined) detail.expectedDegree = el;
      if (pl !== undefined) detail.playedDegree = pl;
      if (pc(e) === pc(p)) detail.octave = true;
      wrong.push(err("sequence.wrong-note", detail));
    } else if (o.op === "missing") {
      const e = req(expected[o.expectedIndex]);
      const detail: Detail = { index: o.expectedIndex, expected: e };
      const el = degreeLabel(opts.degreeLabels, e);
      if (el !== undefined) detail.expectedDegree = el;
      missing.push(err("sequence.missing", detail));
    } else if (o.op === "extra") {
      const p = req(played[o.playedIndex]);
      extra.push(err("sequence.extra", { index: o.playedIndex, played: p }));
    }
  }
  const denom = Math.max(expected.length, played.length);
  return {
    correct: distance === 0,
    partial: denom === 0 ? 1 : 1 - distance / denom,
    distance,
    errors: [...wrong, ...missing, ...extra],
  };
}

export interface SequenceInput {
  midi: readonly number[];
  octaveAgnostic: boolean;
  degreeLabels?: DegreeLabels | undefined;
  notes: readonly NoteEvent[];
  stimulusEndMs: number;
  responseWindowMs: number;
}

/** Score a played sequence. Latency is the first note's onset after the stimulus. */
export function scoreSequence(input: SequenceInput): PartResult {
  const notes = inWindow(input.notes, input.stimulusEndMs, input.responseWindowMs);
  const first = notes[0];
  const r = compareSequences(
    input.midi,
    notes.map((n) => n.pitch),
    { octaveAgnostic: input.octaveAgnostic, degreeLabels: input.degreeLabels },
  );
  const outcome: AttemptOutcome = {
    correct: r.correct,
    latencyMs: first === undefined ? input.responseWindowMs : first.onsetMs - input.stimulusEndMs,
    retries: 0,
    partial: r.partial,
  };
  const errors = first === undefined ? [err("response.timeout"), ...r.errors] : r.errors;
  return { outcome, errors };
}
