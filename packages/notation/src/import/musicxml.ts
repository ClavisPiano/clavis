import type {
  Duration,
  ScoreNote,
  ScoreRest,
  ScoreSpec,
  SpelledPitch,
  Step,
  WrittenAccidental,
} from "@clavis/core";
import { ImportError } from "./errors.js";
import { child, childText, childrenNamed, parseXml, type XmlNode } from "./xml.js";

/*
 * Partwise MusicXML to ScoreSpec (T7.3). Pure: string in, plain data out, no DOM.
 *
 * One part and one staff are imported. Everything the ScoreSpec cannot hold raises an ImportError
 * instead of being dropped: other clefs, a second voice, tuplets, grace notes, additive meters,
 * mid-piece key, meter or clef changes, modes other than major and minor, durations outside whole
 * to 16th with at most one dot. Pickup bars and short final bars are kept as written.
 *
 * Chords become one ScoreNote with several pitches. The tie and the written accidental of a chord
 * come from its first note that carries one. Note ids are `n1`, `n2`, ... in document order, one
 * per ScoreNote (a chord is one note).
 */

export interface ImportOptions {
  /** Which `<part>` to read, counted from 0. Default 0. */
  partIndex?: number;
  /** Which staff of the part to read, counted from 1. Default 1. */
  staff?: number;
}

type ScoreElement = ScoreNote | ScoreRest;
type NoteValue = Duration["value"];

const TYPE_VALUES: Record<string, NoteValue> = {
  whole: 1,
  half: 2,
  quarter: 4,
  eighth: 8,
  "16th": 16,
};

const VALUES: readonly NoteValue[] = [1, 2, 4, 8, 16];

const ACCIDENTALS: Record<string, WrittenAccidental> = {
  sharp: "sharp",
  flat: "flat",
  natural: "natural",
  "double-sharp": "double-sharp",
  "sharp-sharp": "double-sharp",
  "flat-flat": "double-flat",
};

const STEPS = new Set<string>(["C", "D", "E", "F", "G", "A", "B"]);

/** Key tonics by number of sharps (positive) or flats (negative), spelled as ScoreSpec keys are. */
const MAJOR_TONICS = [
  "Cb",
  "Gb",
  "Db",
  "Ab",
  "Eb",
  "Bb",
  "F",
  "C",
  "G",
  "D",
  "A",
  "E",
  "B",
  "F#",
  "C#",
];
const MINOR_TONICS = [
  "Ab",
  "Eb",
  "Bb",
  "F",
  "C",
  "G",
  "D",
  "A",
  "E",
  "B",
  "F#",
  "C#",
  "G#",
  "D#",
  "A#",
];

const fail = (code: ConstructorParameters<typeof ImportError>[0], message: string): never => {
  throw new ImportError(code, message);
};

function parseInteger(text: string | undefined, what: string): number {
  if (text === undefined || !/^-?\d+$/.test(text))
    return fail("malformed", `${what} is not an integer`);
  return Number(text);
}

function keyOf(node: XmlNode): NonNullable<ScoreSpec["key"]> {
  const fifthsText = childText(node, "fifths");
  if (fifthsText === undefined) return fail("unsupported-key", "key without <fifths>");
  const fifths = parseInteger(fifthsText, "<fifths>");
  if (fifths < -7 || fifths > 7)
    return fail("unsupported-key", `key with ${String(fifths)} fifths`);
  const mode = childText(node, "mode") ?? "major";
  if (mode !== "major" && mode !== "minor") return fail("unsupported-key", `mode "${mode}"`);
  const tonic = (mode === "major" ? MAJOR_TONICS : MINOR_TONICS)[fifths + 7];
  if (tonic === undefined) return fail("unsupported-key", "key out of range");
  return { tonic, mode };
}

function meterOf(node: XmlNode): NonNullable<ScoreSpec["meter"]> {
  if (child(node, "senza-misura") !== undefined) return fail("unsupported-meter", "senza misura");
  if (childrenNamed(node, "beats").length !== 1 || childrenNamed(node, "beat-type").length !== 1) {
    return fail("unsupported-meter", "composite or missing meter");
  }
  const beatsText = childText(node, "beats") ?? "";
  const unitText = childText(node, "beat-type") ?? "";
  if (!/^\d+$/.test(beatsText) || Number(beatsText) < 1) {
    return fail("unsupported-meter", `beats "${beatsText}"`);
  }
  const beatValue = Number(unitText);
  if (beatValue !== 1 && beatValue !== 2 && beatValue !== 4 && beatValue !== 8) {
    return fail("unsupported-meter", `beat type "${unitText}"`);
  }
  return { beats: Number(beatsText), beatValue };
}

