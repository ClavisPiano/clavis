const SHARP_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"] as const;
const SPOKEN_NAMES = [
  "C",
  "C sharp",
  "D",
  "D sharp",
  "E",
  "F",
  "F sharp",
  "G",
  "G sharp",
  "A",
  "A sharp",
  "B",
] as const;
const BLACK = new Set([1, 3, 6, 8, 10]);

export const MIN_KEYBOARD_SPAN = 24;
export const DEFAULT_LOW = 48; // C3
export const DEFAULT_HIGH = 72; // C5

export function isBlackKey(midi: number): boolean {
  return BLACK.has(((midi % 12) + 12) % 12);
}

/** Short name with octave, middle C (60) is C4. */
export function noteName(midi: number): string {
  const pc = ((midi % 12) + 12) % 12;
  return `${SHARP_NAMES[pc] ?? "?"}${String(Math.floor(midi / 12) - 1)}`;
}

/** Name for screen readers: "C sharp 4". */
export function spokenNoteName(midi: number): string {
  const pc = ((midi % 12) + 12) % 12;
  return `${SPOKEN_NAMES[pc] ?? "?"} ${String(Math.floor(midi / 12) - 1)}`;
}

/** Clamp to MIDI range and widen to at least two octaves. */
export function normalizeRange(low: number, high: number): { low: number; high: number } {
  let lo = Math.max(0, Math.min(127, Math.round(low)));
  let hi = Math.max(0, Math.min(127, Math.round(high)));
  if (hi < lo) [lo, hi] = [hi, lo];
  if (hi - lo < MIN_KEYBOARD_SPAN) {
    hi = lo + MIN_KEYBOARD_SPAN;
    if (hi > 127) {
      hi = 127;
      lo = hi - MIN_KEYBOARD_SPAN;
    }
  }
  return { low: lo, high: hi };
}

export interface KeySlot {
  /** The white key of this slot. */
  white: number;
  /** The black key just above the white key, if it is in range. */
  black: number | undefined;
}

/** White keys in order, each carrying the black key to its right. A lone black low end is dropped. */
export function keySlots(low: number, high: number): KeySlot[] {
  const slots: KeySlot[] = [];
  for (let m = low; m <= high; m++) {
    if (isBlackKey(m)) {
      const last = slots[slots.length - 1];
      if (last?.white === m - 1) last.black = m;
      continue;
    }
    slots.push({ white: m, black: undefined });
  }
  return slots;
}
