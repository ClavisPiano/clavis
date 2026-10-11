import type { NoteEvent } from "@clavis/core";
import { median } from "../pitch/midi.js";
import type { PipelineOptions } from "../pitch/pipeline.js";
import { runWavBytes } from "./runner.js";
import type { FixtureEntry, FixtureKind, FixtureManifest, TruthNote } from "./manifest.js";

/**
 * Accuracy harness: run each manifest entry through the pipeline, match detected notes to ground
 * truth, and compute metrics per entry and per kind. Pure apart from the injected `readFile`.
 *
 * Matching is greedy in time order. For each truth note we take the unmatched detected note whose
 * onset is within the tolerance, preferring the same MIDI pitch, then the closest onset. A match
 * pairs onsets; it counts as a true positive for precision/recall only when the pitch is exact.
 */

export const DEFAULT_ONSET_TOLERANCE_MS = 100;

export interface MatchPair {
  truth: TruthNote;
  detectedPitch: number;
  onsetErrorMs: number;
}

export interface MatchResult {
  pairs: MatchPair[];
  truthCount: number;
  detectedCount: number;
}

export function matchNotes(
  truth: readonly TruthNote[],
  detected: readonly Pick<NoteEvent, "pitch" | "onsetMs">[],
  toleranceMs = DEFAULT_ONSET_TOLERANCE_MS,
): MatchResult {
  const t = [...truth].sort((a, b) => a.onsetMs - b.onsetMs);
  const d = [...detected].sort((a, b) => a.onsetMs - b.onsetMs);
  const used = new Array<boolean>(d.length).fill(false);
  const pairs: MatchPair[] = [];
  for (const note of t) {
    let best = -1;
    let bestSame = false;
    let bestErr = Infinity;
    for (let i = 0; i < d.length; i++) {
      const cand = d[i];
      if (cand === undefined || used[i] === true) continue;
      const err = Math.abs(cand.onsetMs - note.onsetMs);
      if (err > toleranceMs) continue;
      const same = cand.pitch === note.midi;
      if ((same && !bestSame) || (same === bestSame && err < bestErr)) {
        best = i;
        bestSame = same;
        bestErr = err;
      }
    }
    const hit = d[best];
    if (hit !== undefined) {
      used[best] = true;
      pairs.push({
        truth: note,
        detectedPitch: hit.pitch,
        onsetErrorMs: Math.abs(hit.onsetMs - note.onsetMs),
      });
    }
  }
  return { pairs, truthCount: t.length, detectedCount: d.length };
}

/** Raw counts, so entries can be pooled exactly into per-kind totals. */
export interface Counts {
  truth: number;
  detected: number;
  /** Onset-matched pairs. */
  matched: number;
  /** Matched pairs with the exact MIDI pitch. */
  exact: number;
  /** Matched pairs with the right pitch class. */
  pitchClass: number;
  /** Matched pairs with the right pitch class but the wrong octave. */
  octaveErrors: number;
  onsetErrorsMs: number[];
}

export interface Metrics {
  truth: number;
  detected: number;
  matched: number;
  precision: number | null;
  recall: number | null;
  f1: number | null;
  /** Exact MIDI among onset-matched notes. */
  pitchExact: number | null;
  /** Pitch class among onset-matched notes. */
  pitchClass: number | null;
  octaveErrorRate: number | null;
  onsetMedianMs: number | null;
  onsetP90Ms: number | null;
}

export function emptyCounts(): Counts {
  return {
    truth: 0,
    detected: 0,
    matched: 0,
    exact: 0,
    pitchClass: 0,
    octaveErrors: 0,
    onsetErrorsMs: [],
  };
}

export function countsFromMatch(m: MatchResult): Counts {
  const c = emptyCounts();
  c.truth = m.truthCount;
  c.detected = m.detectedCount;
  c.matched = m.pairs.length;
  for (const p of m.pairs) {
    const samePc = (((p.detectedPitch - p.truth.midi) % 12) + 12) % 12 === 0;
    if (p.detectedPitch === p.truth.midi) c.exact++;
    if (samePc) c.pitchClass++;
    if (samePc && p.detectedPitch !== p.truth.midi) c.octaveErrors++;
    c.onsetErrorsMs.push(p.onsetErrorMs);
  }
  return c;
}

export function addCounts(a: Counts, b: Counts): Counts {
  return {
    truth: a.truth + b.truth,
    detected: a.detected + b.detected,
    matched: a.matched + b.matched,
    exact: a.exact + b.exact,
    pitchClass: a.pitchClass + b.pitchClass,
    octaveErrors: a.octaveErrors + b.octaveErrors,
    onsetErrorsMs: [...a.onsetErrorsMs, ...b.onsetErrorsMs],
  };
}

