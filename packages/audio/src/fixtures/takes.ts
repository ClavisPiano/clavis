import type { FixtureEntry, FixtureInstrument, FixtureKind, TruthNote } from "./manifest.js";

/**
 * The recording session script: every take the fixture guide asks for, with its score. Ground
 * truth is derived from the tempo, so a take played to the count-in click needs no annotation.
 * Shared by `docs/fixtures-recording.md` and the `/dev/record` page. Pure data and functions.
 */

export const COUNT_IN_BEATS = 4;

export interface TakeNote {
  midi: number;
  /** Beats after the end of the count-in. */
  beat: number;
  durBeats: number;
}

export interface Take {
  /** Becomes part of the manifest id and file name, e.g. `sung-c-low`. */
  slug: string;
  kind: FixtureKind;
  /** Which instruments this take applies to. */
  instruments: readonly FixtureInstrument[];
  label: string;
  /** Instruction shown to the performer. */
  prompt: string;
  bpm: number;
  notes: readonly TakeNote[];
  /** Tonic for the cadence played before a sung take. */
  cadenceTonic?: number;
  expectedRange?: { low: number; high: number };
  tags?: readonly string[];
}

const NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
export const noteName = (midi: number): string =>
  `${NAMES[((midi % 12) + 12) % 12] ?? "?"}${String(Math.floor(midi / 12) - 1)}`;

const seq = (midis: readonly number[], step: number, dur: number): TakeNote[] =>
  midis.map((midi, i) => ({ midi, beat: i * step, durBeats: dur }));

/** Major scale degrees in a deliberately non-stepwise order (1 5 3 7 2 6 4). */
const DEGREE_ORDER = [0, 7, 4, 11, 2, 9, 5];

function sungTake(slug: string, tonic: number, label: string): Take {
  return {
    slug,
    kind: "sung-degree",
    instruments: ["voice"],
    label,
    prompt: `Play the cadence (I IV V I), then sing one note per click on "ah": ${DEGREE_ORDER.map((d) => noteName(tonic + d)).join(", ")}. Hold each for about 3 clicks of the 4, then breathe.`,
    bpm: 60,
    notes: seq(
      DEGREE_ORDER.map((d) => tonic + d),
      4,
      3,
    ),
    cadenceTonic: tonic,
    expectedRange: { low: tonic - 2, high: tonic + 13 },
  };
}

function singlesTake(slug: string, dynamic: string): Take {
  const midis = Array.from({ length: 30 }, (_, i) => 21 + 3 * i); // A0, C1, D#1 ... C8
  return {
    slug,
    kind: "piano-single",
    instruments: ["acoustic-piano", "digital-piano"],
    label: `Single notes A0 to C8, ${dynamic}`,
    prompt: `Play each note ${dynamic} on the click and let it ring for about 1.5 beats. Every minor third from A0 (${noteName(21)}) to C8 (${noteName(108)}), 30 notes.`,
    bpm: 40,
    notes: seq(midis, 2, 1.5),
    tags: [dynamic],
  };
}

const melody = (
  slug: string,
  label: string,
  bpm: number,
  tune: readonly [number, number][],
  low: number,
  high: number,
): Take => {
  let beat = 0;
  const notes = tune.map(([midi, dur]) => {
    const n = { midi, beat, durBeats: dur * 0.9 };
    beat += dur;
    return n;
  });
  return {
    slug,
    kind: "piano-sequence",
    instruments: ["acoustic-piano", "digital-piano"],
    label,
    prompt: `Play: ${tune.map(([m]) => noteName(m)).join(" ")}. Start on the first click after the count-in; hold each note for its length.`,
    bpm,
    notes,
    expectedRange: { low, high },
  };
};

