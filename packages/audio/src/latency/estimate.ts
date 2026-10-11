/**
 * Latency estimator (architecture 4.2). Pure: no clock, no randomness.
 *
 * Given the scheduled click times and the observed response times (taps or microphone onsets),
 * both in AudioContext ms, pair each observation to the nearest click, discard the settling pairs
 * at the start, reject outliers by median absolute deviation, and report the median delta.
 * A positive offset means the response arrived later than the click was scheduled.
 */

export interface LatencyEstimateOptions {
  /** An observation pairs with a click only if within this many ms. Default 250. */
  windowMs?: number;
  /** Pairs (in click order) discarded before estimating. Default 2. */
  skip?: number;
  /** Outlier threshold in scaled MADs. Default 3. */
  madK?: number;
  /** Fewer usable pairs than this is not ok. Default 5. */
  minPairs?: number;
  /** A spread (MAD, ms) above this is not ok. Default 40. */
  maxSpreadMs?: number;
}

export interface LatencyEstimate {
  /** Median delta of the used pairs, ms. 0 when nothing was usable. */
  offsetMs: number;
  /** Median absolute deviation of the used deltas, ms. */
  spreadMs: number;
  /** Pairs that contributed to the offset. */
  used: number;
  /** Observations that were discarded: unpaired, duplicates, settling, or outliers. */
  rejected: number;
  ok: boolean;
}

/** Factor that makes the MAD comparable to a standard deviation for normal data. */
const MAD_SCALE = 1.4826;
/** The outlier band never shrinks below this, so a near-perfect run does not reject itself. */
const MIN_BAND_MS = 3;

function medianOf(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  const hi = sorted[mid] ?? 0;
  return sorted.length % 2 === 1 ? hi : ((sorted[mid - 1] ?? 0) + hi) / 2;
}

/** Median absolute deviation about `center` (the median by default). */
function madOf(values: readonly number[], center = medianOf(values)): number {
  return medianOf(values.map((v) => Math.abs(v - center)));
}

interface Pair {
  clickIndex: number;
  delta: number;
}

export function estimateLatency(
  clicksMs: readonly number[],
  observedMs: readonly number[],
  options: LatencyEstimateOptions = {},
): LatencyEstimate {
  const windowMs = options.windowMs ?? 250;
  const skip = options.skip ?? 2;
  const madK = options.madK ?? 3;
  const minPairs = options.minPairs ?? 5;
  const maxSpreadMs = options.maxSpreadMs ?? 40;

  // 1. Pair each observation with its nearest click inside the window.
  const candidates: Pair[] = [];
  for (const obs of observedMs) {
    let best = -1;
    let bestAbs = Infinity;
    clicksMs.forEach((c, i) => {
      const a = Math.abs(obs - c);
      if (a < bestAbs) {
        bestAbs = a;
        best = i;
      }
    });
    if (best >= 0 && bestAbs <= windowMs) {
      candidates.push({ clickIndex: best, delta: obs - (clicksMs[best] ?? 0) });
    }
  }

  // 2. One observation per click (double taps). Keep the one closest to the typical delta of the
  // clicks that were answered once; if every click was doubled, of all candidates.
  const byClick = new Map<number, Pair[]>();
  for (const p of candidates) {
    const list = byClick.get(p.clickIndex);
    if (list) list.push(p);
    else byClick.set(p.clickIndex, [p]);
  }
  const singles = [...byClick.values()].filter((l) => l.length === 1).map((l) => l[0]?.delta ?? 0);
  const typical = medianOf(singles.length > 0 ? singles : candidates.map((p) => p.delta));
  const pairs: Pair[] = [];
  for (const list of byClick.values()) {
    const first = list[0];
    if (!first) continue;
    pairs.push(
      list.reduce(
        (best, p) => (Math.abs(p.delta - typical) < Math.abs(best.delta - typical) ? p : best),
        first,
      ),
    );
  }
  pairs.sort((a, b) => a.clickIndex - b.clickIndex);

  // 3. Drop the settling pairs, then reject outliers about the median.
  const settled = pairs.slice(skip).map((p) => p.delta);
  const center = medianOf(settled);
  const band = Math.max(madK * MAD_SCALE * madOf(settled, center), MIN_BAND_MS);
  const kept = settled.filter((d) => Math.abs(d - center) <= band);

  const offsetMs = medianOf(kept);
  const spreadMs = madOf(kept, offsetMs);
  const used = kept.length;
  return {
    offsetMs,
    spreadMs,
    used,
    rejected: observedMs.length - used,
    ok: used >= minPairs && spreadMs <= maxSpreadMs,
  };
}