/** Nearest-rank percentile of a non-empty list, `p` in [0, 1]. */
export function percentile(values: readonly number[], p: number): number {
  const s = [...values].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil(p * s.length));
  return s[Math.min(s.length, rank) - 1] ?? NaN;
}

const ratio = (num: number, den: number): number | null => (den === 0 ? null : num / den);

export function metricsFromCounts(c: Counts): Metrics {
  const precision = ratio(c.exact, c.detected);
  const recall = ratio(c.exact, c.truth);
  const f1 =
    precision === null || recall === null
      ? null
      : precision + recall === 0
        ? 0
        : (2 * precision * recall) / (precision + recall);
  const has = c.onsetErrorsMs.length > 0;
  return {
    truth: c.truth,
    detected: c.detected,
    matched: c.matched,
    precision,
    recall,
    f1,
    pitchExact: ratio(c.exact, c.matched),
    pitchClass: ratio(c.pitchClass, c.matched),
    octaveErrorRate: ratio(c.octaveErrors, c.matched),
    onsetMedianMs: has ? median(c.onsetErrorsMs) : null,
    onsetP90Ms: has ? percentile(c.onsetErrorsMs, 0.9) : null,
  };
}

export interface AccuracyReport {
  overall: Metrics;
  byKind: Partial<Record<FixtureKind, Metrics>>;
  entries: Record<string, Metrics>;
}

/** Score already-detected notes against a manifest. `detected` maps entry id to notes. */
export function scoreDetections(
  manifest: FixtureManifest,
  detected: ReadonlyMap<string, readonly Pick<NoteEvent, "pitch" | "onsetMs">[]>,
  toleranceMs = DEFAULT_ONSET_TOLERANCE_MS,
): AccuracyReport {
  const entries: Record<string, Metrics> = {};
  const kinds = new Map<FixtureKind, Counts>();
  let all = emptyCounts();
  for (const e of manifest) {
    const counts = countsFromMatch(matchNotes(e.notes, detected.get(e.id) ?? [], toleranceMs));
    entries[e.id] = metricsFromCounts(counts);
    kinds.set(e.kind, addCounts(kinds.get(e.kind) ?? emptyCounts(), counts));
    all = addCounts(all, counts);
  }
  const byKind: Partial<Record<FixtureKind, Metrics>> = {};
  for (const [k, c] of kinds) byKind[k] = metricsFromCounts(c);
  return { overall: metricsFromCounts(all), byKind, entries };
}

export function pipelineOptionsFor(entry: FixtureEntry): PipelineOptions {
  return entry.expectedRange === undefined
    ? {}
    : {
        segmenter: {
          expectedRange: { minMidi: entry.expectedRange.low, maxMidi: entry.expectedRange.high },
        },
      };
}

/** Run every entry through the pipeline. `readFile` receives `entry.file` joined to `baseDir`. */
export async function runAccuracy(
  manifest: FixtureManifest,
  readFile: (path: string) => Promise<Uint8Array>,
  options: { baseDir?: string; toleranceMs?: number } = {},
): Promise<AccuracyReport> {
  const base = options.baseDir === undefined ? "" : options.baseDir.replace(/\/+$/, "") + "/";
  const detected = new Map<string, NoteEvent[]>();
  for (const e of manifest) {
    const bytes = await readFile(base + e.file);
    detected.set(e.id, runWavBytes(bytes, pipelineOptionsFor(e)).notes);
  }
  return scoreDetections(manifest, detected, options.toleranceMs);
}

// ---------------------------------------------------------------------------------------------
// Baseline comparison and report

export interface BaselineFile {
  version: 1;
  onsetToleranceMs: number;
  report: AccuracyReport;
}

export interface Tolerance {
  /** F1 may not drop by more than this. Default 0.02. */
  f1Drop: number;
  /** Median onset error may not worsen by more than this many ms. Default 10. */
  onsetMedianMs: number;
}

export const DEFAULT_TOLERANCE: Tolerance = { f1Drop: 0.02, onsetMedianMs: 10 };

/** Round numbers so the committed baseline is stable and readable. */
export function roundReport(r: AccuracyReport): AccuracyReport {
  const rm = (m: Metrics): Metrics => {
    const out: Record<string, number | null> = { ...m };
    for (const [k, v] of Object.entries(out)) {
      if (typeof v === "number" && !Number.isInteger(v)) out[k] = Math.round(v * 10000) / 10000;
    }
    return out as unknown as Metrics;
  };
  return {
    overall: rm(r.overall),
    byKind: Object.fromEntries(Object.entries(r.byKind).map(([k, v]) => [k, rm(v)])),
    entries: Object.fromEntries(Object.entries(r.entries).map(([k, v]) => [k, rm(v)])),
  };
}

