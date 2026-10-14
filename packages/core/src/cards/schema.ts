import { z } from "zod";
import { cadenceStimulus } from "../items/build.js";
import { COUNT_IN_PITCH, COUNT_IN_VELOCITY, RHYTHM_PITCH } from "../items/rhythm.js";
import type { StimulusEvent, StimulusSpec } from "../stimulus/types.js";
import { spelledToMidi, type ScoreSpec, type SpelledPitch, type Step } from "../score/schema.js";
import { MAJOR_ROMANS, progression } from "../theory/cadence.js";
import { degreeToMidi } from "../theory/degrees.js";
import { ALL_KEYS, tonicChroma, type Key, type MinorVariant } from "../theory/keys.js";
import { majorSignature, minorSignature } from "../theory/tonal.js";

/**
 * Tonal examples sound in the learner's key of the day. `mode` switches to the parallel key (same
 * tonic) when it differs, so a minor card still plays minor on a major day.
 */
const tonal = {
  label: z.string().min(1),
  mode: z.enum(["major", "minor"]).optional(),
  minorVariant: z.enum(["natural", "harmonic", "melodic"]).optional(),
};

/** A playable example on a concept card. Pitches are scale degrees. */
export const CardExampleSchema = z.discriminatedUnion("kind", [
  /** The I-IV-V-I cadence the session plays before ear items. */
  z.strictObject({ kind: z.literal("cadence"), ...tonal }),
  /** The scale up an octave, degrees 1 to 8. */
  z.strictObject({ kind: z.literal("scale"), ...tonal }),
  /** Single notes one after another, optionally after the cadence. Degree 8 is the octave. */
  z.strictObject({
    kind: z.literal("degrees"),
    ...tonal,
    degrees: z.array(z.int().min(1).max(15)).min(1).max(8),
    afterCadence: z.boolean(),
  }),
  /**
   * A major-key chord progression from Roman numerals (I, ii, iii, IV, V, vi), one chord per
   * beat, optionally after the cadence. Always major: a minor key of the day plays the parallel
   * major.
   */
  z.strictObject({
    kind: z.literal("progression"),
    label: z.string().min(1),
    romans: z
      .array(z.string().refine((r) => MAJOR_ROMANS.includes(r), "unknown major Roman numeral"))
      .min(2)
      .max(8),
    afterCadence: z.boolean(),
  }),
  /** A rhythm on one pitch, after four count-in clicks. Onsets in beats from the downbeat. */
  z.strictObject({
    kind: z.literal("rhythm"),
    label: z.string().min(1),
    onsetsBeats: z.array(z.number().min(0).max(8)).min(1),
  }),
  /**
   * Notes on the staff, as staff positions (letter and octave, such as "F3"; the key signature
   * decides any sharp or flat). The visual comes from `cardExampleScore`; the button plays them in
   * order. C major unless `useKeyOfDay`.
   */
  z.strictObject({
    kind: z.literal("staff"),
    label: z.string().min(1),
    clef: z.enum(["bass", "treble"]),
    positions: z
      .array(z.string().regex(/^[A-G][0-9]$/))
      .min(1)
      .max(8),
    useKeyOfDay: z.boolean().optional(),
  }),
]);
export type CardExample = z.infer<typeof CardExampleSchema>;

export const CardLinkSchema = z.strictObject({
  label: z.string().min(1),
  url: z.url({ protocol: /^https$/ }),
});

/**
 * Theory for one skill (spec 13). `body` explains the idea; `howTo` says exactly what the learner
 * does in each item and how it is judged.
 */
export const ConceptCardSchema = z.strictObject({
  id: z.string().regex(/^concept\.[a-z0-9.-]+$/),
  /** Nodes this card explains. Empty for cards not tied to a node, such as the warm-up. */
  nodeIds: z.array(z.string().min(1)),
  title: z.string().min(1),
  /** Paragraphs. */
  body: z.array(z.string().min(1)).min(1).max(4),
  /** "What you'll do": one step per entry. */
  howTo: z.array(z.string().min(1)).min(1).max(6),
  examples: z.array(CardExampleSchema).max(4),
  links: z.array(CardLinkSchema).max(3),
});
export type ConceptCard = z.infer<typeof ConceptCardSchema>;

export const CARD_EXAMPLE_TEMPO_BPM = 90;

/** `keyOfDay`, or its parallel key in `mode` (same tonic pitch, respelled if needed). */
export function parallelKey(keyOfDay: Key, mode: Key["mode"]): Key {
  if (keyOfDay.mode === mode) return keyOfDay;
  const chroma = tonicChroma(keyOfDay);
  const found = ALL_KEYS.find((k) => k.mode === mode && tonicChroma(k) === chroma);
  if (!found) throw new RangeError(`no ${mode} key on ${keyOfDay.tonic}`);
  return found;
}

/**
 * The notes of `example` around the key of the day, with degree 1 in the octave from middle C up.
 * Plain data for the stimulus player, like an item's stimulus.
 */
