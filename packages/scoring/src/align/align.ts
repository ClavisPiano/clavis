import { median, req } from "../util.js";
import { OVERALL_WEIGHTS, SHORT_FRACTION, TOLERANCES } from "./tolerances.js";
import type {
  AlignInput,
  AlignResult,
  ExpectedNote,
  ExtraResult,
  NoteResult,
  PerformedNote,
} from "./types.js";

/*
 * Performance alignment.
 *
 * 1. Group expected notes by onset (chords) and performed notes into onset clusters.
 * 2. Align the two event sequences with a DTW-style dynamic program (match, skip expected,
 *    skip cluster). A pair costs pitch-set mismatch plus a timing term measured against a local
 *    tempo model, so a take that is uniformly slow or drifting is not judged late note after note.
 * 3. The local tempo model is a robust piecewise-linear time warp over the matched anchors: the
 *    predicted time of an event is a Theil-Sen line (median slope, median intercept) through the
 *    K nearest anchors. Medians ignore a minority of outliers, so one late note does not drag
 *    its own prediction along, while a smooth drift is followed. (Leaving the note itself out
 *    was tried and judged edge notes late, because extrapolating a curved warp is worse than
 *    fitting through the note.) With only one or two anchors the line goes through the anchors
 *    themselves, so a very short take cannot be judged late: there is no tempo evidence.
 * 4. The model and the alignment depend on each other, so they iterate (a few rounds, until the
 *    matching stops changing). Round zero uses an affine guess from the count-in reference (or
 *    first onset) and the overall span of the take.
 *
 * Cost is O(n*m) per round with n and m in the hundreds. No clock, no randomness.
 */

/** Nearest anchors used for each local fit. Up to three outliers among seven are tolerated. */
const K_NEIGHBOURS = 7;
/** Most rounds of align-then-refit. */
const MAX_ROUNDS = 4;
/** Cost of leaving an expected event unmatched (missed) or a cluster unmatched (extra). */
const GAP_COST = 0.8;
/** Weight of the timing term relative to the pitch term (which spans 0 to 1). */
const TIME_WEIGHT = 0.5;
/** Timing term saturates at this many tolerances of deviation. */
const TIME_SATURATION = 4;
/** A pair with no shared pitch more than this many tolerances apart is a miss plus an extra. */
const WRONG_PITCH_MAX_TOL = 6;
/** Beat events closer than this are the same onset. */
const BEAT_EPS = 1e-6;
/** Local slope is kept within this factor of the global one. */
const SLOPE_CLAMP = 2;

interface EEvent {
  beats: number;
  /** Indices into `expected`. */
  notes: number[];
  pitches: Set<number>;
}

interface Cluster {
  onsetMs: number;
  /** Indices into `performed`. */
  notes: number[];
  pitches: Set<number>;
}

interface Anchor {
  ev: number;
  beats: number;
  ms: number;
}

interface Affine {
  offsetMs: number;
  beatMs: number;
}

interface Prediction {
  ms: number;
  /** Local beat duration in ms. */
  beatMs: number;
}

interface Pair {
  ev: number;
  cl: number;
}

function groupExpected(expected: readonly ExpectedNote[]): EEvent[] {
  const order = expected
    .map((_, i) => i)
    .sort((a, b) => {
      const d = req(expected[a]).onsetBeats - req(expected[b]).onsetBeats;
      return d !== 0 ? d : a - b;
    });
  const events: EEvent[] = [];
  for (const i of order) {
    const n = req(expected[i]);
    const last = events[events.length - 1];
    if (last !== undefined && Math.abs(n.onsetBeats - last.beats) <= BEAT_EPS) {
      last.notes.push(i);
      last.pitches.add(n.midi);
    } else {
      events.push({ beats: n.onsetBeats, notes: [i], pitches: new Set([n.midi]) });
    }
  }
  return events;
}

function clusterPerformed(performed: readonly PerformedNote[], windowMs: number): Cluster[] {
  const order = performed
    .map((_, i) => i)
    .sort((a, b) => {
      const pa = req(performed[a]);
      const pb = req(performed[b]);
      return pa.onsetMs - pb.onsetMs || pa.midi - pb.midi || a - b;
    });
  const clusters: Cluster[] = [];
  for (const i of order) {
    const n = req(performed[i]);
    const last = clusters[clusters.length - 1];
    if (last !== undefined && n.onsetMs - last.onsetMs <= windowMs) {
      last.notes.push(i);
      last.pitches.add(n.midi);
    } else {
      clusters.push({ onsetMs: n.onsetMs, notes: [i], pitches: new Set([n.midi]) });
    }
  }
  return clusters;
}

