import { midiToHz } from "./midi.js";

/**
 * Deterministic test signals. Not used at runtime; exported so the fixture tests of later tasks can
 * build in-memory audio without recorded files.
 */

export type Timbre = "sine" | "piano" | "vowel";

export interface SynthNote {
  midi: number;
  startSec: number;
  durSec: number;
  /** Peak amplitude, default 0.3. */
  amp?: number;
  timbre?: Timbre;
  /** Vibrato depth in cents (vowel only). Default 20. */
  vibratoCents?: number;
}

const TWO_PI = 2 * Math.PI;

/** Mix notes into a buffer of `totalSec`. */
export function renderNotes(
  notes: readonly SynthNote[],
  sampleRate: number,
  totalSec: number,
): Float32Array {
  const out = new Float32Array(Math.round(totalSec * sampleRate));
  for (const n of notes) {
    const timbre = n.timbre ?? "piano";
    const amp = n.amp ?? 0.3;
    const f0 = midiToHz(n.midi);
    const start = Math.round(n.startSec * sampleRate);
    const len = Math.round(n.durSec * sampleRate);
    let phase = 0;
    for (let i = 0; i < len && start + i < out.length; i++) {
      const t = i / sampleRate;
      let v: number;
      if (timbre === "sine") {
        v = Math.sin(TWO_PI * f0 * t) * rampEnvelope(i, len, sampleRate, 0.004, 0.004);
      } else if (timbre === "piano") {
        // Inharmonic-free partials 1..8 with a weak fundamental for low notes, as on real pianos.
        const weak = n.midi < 48 ? 0.5 : 1;
        let s = 0;
        for (let h = 1; h <= 8; h++) {
          if (f0 * h > sampleRate / 2.2) break;
          s += ((h === 1 ? weak : 1) / Math.pow(h, 1.1)) * Math.sin(TWO_PI * f0 * h * t);
        }
        const env = Math.min(1, t / 0.004) * Math.exp(-t / 0.7);
        v = s * 0.55 * env * releaseGain(i, len, sampleRate, 0.01);
      } else {
        const cents = (n.vibratoCents ?? 20) * Math.sin(TWO_PI * 5 * t);
        phase += (TWO_PI * f0 * Math.pow(2, cents / 1200)) / sampleRate;
        let s = 0;
        // Rough "ah" shape: strong first harmonics, a bump around the 6th.
        for (let h = 1; h <= 10; h++) {
          const w = 1 / h + (h === 6 ? 0.2 : 0);
          s += w * Math.sin(h * phase);
        }
        v = s * 0.5 * rampEnvelope(i, len, sampleRate, 0.03, 0.03);
      }
      out[start + i] = (out[start + i] ?? 0) + amp * v;
    }
  }
  return out;
}

function rampEnvelope(i: number, len: number, sr: number, attackSec: number, releaseSec: number) {
  const a = Math.min(1, i / (attackSec * sr));
  const r = Math.min(1, (len - 1 - i) / (releaseSec * sr));
  return Math.max(0, Math.min(a, r));
}

function releaseGain(i: number, len: number, sr: number, releaseSec: number): number {
  return Math.max(0, Math.min(1, (len - 1 - i) / (releaseSec * sr)));
}

/** Seeded white noise in [-amp, amp]. */
export function whiteNoise(length: number, amp: number, seed = 1): Float32Array {
  const out = new Float32Array(length);
  let s = seed >>> 0 || 1;
  for (let i = 0; i < length; i++) {
    // xorshift32
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    out[i] = (s / 0xffffffff - 0.5) * 2 * amp;
  }
  return out;
}
