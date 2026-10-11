import type { AttemptError, DegreeLabels, PitchFrame } from "@clavis/core";
import { compareSequences } from "./sequence.js";
import type { PartResult } from "./single.js";
import { degreeConfusion, err, foldCents, hzToMidi, median } from "./util.js";

export interface SungOptions {
  /** Minimum frame confidence. Default 0.8. */
  minConfidence: number;
  /** Minimum stable segment length for a single sung pitch. Default 200 ms. */
  minDurationMs: number;
  /** Maximum pitch range inside a stable segment. Default 50 cents. */
  maxRangeCents: number;
  /** Sequence splitting: pitch change from the segment median. Default 80 cents. */
  splitCents: number;
  /** Sequence splitting: gap between voiced frames. Default 120 ms. */
  maxGapMs: number;
  /** Minimum length of a note inside a sung sequence. Default 100 ms. */
  sequenceMinDurationMs: number;
}

export const SUNG_DEFAULTS: SungOptions = {
  minConfidence: 0.8,
  minDurationMs: 200,
  maxRangeCents: 50,
  splitCents: 80,
  maxGapMs: 120,
  sequenceMinDurationMs: 100,
};

export interface SungSegment {
  startMs: number;
  endMs: number;
  /** Median pitch as a fractional MIDI number. */
  midi: number;
}

type Mode =
  | { kind: "range"; maxRangeCents: number }
  | { kind: "split"; splitCents: number; maxGapMs: number };

function segmentFrames(
  frames: readonly PitchFrame[],
  minConfidence: number,
  minDurationMs: number,
  mode: Mode,
): SungSegment[] {
  const sorted = [...frames].sort((a, b) => a.atMs - b.atMs);
  const out: SungSegment[] = [];
  let cur: { t: number; m: number }[] = [];
  const flush = (): void => {
    const first = cur[0];
    const last = cur[cur.length - 1];
    if (first && last && last.t - first.t >= minDurationMs) {
      out.push({ startMs: first.t, endMs: last.t, midi: median(cur.map((p) => p.m)) });
    }
    cur = [];
  };
  for (const f of sorted) {
    const voiced = f.hz !== null && f.hz > 0 && f.confidence >= minConfidence;
    if (f.hz === null || !voiced) {
      if (mode.kind === "range") flush();
      continue;
    }
    const m = hzToMidi(f.hz);
    const last = cur[cur.length - 1];
    if (last) {
      const ms = cur.map((p) => p.m);
      const brk =
        mode.kind === "range"
          ? (Math.max(m, ...ms) - Math.min(m, ...ms)) * 100 > mode.maxRangeCents
          : f.atMs - last.t > mode.maxGapMs || Math.abs(m - median(ms)) * 100 > mode.splitCents;
      if (brk) flush();
    }
    cur.push({ t: f.atMs, m });
  }
  flush();
  return out;
}

/** Stable segments for a single held pitch (an unvoiced frame ends a segment). */
export function findStableSegments(
  frames: readonly PitchFrame[],
  o: Partial<SungOptions> = {},
): SungSegment[] {
  const c = { ...SUNG_DEFAULTS, ...o };
  return segmentFrames(frames, c.minConfidence, c.minDurationMs, {
    kind: "range",
    maxRangeCents: c.maxRangeCents,
  });
}

/** Note segments for a sung sequence (split on pitch change or gap). */
export function segmentSungNotes(
  frames: readonly PitchFrame[],
  o: Partial<SungOptions> = {},
): SungSegment[] {
  const c = { ...SUNG_DEFAULTS, ...o };
  return segmentFrames(frames, c.minConfidence, c.sequenceMinDurationMs, {
    kind: "split",
    splitCents: c.splitCents,
    maxGapMs: c.maxGapMs,
  });
}

function windowFrames(
  frames: readonly PitchFrame[],
  stimulusEndMs: number,
  windowMs: number,
): PitchFrame[] {
  return frames.filter((f) => f.atMs >= stimulusEndMs && f.atMs - stimulusEndMs <= windowMs);
}

export interface SungPitchInput {
  targetMidi: number;
  toleranceCents: number;
  frames: readonly PitchFrame[];
  stimulusEndMs: number;
  responseWindowMs: number;
  /** Optional: names degree confusions. SungPitchTarget carries no labels itself. */
  degreeLabels?: DegreeLabels | undefined;
  options?: Partial<SungOptions>;
}

/** Deviation beyond this many cents is a different note, not an intonation error. */
const CONFUSION_CENTS = 100;

export function scoreSungPitch(input: SungPitchInput): PartResult {
  const frames = windowFrames(input.frames, input.stimulusEndMs, input.responseWindowMs);
  const seg = findStableSegments(frames, input.options)[0];
  if (!seg) {
    return {
      outcome: { correct: false, latencyMs: input.responseWindowMs, retries: 0 },
      errors: [err("sing.none")],
    };
  }
  const dev = foldCents((seg.midi - input.targetMidi) * 100);
  const correct = Math.abs(dev) <= input.toleranceCents;
  const errors: AttemptError[] = [];
  if (!correct) {
    const rounded = Math.round(dev);
    if (Math.abs(dev) > CONFUSION_CENTS) {
      const playedMidi = input.targetMidi + Math.round(dev / 100);
      errors.push(
        degreeConfusion(input.degreeLabels, input.targetMidi, playedMidi, { cents: rounded }),
      );
    } else {
      errors.push(err(dev < 0 ? "sing.flat" : "sing.sharp", { cents: rounded }));
    }
  }
  return {
    outcome: { correct, latencyMs: seg.startMs - input.stimulusEndMs, retries: 0 },
    errors,
  };
}

export interface SungSequenceInput {
  midi: readonly number[];
  frames: readonly PitchFrame[];
  stimulusEndMs: number;
  responseWindowMs: number;
  degreeLabels?: DegreeLabels | undefined;
  options?: Partial<SungOptions>;
}

/** Sung sequences compare nearest pitch classes (octave agnostic). */
export function scoreSungSequence(input: SungSequenceInput): PartResult {
  const frames = windowFrames(input.frames, input.stimulusEndMs, input.responseWindowMs);
  const segs = segmentSungNotes(frames, input.options);
  const first = segs[0];
  if (!first) {
    return {
      outcome: { correct: false, latencyMs: input.responseWindowMs, retries: 0, partial: 0 },
      errors: [err("sing.none")],
    };
  }
  const r = compareSequences(
    input.midi,
    segs.map((s) => Math.round(s.midi)),
    { octaveAgnostic: true, degreeLabels: input.degreeLabels },
  );
  return {
    outcome: {
      correct: r.correct,
      latencyMs: first.startMs - input.stimulusEndMs,
      retries: 0,
      partial: r.partial,
    },
    errors: r.errors,
  };
}