function clefOf(node: XmlNode): "treble" | "bass" {
  const sign = childText(node, "sign");
  const line = childText(node, "line");
  const octave = childText(node, "clef-octave-change");
  if (octave !== undefined && octave !== "0") {
    return fail("unsupported-clef", "transposing clefs are not supported");
  }
  if (sign === "G" && (line === undefined || line === "2")) return "treble";
  if (sign === "F" && (line === undefined || line === "4")) return "bass";
  return fail("unsupported-clef", `clef ${sign ?? "?"}${line ?? ""}`);
}

/** Length in quarter-note units times `divisions`, as a note of this value and dots would have. */
function expectedDivisions(divisions: number, d: Duration): number {
  const base = (divisions * 4) / d.value;
  return d.dots === 1 ? base * 1.5 : base;
}

/** The ScoreSpec duration with exactly `amount` divisions, if one exists. */
function durationFromDivisions(divisions: number, amount: number): Duration | undefined {
  for (const value of VALUES) {
    for (const dots of [0, 1] as const) {
      if (expectedDivisions(divisions, { value, dots }) === amount) return { value, dots };
    }
  }
  return undefined;
}

function durationOf(
  note: XmlNode,
  divisions: number | undefined,
  meter: ScoreSpec["meter"] | undefined,
): Duration {
  const dotCount = childrenNamed(note, "dot").length;
  if (dotCount > 1) return fail("unsupported-duration", "double-dotted notes are not supported");
  const typeText = childText(note, "type");
  const amountText = childText(note, "duration");
  const amount = amountText === undefined ? undefined : Number(amountText);
  if (amount !== undefined && (!Number.isFinite(amount) || amount <= 0)) {
    return fail("malformed", `bad <duration> "${amountText ?? ""}"`);
  }

  if (typeText !== undefined) {
    const value = TYPE_VALUES[typeText];
    if (value === undefined) return fail("unsupported-duration", `note type "${typeText}"`);
    const duration: Duration = { value, dots: dotCount === 1 ? 1 : 0 };
    if (amount !== undefined) {
      if (divisions === undefined) return fail("malformed", "<duration> before <divisions>");
      if (expectedDivisions(divisions, duration) !== amount) {
        return fail(
          "malformed",
          `<duration> ${String(amount)} does not match a ${typeText} with ${String(dotCount)} dot(s) at ${String(divisions)} divisions`,
        );
      }
    }
    return duration;
  }

  // No <type>: a whole-measure rest or a file that leaves it out. Derive it from <duration>.
  if (divisions === undefined) return fail("malformed", "note without <type> before <divisions>");
  const total =
    amount ??
    (meter === undefined || meter === null
      ? undefined
      : (divisions * 4 * meter.beats) / meter.beatValue);
  if (total === undefined) return fail("malformed", "note without <type> or <duration>");
  return (
    durationFromDivisions(divisions, total) ??
    fail("unsupported-duration", `a length of ${String(total)} divisions has no single note value`)
  );
}

function pitchOf(note: XmlNode): SpelledPitch {
  const pitch = child(note, "pitch");
  if (pitch === undefined) return fail("malformed", "note without <pitch>");
  const step = childText(pitch, "step") ?? "";
  if (!STEPS.has(step)) return fail("malformed", `bad <step> "${step}"`);
  const alterText = childText(pitch, "alter") ?? "0";
  const alter = Number(alterText);
  if (!Number.isInteger(alter) || alter < -2 || alter > 2) {
    return fail("unsupported-accidental", `alteration ${alterText}`);
  }
  const octave = parseInteger(childText(pitch, "octave"), "<octave>");
  if (octave < 0 || octave > 9) return fail("malformed", `octave ${String(octave)} out of range`);
  return { step: step as Step, alter, octave };
}

function tieOf(note: XmlNode): Duration["tie"] {
  let types = childrenNamed(note, "tie").map((t) => t.attrs.type);
  if (types.length === 0) {
    const notations = childrenNamed(note, "notations");
    types = notations.flatMap((n) => childrenNamed(n, "tied")).map((t) => t.attrs.type);
  }
  const start = types.includes("start");
  const stop = types.includes("stop");
  if (start && stop) return "continue";
  if (start) return "start";
  if (stop) return "stop";
  return undefined;
}

function accidentalOf(note: XmlNode): WrittenAccidental | undefined {
  const text = childText(note, "accidental");
  if (text === undefined) return undefined;
  const acc = ACCIDENTALS[text];
  return acc ?? fail("unsupported-accidental", `accidental "${text}"`);
}

function hasTuplet(note: XmlNode): boolean {
  if (child(note, "time-modification") !== undefined) return true;
  return childrenNamed(note, "notations").some((n) => child(n, "tuplet") !== undefined);
}