/** Theil-Sen line (median slope, then median intercept) through the points. */
function theilSen(
  pts: readonly Anchor[],
  fallbackSlope: number,
  lo: number,
  hi: number,
): { slope: number; ms: (beats: number) => number } {
  const slopes: number[] = [];
  for (let i = 0; i < pts.length; i++)
    for (let j = i + 1; j < pts.length; j++) {
      const a = req(pts[i]);
      const b = req(pts[j]);
      if (b.beats !== a.beats) slopes.push((b.ms - a.ms) / (b.beats - a.beats));
    }
  const raw = slopes.length > 0 ? median(slopes) : fallbackSlope;
  const slope = Math.min(hi, Math.max(lo, raw));
  const icpt = median(pts.map((p) => p.ms - slope * p.beats));
  return { slope, ms: (beats) => icpt + slope * beats };
}

class TimeModel {
  private readonly beatMs: number;
  constructor(
    private readonly anchors: readonly Anchor[],
    private readonly initial: Affine,
  ) {
    this.beatMs = this.globalBeatMs();
  }

  /** Global beat duration: median slope between anchors a few steps apart. */
  private globalBeatMs(): number {
    const a = this.anchors;
    const slopes: number[] = [];
    for (let i = 0; i < a.length; i++)
      for (let d = 1; d <= 8 && i + d < a.length; d++) {
        const p = req(a[i]);
        const q = req(a[i + d]);
        slopes.push((q.ms - p.ms) / (q.beats - p.beats));
      }
    if (slopes.length === 0) return this.initial.beatMs;
    const m = median(slopes);
    return Math.min(this.initial.beatMs * 2.5, Math.max(this.initial.beatMs * 0.4, m));
  }

  get globalBeat(): number {
    return this.beatMs;
  }

  /** Predicted time of `beats` from the nearest anchors. */
  predict(beats: number): Prediction {
    const few = this.anchors.length;
    if (few === 0) {
      return { ms: this.initial.offsetMs + beats * this.initial.beatMs, beatMs: this.beatMs };
    }
    if (few === 1) {
      const a = req(this.anchors[0]);
      return { ms: a.ms + (beats - a.beats) * this.beatMs, beatMs: this.beatMs };
    }
    const near = this.anchors
      .map((a) => ({ a, d: Math.abs(a.beats - beats) }))
      .sort((x, y) => x.d - y.d || x.a.ev - y.a.ev)
      .slice(0, K_NEIGHBOURS)
      .map((x) => x.a);
    const fit = theilSen(near, this.beatMs, this.beatMs / SLOPE_CLAMP, this.beatMs * SLOPE_CLAMP);
    return { ms: fit.ms(beats), beatMs: fit.slope };
  }
}

function jaccardCost(a: ReadonlySet<number>, b: ReadonlySet<number>): number {
  let common = 0;
  for (const m of a) if (b.has(m)) common++;
  const union = a.size + b.size - common;
  return union === 0 ? 0 : 1 - common / union;
}

function overlap(a: ReadonlySet<number>, b: ReadonlySet<number>): boolean {
  for (const m of a) if (b.has(m)) return true;
  return false;
}

/** DTW-style alignment of events to clusters. Returns monotone one-to-one pairs. */
function dtw(
  events: readonly EEvent[],
  clusters: readonly Cluster[],
  predicted: readonly number[],
  tolMs: number,
): { pairs: Pair[]; total: number } {
  const n = events.length;
  const m = clusters.length;
  const w = m + 1;
  const cost = new Float64Array((n + 1) * w);
  // 0 diagonal (match), 1 skip event (missed), 2 skip cluster (extra)
  const dir = new Uint8Array((n + 1) * w);
  for (let i = 1; i <= n; i++) {
    cost[i * w] = i * GAP_COST;
    dir[i * w] = 1;
  }
  for (let j = 1; j <= m; j++) {
    cost[j] = j * GAP_COST;
    dir[j] = 2;
  }
  for (let i = 1; i <= n; i++) {
    const ev = req(events[i - 1]);
    const pred = req(predicted[i - 1]);
    for (let j = 1; j <= m; j++) {
      const cl = req(clusters[j - 1]);
      const dev = Math.abs(cl.onsetMs - pred);
      const pair =
        jaccardCost(ev.pitches, cl.pitches) +
        TIME_WEIGHT * Math.min(1, dev / (TIME_SATURATION * tolMs));
      const diag = req(cost[(i - 1) * w + (j - 1)]) + pair;
      const up = req(cost[(i - 1) * w + j]) + GAP_COST;
      const left = req(cost[i * w + (j - 1)]) + GAP_COST;
      let best = diag;
      let d = 0;
      if (up < best) {
        best = up;
        d = 1;
      }
      if (left < best) {
        best = left;
        d = 2;
      }
      cost[i * w + j] = best;
      dir[i * w + j] = d;
    }
  }
  const pairs: Pair[] = [];
  let i = n;
  let j = m;
  while (i > 0 || j > 0) {
    const d = req(dir[i * w + j]);
    if (d === 0) {
      pairs.push({ ev: i - 1, cl: j - 1 });
      i--;
      j--;
    } else if (d === 1) i--;
    else j--;
  }
  return { pairs: pairs.reverse(), total: req(cost[n * w + m]) };
}

