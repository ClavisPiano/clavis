import {
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
