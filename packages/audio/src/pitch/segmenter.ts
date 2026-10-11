import type { NoteEvent, PitchFrame } from "@clavis/core";
import { foldMidi, hzToMidi, mean, median, type MidiRange } from "./midi.js";
import type { EnergySample } from "./tracker.js";

export interface NoteSegmenterOptions {
  /**
   * Register the learner is expected to play or sing in. Detections are folded by whole octaves
   * into `[minMidi - 0.5, maxMidi + 0.5]` before they are used for note pitch. This repairs the
   * usual octave errors of MPM on piano (a strong second harmonic reported an octave high, or a
   * subharmonic an octave low) when the true note is inside the hint. It cannot help when the true
   * note is outside the hint, and for items that grade the octave itself the hint should be the
   * item's register, not the whole instrument.
   */
  expectedRange?: MidiRange;
  /** Floor for the onset threshold (RMS of one hop). Default 0.01. */
  minOnsetRms?: number;
  /** Onset threshold as a multiple of the running noise floor. Default 3 (about 9.5 dB). */
  onsetFloorRatio?: number;
  /** Minimum time between two onsets. Default 80 ms. */
  refractoryMs?: number;
  /** A note ends when the hop RMS stays below this fraction of the note's peak. Default 0.08. */
  releasePeakRatio?: number;
  /** ... and below this multiple of the noise floor. Default 2. */
  releaseFloorRatio?: number;
  /** Consecutive quiet hops needed to end a note. Default 2. */
  releaseHops?: number;
  /** Restrike without silence: energy must rise this much above the valley since the peak. Default 2. */
  restrikeRatio?: number;
  /** New pitch must differ from the held note by more than this to start a new note. Default 80. */
  pitchChangeCents?: number;
  /** Consecutive confident frames within `stableCents` needed to accept a pitch change. Default 6. */
  stableFrames?: number;
  /** Frames of a pitch run must stay within this many cents of the run mean. Default 45. */
  stableCents?: number;
  /** Frames earlier than this after onset are ignored (attack transient). Default 15 ms. */
  settleMs?: number;
  /** Length of the pitch estimation window after the settle time. Default 100 ms. */
  pitchWindowMs?: number;
  /** Fewest confident frames needed to accept a note. Default 2. */
  minConfidentFrames?: number;
  /** A note that cannot be pitched within this time after onset is dropped. Default 400 ms. */
  maxResolveMs?: number;
  /** Frames more than this apart mean the stream was interrupted, which ends the note. Default 100 ms. */
  maxGapMs?: number;
}

export const DEFAULT_SEGMENTER_OPTIONS = {
  minOnsetRms: 0.01,
  onsetFloorRatio: 3,
  refractoryMs: 80,
  releasePeakRatio: 0.08,
  releaseFloorRatio: 2,
  releaseHops: 2,
  restrikeRatio: 2,
  pitchChangeCents: 80,
  stableFrames: 6,
  stableCents: 45,
  settleMs: 15,
  pitchWindowMs: 100,
  minConfidentFrames: 2,
  maxResolveMs: 400,
  maxGapMs: 100,
} as const;

/** `start` fires once the pitch is known (no `offsetMs`); `end` fires with `offsetMs` set. */
export interface SegmenterEvent {
  type: "start" | "end";
  note: NoteEvent;
}

interface ActiveNote {
  onsetMs: number;
  /** Frames (midi, clarity, time) usable for the pitch estimate. */
  collected: { midi: number; clarity: number; atMs: number }[];
  /** All confident frame clarities, for the final mean. */
  allClarity: number[];
  resolved: boolean;
  dropped: boolean;
  pitch: number;
  /** Slowly tracked fractional pitch, used to spot pitch changes. */
  ref: number;
  peak: number;
  valley: number;
  quietHops: number;
  quietStartMs: number;
}

/**
 * Turns a stream of pitch frames and hop energies into note events.
 *
 * Onset: the hop RMS crosses `max(minOnsetRms, floor * onsetFloorRatio)`, where `floor` is a
 * running estimate of the idle noise level, and at least `refractoryMs` has passed since the last
 * onset. Inside a note, a restrike (same or different pitch with no silence) is a rise to more
 * than `restrikeRatio` times the lowest energy since the last peak. A sustained change of more
 * than `pitchChangeCents` also starts a new note (legato singing).
 *
 * Pitch: median fractional MIDI of the confident frames in the `pitchWindowMs` after the settle
 * time, rounded. Confidence: mean MPM clarity of those frames (the `end` event uses all frames of
 * the note).
 *
 * Offset: energy below the release threshold for `releaseHops` hops, or the next onset.
 *
 * `onsetMs` is the centre of the hop where the energy first crossed the threshold, so it is
 * accurate to about half a hop (6 ms at 44.1 kHz with the default hop) for sharp attacks and
 * later for slow ones.
 */
