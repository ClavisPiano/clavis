/**
 * Calibration click track. Synthesised with an oscillator and a gain envelope, so it sounds the
 * same on every device and needs no samples (works offline, no load step).
 */

/** The slice of a node this module connects. */
interface NodeLike {
  connect(destination: unknown): unknown;
}
interface ParamLike {
  value: number;
  setValueAtTime(value: number, time: number): unknown;
  linearRampToValueAtTime(value: number, time: number): unknown;
  exponentialRampToValueAtTime(value: number, time: number): unknown;
}
export interface ClickContextLike {
  readonly currentTime: number;
  readonly destination: unknown;
  createOscillator(): NodeLike & {
    type: string;
    frequency: ParamLike;
    start(when: number): void;
    stop(when: number): void;
  };
  createGain(): NodeLike & { gain: ParamLike };
}

export interface ClickTrackOptions {
  count?: number;
  bpm?: number;
  /** Seconds from now to the first click. */
  leadInSec?: number;
  /** Click pitch in Hz. */
  frequencyHz?: number;
  /** Peak gain, 0..1. */
  gain?: number;
}

export const DEFAULT_CLICK_COUNT = 12;
export const DEFAULT_CLICK_BPM = 100;
export const CLICK_LEAD_IN_SEC = 1;

export interface ScheduledClicks {
  /** Scheduled click times on the AudioContext clock, ms. */
  clickTimesMs: number[];
  /** When the last click has finished sounding, ms. */
  endMs: number;
}

/** Schedule `count` clicks. Returns the exact times given to the audio clock. */
export function scheduleClickTrack(
  ctx: ClickContextLike,
  options: ClickTrackOptions = {},
): ScheduledClicks {
  const count = options.count ?? DEFAULT_CLICK_COUNT;
  const beat = 60 / (options.bpm ?? DEFAULT_CLICK_BPM);
  const first = ctx.currentTime + (options.leadInSec ?? CLICK_LEAD_IN_SEC);
  const peak = options.gain ?? 0.8;
  const times: number[] = [];
  for (let i = 0; i < count; i++) {
    const t = first + i * beat;
    times.push(t * 1000);
    const osc = ctx.createOscillator();
    osc.type = "sine";
    osc.frequency.value = options.frequencyHz ?? 2400;
    const env = ctx.createGain();
    env.gain.setValueAtTime(0, t);
    env.gain.linearRampToValueAtTime(peak, t + 0.001);
    env.gain.exponentialRampToValueAtTime(0.001, t + 0.04);
    osc.connect(env);
    env.connect(ctx.destination);
    osc.start(t);
    osc.stop(t + 0.05);
  }
  return { clickTimesMs: times, endMs: (first + (count - 1) * beat + 0.05) * 1000 };
}