/** Returns a list of human-readable regressions. Empty means the run is within tolerance. */
export function compareToBaseline(
  current: AccuracyReport,
  baseline: AccuracyReport,
  tolerance: Tolerance = DEFAULT_TOLERANCE,
): string[] {
  const problems: string[] = [];
  const check = (label: string, cur: Metrics | undefined, base: Metrics | undefined): void => {
    if (base === undefined) {
      problems.push(`${label}: not in baseline (run accuracy:update and commit the result)`);
      return;
    }
    if (cur === undefined) {
      problems.push(`${label}: in baseline but no longer in the manifest (run accuracy:update)`);
      return;
    }
    const eps = 1e-9;
    if (base.f1 !== null && (cur.f1 ?? 0) < base.f1 - tolerance.f1Drop - eps) {
      problems.push(
        `${label}: F1 ${fmt(cur.f1, 3)} is more than ${String(tolerance.f1Drop)} below baseline ${fmt(base.f1, 3)}`,
      );
    }
    if (base.onsetMedianMs !== null) {
      if (cur.onsetMedianMs === null) {
        problems.push(
          `${label}: no onsets matched, baseline median ${fmt(base.onsetMedianMs, 1)} ms`,
        );
      } else if (cur.onsetMedianMs > base.onsetMedianMs + tolerance.onsetMedianMs + eps) {
        problems.push(
          `${label}: median onset error ${fmt(cur.onsetMedianMs, 1)} ms is more than ${String(tolerance.onsetMedianMs)} ms worse than baseline ${fmt(base.onsetMedianMs, 1)} ms`,
        );
      }
    }
  };
  check("overall", current.overall, baseline.overall);
  const kinds = new Set([...Object.keys(current.byKind), ...Object.keys(baseline.byKind)]);
  for (const k of kinds) {
    check(`kind ${k}`, current.byKind[k as FixtureKind], baseline.byKind[k as FixtureKind]);
  }
  const ids = new Set([...Object.keys(current.entries), ...Object.keys(baseline.entries)]);
  for (const id of ids) check(`entry ${id}`, current.entries[id], baseline.entries[id]);
  return problems;
}

function fmt(v: number | null, digits: number): string {
  return v === null ? "n/a" : v.toFixed(digits);
}

/** Markdown report committed as `fixtures/audio/REPORT.md`. */
export function formatReport(
  manifest: FixtureManifest,
  report: AccuracyReport,
  toleranceMs = DEFAULT_ONSET_TOLERANCE_MS,
): string {
  const cells = (m: Metrics): string =>
    [
      m.truth,
      m.detected,
      fmt(m.precision, 3),
      fmt(m.recall, 3),
      fmt(m.f1, 3),
      fmt(m.pitchExact, 3),
      fmt(m.pitchClass, 3),
      fmt(m.octaveErrorRate, 3),
      fmt(m.onsetMedianMs, 1),
      fmt(m.onsetP90Ms, 1),
    ].join(" | ");
  const cols =
    "Truth | Detected | Precision | Recall | F1 | Pitch exact | Pitch class | Octave err | Onset median ms | Onset p90 ms";
  const rule = "---|".repeat(10);
  const lines = [
    "# Audio fixture accuracy",
    "",
    "Generated by `pnpm --filter @clavis/audio accuracy:update`. Do not edit by hand.",
    "",
    `Onset match tolerance: ${String(toleranceMs)} ms. Precision and recall count a note only when the onset matches and the MIDI pitch is exact. Pitch and octave columns are measured over onset-matched notes. Onset errors are absolute.`,
    "",
    "## Overall and by kind",
    "",
    `| | ${cols} |`,
    `|---|${rule}`,
    `| all | ${cells(report.overall)} |`,
    ...Object.entries(report.byKind).map(([k, m]) => `| ${k} | ${cells(m)} |`),
    "",
    "## Entries",
    "",
    `| Entry | Kind | Instrument | Device | ${cols} |`,
    `|---|---|---|---|${rule}`,
    ...manifest.flatMap((e) => {
      const m = report.entries[e.id];
      return m === undefined
        ? []
        : [`| ${e.id} | ${e.kind} | ${e.instrument} | ${e.device} | ${cells(m)} |`];
    }),
    "",
  ];
  return lines.join("\n");
}
