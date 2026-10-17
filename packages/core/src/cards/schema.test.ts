import { describe, expect, it } from "vitest";
import { ScoreSpecSchema, spelledToMidi } from "../score/schema.js";
import { StimulusSpecSchema } from "../stimulus/types.js";
import { ALL_KEYS } from "../theory/keys.js";
import { COUNT_IN_PITCH, RHYTHM_PITCH } from "../items/rhythm.js";
import {
  CARD_EXAMPLE_TEMPO_BPM,
  cardExampleScore,
  cardExampleStimulus,
  cardWordCount,
  ConceptCardSchema,
  parallelKey,
  type CardExample,
} from "./schema.js";

const card = {
  id: "concept.test",
  nodeIds: ["ear.x"],
  title: "Test",
  body: ["One paragraph."],
  howTo: ["Listen.", "Sing it back."],
  examples: [{ kind: "scale", label: "The scale" }],
  links: [{ label: "More", url: "https://example.org/x" }],
};

describe("ConceptCardSchema", () => {
  it("accepts a valid card", () => {
    expect(ConceptCardSchema.parse(card)).toEqual(card);
  });

  it.each([
    ["a bad id", { id: "test" }],
    ["an empty body", { body: [] }],
    ["no steps", { howTo: [] }],
    ["an http link", { links: [{ label: "x", url: "http://example.org" }] }],
    ["an unknown field", { extra: 1 }],
    ["an unknown example kind", { examples: [{ kind: "chord", label: "x" }] }],
  ])("rejects %s", (_name, patch) => {
    expect(ConceptCardSchema.safeParse({ ...card, ...patch }).success).toBe(false);
  });
});

describe("cardExampleStimulus", () => {
  const beat = 60 / CARD_EXAMPLE_TEMPO_BPM;
  const examples: CardExample[] = [
    { kind: "cadence", label: "c" },
    { kind: "scale", label: "s" },
    { kind: "degrees", label: "d", degrees: [1, 3, 5, 8], afterCadence: true },
    { kind: "rhythm", label: "r", onsetsBeats: [0, 1, 1.5, 2] },
    { kind: "progression", label: "p", romans: ["I", "IV", "V", "vi"], afterCadence: true },
  ];

  it.each(ALL_KEYS.map((k) => [`${k.tonic} ${k.mode}`, k] as const))(
    "gives valid stimuli in %s",
    (_n, key) => {
      for (const ex of [...examples, { kind: "scale", label: "m", mode: "minor" } as const]) {
        const spec = cardExampleStimulus(ex, key);
        expect(StimulusSpecSchema.safeParse(spec).success).toBe(true);
        expect(spec.events.length).toBeGreaterThan(0);
      }
    },
  );

  it("plays degrees relative to the tonic, after the cadence when asked", () => {
    const key = { tonic: "D", mode: "major" } as const;
    const spec = cardExampleStimulus(
      { kind: "degrees", label: "d", degrees: [1, 3, 5, 8], afterCadence: true },
      key,
    );
    const singles = spec.events.filter((e) => e.role === undefined).map((e) => e.midi[0]);
    expect(singles).toEqual([62, 66, 69, 74]);
    expect(spec.events.filter((e) => e.role === "cadence")).toHaveLength(4);
  });

  it("plays a progression one chord per beat after the cadence, always in a major key", () => {
    const example: CardExample = {
      kind: "progression",
      label: "p",
      romans: ["I", "IV", "V", "vi"],
      afterCadence: true,
    };
    for (const key of [
      { tonic: "D", mode: "major" } as const,
      { tonic: "D", mode: "minor" } as const,
    ]) {
      const spec = cardExampleStimulus(example, key);
      expect(spec.events.filter((e) => e.role === "cadence")).toHaveLength(4);
      const chords = spec.events.filter((e) => e.role === undefined);
      expect(chords.map((e) => e.midi[0])).toEqual([38, 43, 45, 47]);
      expect(chords.every((e) => e.midi.length === 4)).toBe(true);
      chords.forEach((e, i) => {
        if (i > 0) expect(e.atSec - (chords[i - 1]?.atSec ?? 0)).toBeCloseTo(beat, 6);
      });
    }
  });

  it("plays a progression from time zero without the cadence", () => {
    const spec = cardExampleStimulus(
      { kind: "progression", label: "p", romans: ["I", "V"], afterCadence: false },
      { tonic: "C", mode: "major" },
    );
    expect(spec.events.map((e) => e.atSec)).toEqual([0, beat]);
  });

  it("plays a minor progression in the parallel minor key and checks numerals per mode", () => {
    const example: CardExample = {
      kind: "progression",
      label: "p",
      mode: "minor",
      romans: ["i", "VII", "VI", "V"],
      afterCadence: true,
    };
    const spec = cardExampleStimulus(example, { tonic: "D", mode: "major" });
    expect(spec.events.filter((e) => e.role === "cadence")).toHaveLength(4);
    const chords = spec.events.filter((e) => e.role === undefined);
    // Roots of Dm, C, Bb, A (D minor: i VII VI V).
    expect(chords.map((e) => (e.midi[0] ?? 0) % 12)).toEqual([2, 0, 10, 9]);
    const ok = ConceptCardSchema.safeParse({ ...card, examples: [example] });
    expect(ok.success).toBe(true);
    // "I" and "IV" are major-key numerals, "i" and "iv" minor-key ones.
    const wrong = [
      { ...example, romans: ["I", "IV"] },
      { ...example, mode: undefined, romans: ["i", "iv"] },
    ];
    for (const ex of wrong) {
      expect(ConceptCardSchema.safeParse({ ...card, examples: [ex] }).success).toBe(false);
    }
  });

  it("rejects progression examples with unknown numerals or too few chords", () => {
    const base = { kind: "progression", label: "p", afterCadence: false };
    const bad = [
      { ...base, romans: ["I", "bII"] },
      { ...base, romans: ["I"] },
    ];
    for (const ex of bad) {
      expect(ConceptCardSchema.safeParse({ ...card, examples: [ex] }).success).toBe(false);
    }
  });

  it("starts degrees immediately without the cadence", () => {
    const spec = cardExampleStimulus(
      { kind: "degrees", label: "d", degrees: [5], afterCadence: false },
      { tonic: "C", mode: "major" },
    );
    expect(spec.events).toEqual([{ atSec: 0, midi: [67], durationSec: beat * 0.9, velocity: 0.8 }]);
  });

  it("puts rhythm onsets after a bar of count-in", () => {
    const spec = cardExampleStimulus(
      { kind: "rhythm", label: "r", onsetsBeats: [0, 1.5] },
      { tonic: "C", mode: "major" },
    );
    expect(spec.events.filter((e) => e.role === "count-in").map((e) => e.midi[0])).toEqual([
      COUNT_IN_PITCH,
      COUNT_IN_PITCH,
      COUNT_IN_PITCH,
      COUNT_IN_PITCH,
    ]);
    const notes = spec.events.filter((e) => e.role === undefined);
    expect(notes.map((e) => e.midi[0])).toEqual([RHYTHM_PITCH, RHYTHM_PITCH]);
    expect(notes.map((e) => e.atSec)).toEqual([4 * beat, 5.5 * beat]);
  });
});

