import { degreeToMidi } from "./degrees.js";
import { type Key, type Midi, type VoiceRange, tonicChroma } from "./keys.js";
import { at } from "./util.js";

export interface Chord {
  roman: string;
  bass: Midi;
  upper: Midi[];
}
export interface Cadence {
  chords: Chord[];
}
export interface CadenceOptions {
  /** Range for the bass root. Default C2..C3 (36..48). Must span at least an octave. */
  bassRange?: VoiceRange;
  /** Range for the three upper voices. Default G3..E5 (55..76). Use at least 14 semitones. */
  upperRange?: VoiceRange;
}

export const DEFAULT_BASS_RANGE: VoiceRange = { low: 36, high: 48 };
export const DEFAULT_UPPER_RANGE: VoiceRange = { low: 55, high: 76 };
/** Upper voices move by at most a perfect fourth between consecutive chords. */
export const MAX_VOICE_LEAP = 5;

interface Spec {
  roman: string;
  degrees: readonly [number, number, number];
}

function specs(key: Key): Spec[] {
  const minor = key.mode === "minor";
  const I: Spec = { roman: minor ? "i" : "I", degrees: [1, 3, 5] };
  const IV: Spec = { roman: minor ? "iv" : "IV", degrees: [4, 6, 8] };
  const V: Spec = { roman: "V", degrees: [5, 7, 9] };
  return [I, IV, V, I];
}

/** Pitch classes of a chord. Harmonic minor is used so that minor V has the raised 7th. */
function chordChromas(key: Key, s: Spec): [number, number, number] {
  const t = 60 + tonicChroma(key);
  const pc = (d: number): number => degreeToMidi(key, d, t, { minorVariant: "harmonic" }) % 12;
  const [a, b, c] = s.degrees;
  return [pc(a), pc(b), pc(c)];
}

/** All close-position voicings (any inversion) with every note inside the range, lowest first. */
function closeVoicings(chromas: [number, number, number], range: VoiceRange): Midi[][] {
  const out: Midi[][] = [];
  for (let rot = 0; rot < 3; rot++) {
    const order = [0, 1, 2].map((i) => at(chromas, (rot + i) % 3));
    for (let low = range.low; low <= range.high; low++) {
      if (low % 12 !== at(order, 0)) continue;
      const v: Midi[] = [low];
      for (let i = 1; i < 3; i++) {
        let n = at(v, i - 1) + 1;
        while (n % 12 !== at(order, i)) n++;
        v.push(n);
      }
      if (at(v, 2) <= range.high) out.push(v);
    }
  }
  return out;
}

const movement = (a: Midi[], b: Midi[]): number =>
  a.reduce((s, x, i) => s + Math.abs(x - at(b, i)), 0);
const maxLeap = (a: Midi[], b: Midi[]): number =>
  Math.max(...a.map((x, i) => Math.abs(x - at(b, i))));

/**
 * I-IV-V-I (major) or i-iv-V-i (minor, harmonic V) as a bass root plus three close-position
 * upper voices. See `voiceLead` for how the voices are chosen. Throws RangeError if the ranges
 * cannot hold a valid cadence.
 */
export function cadence(key: Key, opts: CadenceOptions = {}): Cadence {
  return { chords: voiceLead(key, specs(key), opts) };
}

/** Root scale degree of each diatonic major triad, by Roman numeral. */
export const MAJOR_ROMAN_ROOTS: Readonly<Record<string, number>> = {
  I: 1,
  ii: 2,
  iii: 3,
  IV: 4,
  V: 5,
  vi: 6,
};

/** Roman numerals `progression` accepts (major keys). */
export const MAJOR_ROMANS: readonly string[] = Object.keys(MAJOR_ROMAN_ROOTS);

/**
 * A chord progression in a major key as a bass root plus three close-position upper voices, one
 * `Chord` per numeral (I, ii, iii, IV, V, vi). Voiced like `cadence`, so a progression and a
 * cadence sound alike. Throws RangeError for a minor key, an unknown numeral or an empty list.
 */
export function progression(
  key: Key,
  romans: readonly string[],
  opts: CadenceOptions = {},
): Chord[] {
  if (key.mode !== "major") throw new RangeError("progression supports major keys only");
  if (romans.length === 0) throw new RangeError("progression needs at least one chord");
  const sp = romans.map((roman): Spec => {
    const root = MAJOR_ROMAN_ROOTS[roman];
    if (root === undefined) throw new RangeError(`unknown Roman numeral: ${roman}`);
    return { roman, degrees: [root, root + 2, root + 4] };
  });
  return voiceLead(key, sp, opts);
}

/**
 * Voice a chord sequence. Upper voicings minimise total movement by dynamic programming, subject
 * to every voice moving at most MAX_VOICE_LEAP semitones. Voices are ordered ascending, so they
 * never cross. Ties resolve to the earliest candidate (lowest, root position first): the output
 * is deterministic.
 */
function voiceLead(key: Key, sp: Spec[], opts: CadenceOptions): Chord[] {
  const bassRange = opts.bassRange ?? DEFAULT_BASS_RANGE;
  const upperRange = opts.upperRange ?? DEFAULT_UPPER_RANGE;
  if (bassRange.high - bassRange.low < 11)
    throw new RangeError("bassRange must span at least an octave");
  const cands = sp.map((s) => closeVoicings(chordChromas(key, s), upperRange));
  if (cands.some((c) => c.length === 0))
    throw new RangeError("upperRange too narrow for the cadence voicings");

  const cost: number[][] = [];
  const back: number[][] = [];
  cands.forEach((cs, i) => {
    const costs = cs.map(() => Infinity);
    const backs = cs.map(() => -1);
    cost.push(costs);
    back.push(backs);
    cs.forEach((v, j) => {
      if (i === 0) {
        costs[j] = 0;
        return;
      }
      at(cands, i - 1).forEach((p, k) => {
        if (maxLeap(p, v) > MAX_VOICE_LEAP) return;
        const c = at(at(cost, i - 1), k) + movement(p, v);
        if (c < at(costs, j)) {
          costs[j] = c;
          backs[j] = k;
        }
      });
    });
  });
  const final = at(cost, cost.length - 1);
  let j = final.reduce((bi, c, i) => (c < at(final, bi) ? i : bi), 0);
  if (!Number.isFinite(at(final, j)))
    throw new RangeError("no voice-led cadence fits the given ranges");
  const picked: Midi[][] = [];
  for (let i = cands.length - 1; i >= 0; i--) {
    picked[i] = at(at(cands, i), j);
    j = at(at(back, i), j);
  }

  // Bass root: nearest the previous bass (first chord: nearest the range centre). Ties go lower.
  const centre = (bassRange.low + bassRange.high) / 2;
  let prev = centre;
  const chords = sp.map((s, i): Chord => {
    const rootChroma = at(chordChromas(key, s), 0);
    let best = -1;
    for (let n = bassRange.low; n <= bassRange.high; n++) {
      if (n % 12 !== rootChroma) continue;
      if (best < 0 || Math.abs(n - prev) < Math.abs(best - prev)) best = n;
    }
    prev = best;
    return { roman: s.roman, bass: best, upper: at(picked, i) };
  });
  if (chords.some((c) => c.bass >= at(c.upper, 0))) {
    throw new RangeError("bass must stay below the upper voices");
  }
  return chords;
}
