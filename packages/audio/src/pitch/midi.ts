/** Equal-tempered helpers. A4 = MIDI 69 = 440 Hz. */

export const A4_HZ = 440;

/** Fractional MIDI number for a frequency. */
export function hzToMidi(hz: number): number {
  return 69 + 12 * Math.log2(hz / A4_HZ);
}

export function midiToHz(midi: number): number {
  return A4_HZ * Math.pow(2, (midi - 69) / 12);
}

/** Signed distance in cents from the nearest equal-tempered note, in [-50, 50]. */
export function centsFromNearest(hz: number): number {
  const m = hzToMidi(hz);
  return (m - Math.round(m)) * 100;
}

export interface MidiRange {
  minMidi: number;
  maxMidi: number;
}

/**
 * Shift `midi` by whole octaves so it lies inside `[minMidi - slack, maxMidi + slack]`. If no
 * octave shift fits (the range is narrower than an octave and the value falls in the gap), the
 * input is returned unchanged.
 */
export function foldMidi(midi: number, range: MidiRange, slack = 0.5): number {
  const lo = range.minMidi - slack;
  const hi = range.maxMidi + slack;
  if (midi >= lo && midi <= hi) return midi;
  const k = midi < lo ? Math.ceil((lo - midi) / 12) : -Math.ceil((midi - hi) / 12);
  const folded = midi + 12 * k;
  return folded >= lo && folded <= hi ? folded : midi;
}

export function median(values: readonly number[]): number {
  if (values.length === 0) return NaN;
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 === 1 ? (s[mid] ?? NaN) : ((s[mid - 1] ?? NaN) + (s[mid] ?? NaN)) / 2;
}

export function mean(values: readonly number[]): number {
  if (values.length === 0) return 0;
  let sum = 0;
  for (const v of values) sum += v;
  return sum / values.length;
}
