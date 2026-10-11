import { PitchDetector } from "pitchy";

export interface AnalyseOptions {
  /** Minimum MPM clarity (0..1) for a pitch to be reported. Default 0.85. */
  minClarity?: number;
  /** Lowest reportable frequency. Default 60 Hz. */
  minHz?: number;
  /** Highest reportable frequency. Default 1500 Hz. */
  maxHz?: number;
  /** Frames quieter than this (mean-removed RMS) are treated as silence. Default 0.002. */
  minRms?: number;
}

export interface FrameAnalysis {
  /** Null when the frame was rejected (silent, unclear or out of range). */
  hz: number | null;
  /** Raw MPM clarity, reported even when the pitch was rejected. */
  clarity: number;
  /** RMS of the window after removing its mean (DC offset). */
  rms: number;
}

export const DEFAULT_ANALYSE_OPTIONS = {
  minClarity: 0.85,
  minHz: 60,
  maxHz: 1500,
  minRms: 0.002,
} as const;

const detectors = new Map<number, PitchDetector<Float32Array>>();

function detectorFor(length: number): PitchDetector<Float32Array> {
  let d = detectors.get(length);
  if (!d) {
    d = PitchDetector.forFloat32Array(length);
    detectors.set(length, d);
  }
  return d;
}

/** RMS after removing the mean, so a DC offset from the microphone path does not look like energy. */
export function acRms(samples: ArrayLike<number>, start = 0, end = samples.length): number {
  const n = end - start;
  if (n <= 0) return 0;
  let sum = 0;
  let sumSq = 0;
  for (let i = start; i < end; i++) {
    const v = samples[i] ?? 0;
    sum += v;
    sumSq += v * v;
  }
  const m = sum / n;
  return Math.sqrt(Math.max(0, sumSq / n - m * m));
}

/** Pitch of one window of mono samples using the McLeod pitch method (pitchy). */
export function analyseFrame(
  samples: Float32Array,
  sampleRate: number,
  options: AnalyseOptions = {},
): FrameAnalysis {
  const minClarity = options.minClarity ?? DEFAULT_ANALYSE_OPTIONS.minClarity;
  const minHz = options.minHz ?? DEFAULT_ANALYSE_OPTIONS.minHz;
  const maxHz = options.maxHz ?? DEFAULT_ANALYSE_OPTIONS.maxHz;
  const minRms = options.minRms ?? DEFAULT_ANALYSE_OPTIONS.minRms;

  const rms = acRms(samples);
  if (rms < minRms) return { hz: null, clarity: 0, rms };
  const [hz, rawClarity] = detectorFor(samples.length).findPitch(samples, sampleRate);
  const clarity = Number.isFinite(rawClarity) ? Math.min(1, Math.max(0, rawClarity)) : 0;
  if (!Number.isFinite(hz) || hz < minHz || hz > maxHz || clarity < minClarity) {
    return { hz: null, clarity, rms };
  }
  return { hz, clarity, rms };
}
