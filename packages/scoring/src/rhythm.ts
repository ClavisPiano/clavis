import type { AttemptError, InputSource, NoteEvent } from "@clavis/core";
import type { PartResult } from "./single.js";
import { err, inWindow, req } from "./util.js";

/** On-time tolerance in ms by input source (spec 11: mic is noisier than MIDI). */
export const RHYTHM_TOLERANCE_MS: Record<InputSource, number> = {
  midi: 60,
  tap: 80,
  mic: 100,
};

/** Fitted tempo differing from the target by more than this fraction is reported. */
export const TEMPO_DRIFT_THRESHOLD = 0.15;

export interface RhythmInput {
  onsetsBeats: readonly number[];
  tempoBpm: number;
  notes: readonly NoteEvent[];
  stimulusEndMs: number;
  responseWindowMs: number;
  source: InputSource;
  /** Override the per-source tolerance. */
  toleranceMs?: number;
}

export type RhythmClass = "on-time" | "early" | "late" | "missed";

export interface RhythmAnalysis {
  /** One entry per expected onset. `residualMs` is played minus fitted time. */
  expected: { cls: RhythmClass; residualMs?: number }[];
  /** Played onsets that matched no expected onset. */
  extraOnsetsMs: number[];
  /** Fitted learner tempo in BPM, or null when it could not be fitted. */
  fittedBpm: number | null;
}

interface Pair {
  e: number;
  p: number;
}
interface Fit {
  a: number;
  b: number;
  fitted: boolean;
}

function fitLine(points: readonly { x: number; y: number }[], nominalB: number): Fit {
  const first = points[0];
  if (!first) return { a: 0, b: nominalB, fitted: false };
  const n = points.length;
  const mx = points.reduce((s, p) => s + p.x, 0) / n;
  const my = points.reduce((s, p) => s + p.y, 0) / n;
  let sxx = 0;
  let sxy = 0;
  for (const p of points) {
    sxx += (p.x - mx) ** 2;
    sxy += (p.x - mx) * (p.y - my);
  }
  if (n >= 2 && sxx > 1e-9) {
    const b = sxy / sxx;
    if (b >= nominalB * 0.4 && b <= nominalB * 2.5) return { a: my - b * mx, b, fitted: true };
  }
  return { a: first.y - nominalB * first.x, b: nominalB, fitted: false };
}

const fitPairs = (pairs: readonly Pair[], beats: readonly number[], nominalB: number): Fit =>
  fitLine(
    pairs.map((q) => ({ x: req(beats[q.e]), y: q.p })),
    nominalB,
  );

function matchFrom(
  beats: readonly number[],
  played: readonly number[],
  k: number,
  j: number,
  b0: number,
  tol: number,
  minGapBeats: number,
): { pairs: Pair[] } {
  const pairs: Pair[] = [{ e: k, p: j }];
  let ptr = j + 1;
  for (let i = k + 1; i < beats.length; i++) {
    const pts = pairs.map((q) => ({ x: req(beats[q.e]), y: req(played[q.p]) }));
    // With a short beat span the slope is unreliable: use the nominal tempo with a mean
    // offset and widen the window with distance, so a uniformly slower or faster start
    // still matches. Otherwise use the least squares line, widened by slope uncertainty.
    const xs = pts.map((q) => q.x);
    const range = Math.max(...xs) - Math.min(...xs);
    const early = range < 1;
    const fit: Fit = early
      ? {
          a: pts.reduce((s, q) => s + q.y - b0 * q.x, 0) / pts.length,
          b: b0,
          fitted: false,
        }
      : fitLine(pts, b0);
    const target = req(beats[i]);
    const predicted = fit.a + fit.b * target;
    const dist = Math.abs(target - xs.reduce((s, x) => s + x, 0) / xs.length);
    // Nearest-first matching resolves ambiguity, so the window can be generous.
    const cap = Math.max(tol * 1.5, 0.45 * minGapBeats * Math.max(fit.b, b0));
    const w = early ? Math.max(cap, Math.min(0.25 * dist * b0, 0.6 * minGapBeats * b0)) : cap;
    let best = -1;
    let bestD = Infinity;
    for (let q = ptr; q < played.length; q++) {
      const d = Math.abs(req(played[q]) - predicted);
      if (d < bestD) {
        bestD = d;
        best = q;
      }
      if (req(played[q]) > predicted + w) break;
    }
    if (best >= 0 && bestD <= w) {
      pairs.push({ e: i, p: best });
      ptr = best + 1;
    }
  }
  return { pairs };
}

