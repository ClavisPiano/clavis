import { describe, expect, it } from "vitest";
import { StimulusSpecSchema } from "../stimulus/types.js";
import { ALL_KEYS } from "../theory/keys.js";
import { COUNT_IN_PITCH, RHYTHM_PITCH } from "../items/rhythm.js";
import {
  CARD_EXAMPLE_TEMPO_BPM,
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