/** I IV V I block chords (left hand) under a two-note-per-bar right hand melody. */
function twoHandTake(slug: string, shift: number): Take {
  const lh = [
    [48, 52, 55],
    [53, 57, 60],
    [55, 59, 62],
    [48, 52, 55],
  ];
  const rh = [
    [64, 67],
    [65, 69],
    [62, 71],
    [60, 72],
  ];
  const notes: TakeNote[] = [];
  lh.forEach((chord, bar) => {
    for (const m of chord) notes.push({ midi: m + shift, beat: bar * 4, durBeats: 3.5 });
    (rh[bar] ?? []).forEach((m, i) =>
      notes.push({ midi: m + shift, beat: bar * 4 + i * 2, durBeats: 1.8 }),
    );
  });
  const names = (ms: number[]): string => ms.map((m) => noteName(m + shift)).join("-");
  return {
    slug,
    kind: "two-hand",
    instruments: ["acoustic-piano", "digital-piano"],
    label: `Two-hand block chords I IV V I (${noteName(48 + shift)} major)`,
    prompt: `One bar each, 4 clicks per bar. Left hand chord on beat 1, right hand notes on beats 1 and 3. Bars: ${lh.map((c, i) => `${names(c)} with ${names(rh[i] ?? [])}`).join("; ")}.`,
    bpm: 60,
    notes,
  };
}

export const TAKES: readonly Take[] = [
  sungTake("sung-c-low", 48, "Sung degrees, C major, low register"),
  sungTake("sung-c-high", 60, "Sung degrees, C major, high register"),
  sungTake("sung-g-low", 55, "Sung degrees, G major, low register"),
  sungTake("sung-g-high", 67, "Sung degrees, G major, high register"),
  singlesTake("singles-soft", "soft"),
  singlesTake("singles-loud", "loud"),
  melody(
    "melody-ode",
    "Melody 1: Ode to Joy",
    80,
    [
      [64, 1],
      [64, 1],
      [65, 1],
      [67, 1],
      [67, 1],
      [65, 1],
      [64, 1],
      [62, 1],
      [60, 1],
      [60, 1],
      [62, 1],
      [64, 1],
      [64, 1.5],
      [62, 0.5],
      [62, 2],
    ],
    58,
    70,
  ),
  melody(
    "melody-twinkle",
    "Melody 2: Twinkle",
    80,
    [
      [60, 1],
      [60, 1],
      [67, 1],
      [67, 1],
      [69, 1],
      [69, 1],
      [67, 2],
      [65, 1],
      [65, 1],
      [64, 1],
      [64, 1],
      [62, 1],
      [62, 1],
      [60, 2],
    ],
    55,
    72,
  ),
  melody(
    "melody-arpeggio",
    "Melody 3: rising arpeggio over four octaves",
    60,
    [48, 52, 55, 60, 64, 67, 72, 76, 79, 84].map((m) => [m, 1] as [number, number]),
    46,
    86,
  ),
  twoHandTake("two-hand-c", 0),
  twoHandTake("two-hand-g", 7),
];

export interface TakeContext {
  instrument: FixtureInstrument;
  device: string;
  sampleRate?: number;
  /** Optional id suffix to tell repeat takes apart, for example a second device ("laptop"). */
  variant?: string;
}

const PREFIX: Record<FixtureInstrument, string> = {
  voice: "voice",
  "acoustic-piano": "ac",
  "digital-piano": "dig",
};

export const takeId = (take: Take, instrument: FixtureInstrument, variant?: string): string =>
  [
    PREFIX[instrument],
    take.slug,
    ...(variant === undefined || variant === "" ? [] : [variant]),
  ].join("-");

export const takesFor = (instrument: FixtureInstrument): Take[] =>
  TAKES.filter((t) => t.instruments.includes(instrument));

/** Ground truth in ms from the first sample, where recording starts on the first count-in click. */
export function takeTruth(take: Take): TruthNote[] {
  const ms = (beats: number): number => Math.round(((COUNT_IN_BEATS + beats) * 60000) / take.bpm);
  return take.notes.map((n) => ({
    midi: n.midi,
    onsetMs: ms(n.beat),
    offsetMs: ms(n.beat + n.durBeats),
  }));
}

/** The manifest entry for a take; `file` is `<kind folder>/<id>.wav`. */
export function takeToEntry(take: Take, ctx: TakeContext): FixtureEntry {
  const id = takeId(take, ctx.instrument, ctx.variant);
  return {
    id,
    file: `${take.kind}/${id}.wav`,
    kind: take.kind,
    instrument: ctx.instrument,
    device: ctx.device,
    ...(ctx.sampleRate === undefined ? {} : { sampleRate: ctx.sampleRate }),
    notes: takeTruth(take),
    ...(take.expectedRange === undefined ? {} : { expectedRange: take.expectedRange }),
    ...(take.tags === undefined ? {} : { tags: [...take.tags] }),
  };
}