export class NoteSegmenter {
  readonly #o: Required<Omit<NoteSegmenterOptions, "expectedRange">>;
  readonly #range: MidiRange | undefined;
  #floor = 0;
  #lastOnsetMs = -Infinity;
  #lastEnergyEndMs = -Infinity;
  #note: ActiveNote | undefined;
  #armed = true;
  #idleValley = 0;
  #run: { midi: number; clarity: number; atMs: number }[] = [];

  constructor(options: NoteSegmenterOptions = {}) {
    const { expectedRange, ...rest } = options;
    this.#range = expectedRange;
    const merged: Record<string, number> = { ...DEFAULT_SEGMENTER_OPTIONS };
    for (const [k, v] of Object.entries(rest)) merged[k] = v;
    this.#o = merged as unknown as Required<Omit<NoteSegmenterOptions, "expectedRange">>;
  }

  /** Drop any note in progress without emitting it. The noise floor estimate is kept. */
  reset(): void {
    this.#note = undefined;
    this.#run = [];
    this.#lastOnsetMs = -Infinity;
    this.#lastEnergyEndMs = -Infinity;
    this.#armed = true;
  }

  /** End the note in progress (if any), e.g. at the end of a file. */
  flush(): SegmenterEvent[] {
    const out: SegmenterEvent[] = [];
    if (this.#note) this.#end(this.#lastEnergyEndMs, out);
    return out;
  }

  push(frame: PitchFrame, energy: EnergySample): SegmenterEvent[] {
    const o = this.#o;
    const out: SegmenterEvent[] = [];

    if (this.#note && energy.startMs - this.#lastEnergyEndMs > o.maxGapMs) {
      this.#end(this.#lastEnergyEndMs, out);
    }
    this.#lastEnergyEndMs = energy.endMs;

    const e = energy.rms;
    const hopMid = (energy.startMs + energy.endMs) / 2;
    const onsetThr = Math.max(o.minOnsetRms, this.#floor * o.onsetFloorRatio);
    const refractoryOk = hopMid - this.#lastOnsetMs >= o.refractoryMs;

    if (!this.#note) {
      // Re-arm after a release only once the energy has fallen below the onset threshold or has
      // risen well above its lowest point since the release (a restrike over a ringing tail).
      if (!this.#armed) {
        this.#idleValley = Math.min(this.#idleValley, e);
        if (e < onsetThr || e > this.#idleValley * o.restrikeRatio) this.#armed = true;
      }
      if (this.#armed && e >= onsetThr && refractoryOk) {
        this.#begin(hopMid, e);
      } else {
        // Idle: follow the noise floor down fast and up slowly.
        this.#floor += (e < this.#floor ? 0.5 : 0.02) * (e - this.#floor);
      }
    } else {
      const n = this.#note;
      // Energy tracking for release and restrike. The restrike test uses the state from before
      // this hop, because a restrike louder than the old peak would otherwise reset the valley.
      const valleyBefore = n.valley;
      const peakBefore = n.peak;
      if (e > n.peak) {
        n.peak = e;
        n.valley = e;
      } else if (e < n.valley) {
        n.valley = e;
      }
      const releaseThr = Math.max(
        o.minOnsetRms * 0.5,
        this.#floor * o.releaseFloorRatio,
        n.peak * o.releasePeakRatio,
      );
      if (e < releaseThr) {
        if (n.quietHops === 0) n.quietStartMs = energy.startMs;
        n.quietHops++;
        if (n.quietHops >= o.releaseHops) {
          this.#end(n.quietStartMs, out);
          this.#armed = false;
          this.#idleValley = e;
          return out;
        }
      } else {
        n.quietHops = 0;
        if (
          refractoryOk &&
          e >= onsetThr &&
          e > valleyBefore * o.restrikeRatio &&
          valleyBefore < 0.7 * peakBefore
        ) {
          this.#end(hopMid, out);
          this.#begin(hopMid, e);
        }
      }
    }

    this.#consumeFrame(frame, out);
    return out;
  }

  #midiOf(frame: PitchFrame): number | undefined {
    if (frame.hz === null) return undefined;
    const m = hzToMidi(frame.hz);
    return this.#range ? foldMidi(m, this.#range) : m;
  }

  #begin(onsetMs: number, e: number): void {
    this.#lastOnsetMs = onsetMs;
    this.#run = [];
    this.#note = {
      onsetMs,
      collected: [],
      allClarity: [],
      resolved: false,
      dropped: false,
      pitch: NaN,
      ref: NaN,
      peak: e,
      valley: e,
      quietHops: 0,
      quietStartMs: 0,
    };
  }