describe("parallelKey", () => {
  it("keeps the key when the mode matches", () => {
    expect(parallelKey({ tonic: "Eb", mode: "major" }, "major")).toEqual({
      tonic: "Eb",
      mode: "major",
    });
  });

  it.each([
    ["C", "C"],
    ["Db", "C#"],
    ["Gb", "F#"],
    ["Ab", "G#"],
  ])("gives the parallel minor of %s major on %s", (major, minor) => {
    expect(parallelKey({ tonic: major, mode: "major" }, "minor")).toEqual({
      tonic: minor,
      mode: "minor",
    });
  });

  it("plays minor examples in the parallel minor, harmonic when asked", () => {
    const spec = cardExampleStimulus(
      {
        kind: "degrees",
        label: "m",
        mode: "minor",
        minorVariant: "harmonic",
        degrees: [3, 7],
        afterCadence: false,
      },
      { tonic: "C", mode: "major" },
    );
    expect(spec.events.map((e) => e.midi[0])).toEqual([63, 71]);
  });
});

describe("cardWordCount", () => {
  it("counts body and how-to words separately", () => {
    expect(cardWordCount({ body: ["one two", " three "], howTo: ["four"] })).toEqual({
      body: 3,
      howTo: 1,
    });
  });
});

describe("staff examples", () => {
  const staff = {
    kind: "staff",
    label: "Low C, F and middle C",
    clef: "bass",
    positions: ["C2", "F3", "C4"],
  } as const satisfies CardExample;
  const gMajor = { tonic: "G", mode: "major" } as const;

  it("builds a valid one-staff score in C major by default", () => {
    const score = cardExampleScore(staff, gMajor);
    expect(ScoreSpecSchema.safeParse(score).success).toBe(true);
    expect(score?.key).toEqual({ tonic: "C", mode: "major" });
    expect(score?.staves[0]?.clef).toBe("bass");
    expect(score?.staves[0]?.measures.flat().map((n) => (n.kind === "note" ? n.id : ""))).toEqual([
      "n1",
      "n2",
      "n3",
    ]);
  });

  it.each([
    ["C", "major", "F3", 53],
    ["G", "major", "F3", 54],
    ["F", "major", "B3", 58],
    ["D", "major", "C4", 61],
    ["A", "minor", "F3", 53],
    ["E", "minor", "F3", 54],
  ] as const)("applies the %s %s signature to %s", (tonic, mode, pos, midi) => {
    const score = cardExampleScore(
      { kind: "staff", label: "x", clef: "bass", positions: [pos], useKeyOfDay: true },
      { tonic, mode },
    );
    const n = score?.staves[0]?.measures[0]?.[0];
    expect(
      n?.kind === "note"
        ? spelledToMidi(n.pitches[0] ?? { step: "C", alter: 0, octave: 0 })
        : undefined,
    ).toBe(midi);
    expect(score?.key).toEqual({ tonic, mode });
  });

  it("has no score for other kinds", () => {
    expect(cardExampleScore({ kind: "scale", label: "s" }, gMajor)).toBeUndefined();
  });

  it("plays the notes in sequence, in the key of the day only when asked", () => {
    const spec = cardExampleStimulus(staff, gMajor);
    expect(StimulusSpecSchema.safeParse(spec).success).toBe(true);
    expect(spec.events.map((e) => e.midi[0])).toEqual([36, 53, 60]);
    expect(spec.events.map((e) => e.atSec)).toEqual([0, 60 / 90, 120 / 90]);
    const keyed = cardExampleStimulus({ ...staff, useKeyOfDay: true }, gMajor);
    expect(keyed.events.map((e) => e.midi[0])).toEqual([36, 54, 60]);
  });

  it.each([
    ["a bad position", { positions: ["H3"] }],
    ["no positions", { positions: [] }],
    ["nine positions", { positions: Array.from({ length: 9 }, () => "C4") }],
    ["a percussion clef", { clef: "percussion" }],
  ])("rejects %s", (_n, patch) => {
    expect(
      ConceptCardSchema.safeParse({
        id: "concept.t",
        nodeIds: [],
        title: "t",
        body: ["b"],
        howTo: ["h"],
        examples: [{ ...staff, ...patch }],
        links: [],
      }).success,
    ).toBe(false);
  });
});
