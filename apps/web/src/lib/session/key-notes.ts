import {
  DEFAULT_KEYBOARD_RANGE,
  degreeLabels,
  degreeToMidi,
  degreeToPitchClass,
  tonicChroma,
  type ItemInstance,
  type Key,
  type MinorVariant,
  type SkillNode,
} from "@clavis/core";

/*
 * Names the notes of the key for degree items, so the learner does not have to work out the key
 * as well as the degree: "G major: 1 = G, 3 = B, 5 = D". Also the answer line shown after a miss.
 */

export interface KeyNote {
  /** Degree label as the exercise names it: "1", "3", "b3". */
  label: string;
  /** Spelled note name: "G", "Bb". */
  note: string;
}

export interface KeyNotes {
  /** "G major". */
  key: string;
  notes: KeyNote[];
}

const DEGREE_GENERATORS = new Set(["degreeSing", "degreeId"]);

function keyOf(presentation: ItemInstance["presentation"]): Key | undefined {
  const { tonic, mode } = presentation;
  if (typeof tonic !== "string" || (mode !== "major" && mode !== "minor")) return undefined;
  return { tonic, mode };
}

function variantOf(presentation: ItemInstance["presentation"]): MinorVariant | undefined {
  const v = presentation.minorVariant;
  return v === "natural" || v === "harmonic" || v === "melodic" ? v : undefined;
}

function noteFor(key: Key, degree: number, variant: MinorVariant | undefined): KeyNote {
  const opts = variant === undefined ? undefined : { minorVariant: variant };
  const note = degreeToPitchClass(key, degree, opts);
  // Labels are indexed by pitch class (C = 0), so go through a MIDI note to pick the label.
  const pc = degreeToMidi(key, degree, 60 + tonicChroma(key), opts) % 12;
  return { label: degreeLabels(key, opts)[pc] ?? String(degree), note };
}

function degreesOf(node: SkillNode | undefined): number[] {
  const d = node?.params.degrees;
  return Array.isArray(d) ? d.filter((x): x is number => typeof x === "number") : [];
}

/** The notes a degree item may ask for, spelled in its key. Undefined for other items. */
export function keyNotes(item: ItemInstance, node: SkillNode | undefined): KeyNotes | undefined {
  if (!DEGREE_GENERATORS.has(item.generator)) return undefined;
  const key = keyOf(item.presentation);
  const degrees = degreesOf(node);
  if (!key || degrees.length === 0) return undefined;
  const variant = variantOf(item.presentation);
  return {
    key: `${key.tonic} ${key.mode}`,
    notes: degrees.map((d) => noteFor(key, d, variant)),
  };
}

/** After a miss: what the answer was, e.g. "The note was 3, which is B in G major." */
export function answerLine(item: ItemInstance): string | undefined {
  const key = keyOf(item.presentation);
  if (!key) return undefined;
  const variant = variantOf(item.presentation);
  const degree = item.presentation.degree;
  if (typeof degree === "number") {
    const n = noteFor(key, degree, variant);
    return `The note was ${n.label}, which is ${n.note} in ${key.tonic} ${key.mode}.`;
  }
  const cell = item.presentation.cell;
  if (Array.isArray(cell) && cell.every((d) => typeof d === "number")) {
    const ns = cell.map((d) => noteFor(key, d, variant));
    return `The notes were ${ns.map((n) => n.label).join(" ")}, which is ${ns
      .map((n) => n.note)
      .join(" ")} in ${key.tonic} ${key.mode}.`;
  }
  return undefined;
}

/** What the guide keyboard marks: home note and home chord, as pitch classes (C = 0). */
export interface KeyboardGuide {
  low: number;
  high: number;
  /** Scrolled into view. */
  focus: number;
  tonicPc: number;
  /** Pitch classes of 1, 3 and 5. */
  chordPcs: number[];
}

const GUIDE_GENERATORS = new Set(["degreeSing", "degreeId", "cellEcho"]);

/** The home note and chord of the item's key, for the guide keyboard. Undefined for other items. */
export function keyboardGuide(item: ItemInstance): KeyboardGuide | undefined {
  const key = keyOf(item.presentation);
  const tonicMidi = item.presentation.tonicMidi;
  if (!GUIDE_GENERATORS.has(item.generator) || !key || typeof tonicMidi !== "number") {
    return undefined;
  }
  const opts = { minorVariant: "natural" as const };
  return {
    low: DEFAULT_KEYBOARD_RANGE.low,
    high: DEFAULT_KEYBOARD_RANGE.high,
    focus: tonicMidi,
    tonicPc: tonicMidi % 12,
    chordPcs: [1, 3, 5].map((d) => degreeToMidi(key, d, tonicMidi, opts) % 12),
  };
}

/** Pitch classes the item asks for, for marking the target after an answer. */
export function targetPitchClasses(item: ItemInstance): number[] {
  const play = item.expected.play;
  if (play?.kind === "pitchClass" || play?.kind === "exactPitch") return [play.targetMidi % 12];
  if (play?.kind === "sequence") return [...new Set(play.midi.map((m) => m % 12))];
  return [];
}