  #consumeFrame(frame: PitchFrame, out: SegmenterEvent[]): void {
    const n = this.#note;
    if (!n) return;
    const o = this.#o;
    const midi = this.#midiOf(frame);

    if (midi !== undefined && frame.atMs >= n.onsetMs) n.allClarity.push(frame.confidence);

    if (!n.resolved) {
      const first = n.collected[0];
      if (midi !== undefined && frame.atMs >= n.onsetMs + o.settleMs) {
        if (!first) n.collected.push({ midi, clarity: frame.confidence, atMs: frame.atMs });
        else if (frame.atMs <= first.atMs + o.pitchWindowMs) {
          n.collected.push({ midi, clarity: frame.confidence, atMs: frame.atMs });
        }
      }
      const head = n.collected[0];
      if (head && frame.atMs > head.atMs + o.pitchWindowMs) {
        this.#resolve(n, out);
      } else if (!head && !n.dropped && frame.atMs > n.onsetMs + o.maxResolveMs) {
        n.dropped = true;
      }
      return;
    }

    // Resolved: watch for a sustained pitch change.
    if (midi === undefined) return;
    const run = this.#run;
    const centre = run.length > 0 ? mean(run.map((r) => r.midi)) : midi;
    if (run.length > 0 && Math.abs(midi - centre) * 100 > o.stableCents) run.length = 0;
    run.push({ midi, clarity: frame.confidence, atMs: frame.atMs });
    if (run.length < o.stableFrames) return;

    const runMid = mean(run.map((r) => r.midi));
    if (
      Math.abs(runMid - n.ref) * 100 > o.pitchChangeCents &&
      frame.atMs - this.#lastOnsetMs >= o.refractoryMs
    ) {
      const first = run[0] as { atMs: number };
      const seed = [...run];
      this.#end(first.atMs, out);
      this.#begin(first.atMs, n.peak);
      const next = this.#note as unknown as ActiveNote;
      next.collected = seed;
      for (const r of seed) next.allClarity.push(r.clarity);
      this.#resolve(next, out);
    } else {
      n.ref += 0.1 * (runMid - n.ref);
    }
  }

  #resolve(n: ActiveNote, out: SegmenterEvent[]): void {
    if (n.resolved || n.dropped) return;
    if (n.collected.length < this.#o.minConfidentFrames) {
      n.dropped = true;
      return;
    }
    const mid = median(n.collected.map((c) => c.midi));
    n.pitch = Math.round(mid);
    n.ref = mid;
    n.resolved = true;
    this.#run = [];
    if (this.#valid(n.pitch)) {
      out.push({
        type: "start",
        note: {
          pitch: n.pitch,
          onsetMs: n.onsetMs,
          confidence: mean(n.collected.map((c) => c.clarity)),
          source: "mic",
        },
      });
    } else {
      n.dropped = true;
    }
  }

  #valid(pitch: number): boolean {
    return pitch >= 0 && pitch <= 127;
  }

  #end(offsetMs: number, out: SegmenterEvent[]): void {
    const n = this.#note;
    this.#note = undefined;
    this.#run = [];
    if (!n) return;
    // A very short note may end before its pitch window completed.
    if (!n.resolved && !n.dropped) {
      this.#resolve(n, out);
    }
    if (n.resolved && !n.dropped) {
      out.push({
        type: "end",
        note: {
          pitch: n.pitch,
          onsetMs: n.onsetMs,
          offsetMs: Math.max(offsetMs, n.onsetMs),
          confidence: mean(n.allClarity),
          source: "mic",
        },
      });
    }
  }
}