interface NoteMatch {
  /** Index into `expected`. */
  e: number;
  /** Index into `performed`. */
  pi: number;
  wrong: boolean;
}

/**
 * Match the notes of an aligned event and cluster: equal pitches first, then the remaining
 * expected notes against the remaining performed ones as wrong pitches, closest pitch first.
 * What is left over on either side is missed or extra.
 */
function assignNotes(
  ev: EEvent,
  cl: Cluster,
  expected: readonly ExpectedNote[],
  performed: readonly PerformedNote[],
): NoteMatch[] {
  const freeP = [...cl.notes];
  const freeE: number[] = [];
  const matched: NoteMatch[] = [];
  for (const ei of ev.notes) {
    const k = freeP.findIndex((pi) => req(performed[pi]).midi === req(expected[ei]).midi);
    if (k >= 0) {
      matched.push({ e: ei, pi: req(freeP[k]), wrong: false });
      freeP.splice(k, 1);
    } else freeE.push(ei);
  }
  while (freeE.length > 0 && freeP.length > 0) {
    let best = { a: 0, b: 0, d: Number.POSITIVE_INFINITY };
    freeE.forEach((ei, a) => {
      freeP.forEach((pi, b) => {
        const d = Math.abs(req(expected[ei]).midi - req(performed[pi]).midi);
        if (d < best.d) best = { a, b, d };
      });
    });
    matched.push({ e: req(freeE[best.a]), pi: req(freeP[best.b]), wrong: true });
    freeE.splice(best.a, 1);
    freeP.splice(best.b, 1);
  }
  return matched;
}

const signature = (pairs: readonly Pair[]): string =>
  pairs.map((p) => `${String(p.ev)}:${String(p.cl)}`).join(",");

/** Timing credit in [0,1]: full inside the tolerance, linearly to zero at three tolerances. */
function timingCredit(devMs: number, tolMs: number): number {
  const over = Math.abs(devMs) - tolMs;
  return over <= 0 ? 1 : Math.max(0, 1 - over / (2 * tolMs));
}

/**
 * Align a performance to the expected notes and classify every expected note and every extra
 * performed note. See the file comment for the method and `TOLERANCES` for the tolerances.
 */