export function cardExampleStimulus(example: CardExample, keyOfDay: Key): StimulusSpec {
  const key =
    example.kind === "rhythm" || example.kind === "staff"
      ? keyOfDay
      : example.kind === "progression"
        ? parallelKey(keyOfDay, "major")
        : parallelKey(keyOfDay, example.mode ?? keyOfDay.mode);
  const tonicMidi = 60 + tonicChroma(key);
  const variant: { minorVariant: MinorVariant } | undefined =
    example.kind !== "rhythm" &&
    example.kind !== "staff" &&
    example.kind !== "progression" &&
    example.minorVariant !== undefined &&
    key.mode === "minor"
      ? { minorVariant: example.minorVariant }
      : undefined;
  const beat = 60 / CARD_EXAMPLE_TEMPO_BPM;
  const note = (atSec: number, midi: number, durationSec = beat): StimulusEvent => ({
    atSec,
    midi: [midi],
    durationSec,
    velocity: 0.8,
  });
  switch (example.kind) {
    case "cadence":
      return {
        events: cadenceStimulus(key, { tempoBpm: CARD_EXAMPLE_TEMPO_BPM }).events,
        tempoBpm: CARD_EXAMPLE_TEMPO_BPM,
      };
    case "scale":
      return {
        events: [1, 2, 3, 4, 5, 6, 7, 8].map((d, i) =>
          note(i * beat * 0.75, degreeToMidi(key, d, tonicMidi, variant), beat * 0.75),
        ),
        tempoBpm: CARD_EXAMPLE_TEMPO_BPM,
      };
    case "degrees": {
      const cad = example.afterCadence
        ? cadenceStimulus(key, { tempoBpm: CARD_EXAMPLE_TEMPO_BPM })
        : undefined;
      const start = cad?.targetStartSec ?? 0;
      return {
        events: [
          ...(cad?.events ?? []),
          ...example.degrees.map((d, i) =>
            note(start + i * beat, degreeToMidi(key, d, tonicMidi, variant), beat * 0.9),
          ),
        ],
        tempoBpm: CARD_EXAMPLE_TEMPO_BPM,
      };
    }
    case "progression": {
      const cad = example.afterCadence
        ? cadenceStimulus(key, { tempoBpm: CARD_EXAMPLE_TEMPO_BPM })
        : undefined;
      const start = cad?.targetStartSec ?? 0;
      return {
        events: [
          ...(cad?.events ?? []),
          ...progression(key, example.romans).map((c, i): StimulusEvent => ({
            atSec: start + i * beat,
            midi: [c.bass, ...c.upper],
            durationSec: beat,
            velocity: 0.8,
          })),
        ],
        tempoBpm: CARD_EXAMPLE_TEMPO_BPM,
      };
    }
    case "staff": {
      const staffKey = staffExampleKey(example, keyOfDay);
      return {
        events: example.positions.map((pos, i) =>
          note(i * beat, spelledToMidi(positionToPitch(pos, staffKey)), beat * 0.9),
        ),
        tempoBpm: CARD_EXAMPLE_TEMPO_BPM,
      };
    }
    case "rhythm": {
      const clicks = [0, 1, 2, 3].map((i): StimulusEvent => ({
        atSec: i * beat,
        midi: [COUNT_IN_PITCH],
        durationSec: 0.1,
        velocity: COUNT_IN_VELOCITY,
        role: "count-in",
      }));
      return {
        events: [
          ...clicks,
          ...example.onsetsBeats.map((b) => note((4 + b) * beat, RHYTHM_PITCH, beat * 0.5)),
        ],
        tempoBpm: CARD_EXAMPLE_TEMPO_BPM,
      };
    }
  }
}

type StaffExample = Extract<CardExample, { kind: "staff" }>;

function staffExampleKey(example: StaffExample, keyOfDay: Key): Key {
  return example.useKeyOfDay === true ? keyOfDay : { tonic: "C", mode: "major" };
}

const SHARP_ORDER: readonly Step[] = ["F", "C", "G", "D", "A", "E", "B"];
const FLAT_ORDER: readonly Step[] = ["B", "E", "A", "D", "G", "C", "F"];

/**
 * Staff position ("F3") to the sounding pitch under `key`'s signature. Deliberately small and
 * private to cards; it may be replaced by the staff helpers from T3.5.
 */
function positionToPitch(position: string, key: Key): SpelledPitch {
  const step = position.charAt(0) as Step;
  const octave = Number(position.slice(1));
  const sig = key.mode === "major" ? majorSignature(key.tonic) : minorSignature(key.tonic);
  let alter = 0;
  if (sig > 0 && SHARP_ORDER.slice(0, sig).includes(step)) alter = 1;
  else if (sig < 0 && FLAT_ORDER.slice(0, -sig).includes(step)) alter = -1;
  return { step, alter, octave };
}

/**
 * The score for a staff example: one staff, one whole note per measure, ids n1.., in C major or
 * the key of the day. Other example kinds have no score. Notes carry the sounding pitch, with the
 * key signature applied and no written accidental (the signature implies it).
 */
export function cardExampleScore(example: CardExample, keyOfDay: Key): ScoreSpec | undefined {
  if (example.kind !== "staff") return undefined;
  const key = staffExampleKey(example, keyOfDay);
  return {
    staves: [
      {
        clef: example.clef,
        lines: 5,
        measures: example.positions.map((pos, i) => [
          {
            kind: "note",
            id: `n${String(i + 1)}`,
            pitches: [positionToPitch(pos, key)],
            duration: { value: 1, dots: 0 },
          },
        ]),
      },
    ],
    key: { tonic: key.tonic, mode: key.mode },
    meter: { beats: 4, beatValue: 4 },
  };
}

/** Words in a card's body and how-to, for the length budget in content tests. */
export function cardWordCount(card: Pick<ConceptCard, "body" | "howTo">): {
  body: number;
  howTo: number;
} {
  const words = (xs: readonly string[]): number =>
    xs.reduce((n, s) => n + s.split(/\s+/).filter(Boolean).length, 0);
  return { body: words(card.body), howTo: words(card.howTo) };
}