/** Pure analysis, exported for tests. `playedMs` are onsets relative to anything (one clock). */
export function analyseRhythm(
  onsetsBeats: readonly number[],
  tempoBpm: number,
  playedMs: readonly number[],
  tol: number,
): RhythmAnalysis {
  const b0 = 60000 / tempoBpm;
  const played = [...playedMs].sort((x, y) => x - y);
  let minGap = Infinity;
  for (let i = 1; i < onsetsBeats.length; i++) {
    const g = req(onsetsBeats[i]) - req(onsetsBeats[i - 1]);
    if (g > 0) minGap = Math.min(minGap, g);
  }
  if (!Number.isFinite(minGap)) minGap = 1;

  let bestPairs: Pair[] = [];
  let bestCost = Infinity;
  for (let k = 0; k < Math.min(2, onsetsBeats.length); k++) {
    for (let j = 0; j < Math.min(3, played.length); j++) {
      const { pairs } = matchFrom(onsetsBeats, played, k, j, b0, tol, minGap);
      const fit = fitPairs(
        pairs.map((q) => ({ e: q.e, p: req(played[q.p]) })),
        onsetsBeats,
        b0,
      );
      const resid = pairs.reduce(
        (s, q) => s + Math.abs(req(played[q.p]) - (fit.a + fit.b * req(onsetsBeats[q.e]))),
        0,
      );
      const cost = -pairs.length * 1e6 + resid;
      if (cost < bestCost) {
        bestCost = cost;
        bestPairs = pairs;
      }
    }
  }

  const withPlayed = bestPairs.map((q) => ({ e: q.e, p: req(played[q.p]) }));
  const residual = (f: Fit, q: { e: number; p: number }): number =>
    q.p - (f.a + f.b * req(onsetsBeats[q.e]));
  const toPts = (qs: readonly { e: number; p: number }[]) =>
    qs.map((q) => ({ x: req(onsetsBeats[q.e]), y: q.p }));
  // Robust refit: ignore outliers so one bad note does not shift the others.
  let inliers = withPlayed;
  let fit = fitLine(toPts(inliers), b0);
  for (let it = 0; it < 4; it++) {
    const next = withPlayed.filter((q) => Math.abs(residual(fit, q)) <= tol);
    if (next.length === 0 || next.length === inliers.length) break;
    inliers = next;
    fit = fitLine(toPts(inliers), b0);
  }

  const expected: RhythmAnalysis["expected"] = onsetsBeats.map(() => ({ cls: "missed" }));
  const matchedPlayed = new Set<number>();
  for (const q of bestPairs) {
    matchedPlayed.add(q.p);
    const r = residual(fit, { e: q.e, p: req(played[q.p]) });
    expected[q.e] = {
      cls: Math.abs(r) <= tol ? "on-time" : r < 0 ? "early" : "late",
      residualMs: r,
    };
  }
  const extraOnsetsMs = played.filter((_, i) => !matchedPlayed.has(i));
  return { expected, extraOnsetsMs, fittedBpm: fit.fitted ? 60000 / fit.b : null };
}

/** Rhythm scoring on timing only, relative to the learner's own tempo and offset. */
export function scoreRhythm(input: RhythmInput): PartResult {
  const tol = input.toleranceMs ?? RHYTHM_TOLERANCE_MS[input.source];
  const notes = inWindow(input.notes, input.stimulusEndMs, input.responseWindowMs);
  const a = analyseRhythm(
    input.onsetsBeats,
    input.tempoBpm,
    notes.map((n) => n.onsetMs),
    tol,
  );
  const total = a.expected.length;
  const onTime = a.expected.filter((x) => x.cls === "on-time").length;

  const missed: AttemptError[] = [];
  const timing: { e: AttemptError; mag: number }[] = [];
  a.expected.forEach((x, i) => {
    const beat = req(input.onsetsBeats[i]);
    if (x.cls === "missed") missed.push(err("rhythm.missed", { index: i, beat }));
    else if (x.cls !== "on-time") {
      const ms = Math.round(x.residualMs ?? 0);
      timing.push({ e: err(`rhythm.${x.cls}`, { index: i, beat, ms }), mag: Math.abs(ms) });
    }
  });
  timing.sort((p, q) => q.mag - p.mag);
  const extras = a.extraOnsetsMs.map((t) =>
    err("rhythm.extra", { atMs: Math.round(t - input.stimulusEndMs) }),
  );
  const errors = [...missed, ...timing.map((t) => t.e), ...extras];
  if (a.fittedBpm !== null) {
    const drift = (a.fittedBpm - input.tempoBpm) / input.tempoBpm;
    if (Math.abs(drift) > TEMPO_DRIFT_THRESHOLD) {
      errors.push(
        err("rhythm.tempo-drift", {
          fittedBpm: Math.round(a.fittedBpm * 10) / 10,
          targetBpm: input.tempoBpm,
          ratio: Math.round((a.fittedBpm / input.tempoBpm) * 100) / 100,
        }),
      );
    }
  }
  const first = notes[0];
  return {
    outcome: {
      correct: onTime === total && extras.length === 0,
      latencyMs: first === undefined ? input.responseWindowMs : first.onsetMs - input.stimulusEndMs,
      retries: 0,
      partial: total === 0 ? 1 : onTime / total,
    },
    errors: first === undefined ? [err("response.timeout"), ...errors] : errors,
  };
}