export function alignPerformance(input: AlignInput): AlignResult {
  const { expected, performed, options } = input;
  if (!(input.tempoBpm > 0)) throw new RangeError("tempoBpm must be positive");
  const base = TOLERANCES[options.source];
  const tolMs = options.toleranceMs ?? base.onTimeMs;
  const shortFraction = options.shortFraction ?? SHORT_FRACTION;
  const nominalBeatMs = 60000 / input.tempoBpm;

  const events = groupExpected(expected);

  // Initial affine guess: the performer's overall pace from the span of the take.
  const rawOnsets = performed.map((p) => p.onsetMs).sort((a, b) => a - b);
  const firstRaw = rawOnsets[0] ?? 0;
  const lastRaw = rawOnsets[rawOnsets.length - 1] ?? 0;
  const firstBeat = events[0]?.beats ?? 0;
  const spanBeats = (events[events.length - 1]?.beats ?? 0) - firstBeat;
  let spanBeatMs = nominalBeatMs;
  if (spanBeats > 0 && lastRaw > firstRaw) {
    const r = (lastRaw - firstRaw) / (spanBeats * nominalBeatMs);
    if (r >= 0.4 && r <= 2.5) spanBeatMs = nominalBeatMs * r;
  }
  const guess = (beatMs: number): Affine => ({
    beatMs,
    offsetMs: input.countInRefMs ?? firstRaw - firstBeat * beatMs,
  });
  // Two starting guesses, nominal tempo and the take's overall pace. A stray note can distort
  // the second, so both are refined and the cheaper alignment wins (nominal first on ties).
  const starts = spanBeatMs === nominalBeatMs ? [nominalBeatMs] : [nominalBeatMs, spanBeatMs];

  // Cluster window: the source's, but never more than a fraction of the closest event gap.
  let window = options.clusterWindowMs ?? base.clusterMs;
  let minGap = Number.POSITIVE_INFINITY;
  for (let i = 1; i < events.length; i++)
    minGap = Math.min(minGap, req(events[i]).beats - req(events[i - 1]).beats);
  if (Number.isFinite(minGap)) {
    window = Math.min(window, Math.max(20, 0.45 * minGap * Math.min(...starts)));
  }
  const clusters = clusterPerformed(performed, window);

  const refine = (initial: Affine): { model: TimeModel; pairs: Pair[]; total: number } => {
    let model = new TimeModel([], initial);
    let pairs: Pair[] = [];
    let total = 0;
    let sig = "";
    for (let round = 0; round < MAX_ROUNDS; round++) {
      const predicted = events.map((e) => model.predict(e.beats).ms);
      const aligned = dtw(events, clusters, predicted, tolMs);
      total = aligned.total;
      pairs = aligned.pairs.filter((p) => {
        const ev = req(events[p.ev]);
        const cl = req(clusters[p.cl]);
        if (overlap(ev.pitches, cl.pitches)) return true;
        return Math.abs(cl.onsetMs - req(predicted[p.ev])) <= WRONG_PITCH_MAX_TOL * tolMs;
      });
      // An anchor sits at the earliest correctly pitched note of the pair, so a stray extra note
      // merged into the cluster cannot move it.
      const anchors: Anchor[] = [];
      for (const p of pairs) {
        const ev = req(events[p.ev]);
        const right = assignNotes(ev, req(clusters[p.cl]), expected, performed).filter(
          (m) => !m.wrong,
        );
        if (right.length === 0) continue;
        const ms = Math.min(...right.map((m) => req(performed[m.pi]).onsetMs));
        anchors.push({ ev: p.ev, beats: ev.beats, ms });
      }
      model = new TimeModel(anchors, initial);
      const s = signature(pairs);
      if (s === sig) break;
      sig = s;
    }
    return { model, pairs, total };
  };
  let best = refine(guess(req(starts[0])));
  for (const b of starts.slice(1)) {
    const cand = refine(guess(b));
    if (cand.total < best.total) best = cand;
  }
  const { model, pairs } = best;

  const results: NoteResult[] = expected.map((n) => ({ id: n.id, midi: n.midi, cls: "missed" }));
  const usedPerformed = new Set<number>();
  const credits: number[] = [];
  let pitchCorrect = 0;

  for (const p of pairs) {
    const ev = req(events[p.ev]);
    const cl = req(clusters[p.cl]);
    const pred = model.predict(ev.beats);
    const clusterDev = cl.onsetMs - pred.ms;
    for (const m of assignNotes(ev, cl, expected, performed)) {
      const exp = req(expected[m.e]);
      const perf = req(performed[m.pi]);
      usedPerformed.add(m.pi);
      const r = req(results[m.e]);
      r.performedIndex = m.pi;
      if (m.wrong) {
        r.deviationMs = clusterDev;
        r.cls = "wrongPitch";
        r.playedMidi = perf.midi;
        continue;
      }
      const dev = perf.onsetMs - pred.ms;
      r.deviationMs = dev;
      pitchCorrect++;
      const heldMs = perf.offsetMs === undefined ? undefined : perf.offsetMs - perf.onsetMs;
      let credit = timingCredit(dev, tolMs);
      if (Math.abs(dev) > tolMs) r.cls = dev < 0 ? "early" : "late";
      else if (heldMs !== undefined && heldMs < shortFraction * exp.durationBeats * pred.beatMs) {
        r.cls = "short";
        credit = Math.min(credit, 0.5);
      } else r.cls = "correct";
      credits.push(credit);
    }
    // Expected notes left in `freeE` stay `missed`; performed ones left in `freeP` become extras.
  }

  const extras: ExtraResult[] = [];
  performed.forEach((p, i) => {
    if (!usedPerformed.has(i)) extras.push({ performedIndex: i, midi: p.midi, onsetMs: p.onsetMs });
  });

  const N = expected.length;
  const present = results.filter((r) => r.cls !== "missed").length;
  const completeness = N === 0 ? 1 : present / N;
  const pitchAccuracy = N + extras.length === 0 ? 1 : pitchCorrect / (N + extras.length);
  const timingAccuracy =
    credits.length > 0 ? credits.reduce((s, c) => s + c, 0) / credits.length : N === 0 ? 1 : 0;
  const overall = Math.min(
    1,
    OVERALL_WEIGHTS.pitch * pitchAccuracy +
      OVERALL_WEIGHTS.timing * timingAccuracy +
      OVERALL_WEIGHTS.completeness * completeness,
  );

  return {
    notes: results,
    extras,
    summary: { pitchAccuracy, timingAccuracy, completeness, overall },
    tempoRatio: model.globalBeat / nominalBeatMs,
  };
}