export function importMusicXml(xml: string, options: ImportOptions = {}): ScoreSpec {
  const partIndex = options.partIndex ?? 0;
  const staffNumber = options.staff ?? 1;
  if (!Number.isInteger(partIndex) || partIndex < 0) return fail("no-parts", "bad part index");
  if (!Number.isInteger(staffNumber) || staffNumber < 1)
    return fail("no-staff", "bad staff number");

  const root = parseXml(xml);
  if (root.name === "score-timewise") {
    return fail("unsupported-format", "timewise MusicXML is not supported");
  }
  if (root.name !== "score-partwise") {
    return fail("unsupported-format", `root element <${root.name}> is not MusicXML`);
  }
  const parts = childrenNamed(root, "part");
  if (parts.length === 0) return fail("no-parts", "the score has no parts");
  const part = parts[partIndex];
  if (part === undefined) {
    return fail(
      "no-parts",
      `part ${String(partIndex)} does not exist (${String(parts.length)} parts)`,
    );
  }

  let divisions: number | undefined;
  let clef: "treble" | "bass" | undefined;
  let key: ScoreSpec["key"] | undefined;
  let meter: ScoreSpec["meter"] | undefined;
  let staves = 1;
  const voices = new Set<string>();
  const measures: ScoreElement[][] = [];
  let nextId = 1;

  for (const measureNode of childrenNamed(part, "measure")) {
    const measure: ScoreElement[] = [];
    measures.push(measure);
    let lastNote: ScoreNote | undefined;
    for (const el of measureNode.children) {
      if (el.name === "attributes") {
        const div = childText(el, "divisions");
        if (div !== undefined) {
          divisions = parseInteger(div, "<divisions>");
          if (divisions < 1) fail("malformed", "<divisions> must be positive");
        }
        const stavesText = childText(el, "staves");
        if (stavesText !== undefined) staves = parseInteger(stavesText, "<staves>");
        const keyNode = child(el, "key");
        if (keyNode !== undefined) {
          const next = keyOf(keyNode);
          if (key !== undefined && (key?.tonic !== next.tonic || key.mode !== next.mode)) {
            fail("unsupported-key", "the key changes within the piece");
          }
          key = next;
        }
        const timeNode = child(el, "time");
        if (timeNode !== undefined) {
          const next = meterOf(timeNode);
          if (
            meter !== undefined &&
            (meter?.beats !== next.beats || meter.beatValue !== next.beatValue)
          ) {
            fail("unsupported-meter", "the meter changes within the piece");
          }
          meter = next;
        }
        for (const clefNode of childrenNamed(el, "clef")) {
          if (Number(clefNode.attrs.number ?? "1") !== staffNumber) continue;
          const next = clefOf(clefNode);
          if (clef !== undefined && clef !== next) {
            fail("unsupported-clef", "the clef changes within the piece");
          }
          clef = next;
        }
        if (staffNumber > staves) fail("no-staff", `staff ${String(staffNumber)} does not exist`);
        continue;
      }
      if (el.name !== "note") continue;

      const staffText = childText(el, "staff") ?? "1";
      if (Number(staffText) !== staffNumber) continue;
      if (child(el, "grace") !== undefined)
        fail("unsupported-note", "grace notes are not supported");
      if (child(el, "unpitched") !== undefined)
        fail("unsupported-note", "unpitched notes are not supported");
      if (hasTuplet(el)) fail("tuplets", "tuplets are not supported");
      voices.add(childText(el, "voice") ?? "1");
      if (voices.size > 1) fail("multiple-voices", "the staff has more than one voice");

      const isChordMember = child(el, "chord") !== undefined;
      const duration = durationOf(el, divisions, meter);

      if (child(el, "rest") !== undefined) {
        if (isChordMember) fail("malformed", "a rest cannot be part of a chord");
        measure.push({ kind: "rest", duration });
        lastNote = undefined;
        continue;
      }

      const pitch = pitchOf(el);
      const accidental = accidentalOf(el);
      const tie = tieOf(el);

      if (isChordMember) {
        if (lastNote === undefined) return fail("malformed", "<chord/> without a preceding note");
        if (
          lastNote.duration.value !== duration.value ||
          lastNote.duration.dots !== duration.dots
        ) {
          fail("malformed", "chord notes differ in duration");
        }
        lastNote.pitches.push(pitch);
        if (lastNote.accidental === undefined && accidental !== undefined) {
          lastNote.accidental = accidental;
        }
        if (lastNote.duration.tie === undefined && tie !== undefined) lastNote.duration.tie = tie;
        continue;
      }

      const note: ScoreNote = {
        kind: "note",
        id: `n${String(nextId++)}`,
        pitches: [pitch],
        duration: tie === undefined ? duration : { ...duration, tie },
        ...(accidental === undefined ? {} : { accidental }),
      };
      measure.push(note);
      lastNote = note;
    }
  }

  if (clef === undefined) {
    return fail("unsupported-clef", `no clef found for staff ${String(staffNumber)}`);
  }
  if (staffNumber > staves) return fail("no-staff", `staff ${String(staffNumber)} does not exist`);
  return {
    staves: [{ clef, lines: 5, measures }],
    key: key ?? null,
    meter: meter ?? null,
  };
}
