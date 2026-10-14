import { loadPieces } from "@clavis/content";
import {
  ExpectedResponseSchema,
  PIECE_EAR_NODE_ID,
  createPieceEar,
  createRng,
  type NoteEvent,
  type PitchFrame,
  type SkillNode,
} from "@clavis/core";
import { combineParts, scoreAttempt } from "@clavis/scoring";
import { describe, expect, it } from "vitest";

// Integration test: the real library, the real by-ear generator and the real scorer, combined the
// way the session machine combines the sung and played parts (R12).
const pieces = loadPieces();
const generator = createPieceEar(pieces);
const node: SkillNode = {
  id: PIECE_EAR_NODE_ID,
  strand: "APPLY",
  title: "Pieces by ear",
  prerequisites: [],
  itemGenerators: ["pieceEar"],
  params: {},
  mastery: { minAccuracy: 0.8, windowAttempts: 5, distinctSessions: 2 },
  keyDependent: false,
};
const ctx = { rng: createRng(1), voiceRange: { low: 48, high: 72 }, mode: "instrument" as const };
const END = 1000;
const SING_END = 2000;

const item = generator.generate(node, { piece: "piece.hot-cross-buns", phrase: 1 }, ctx);
const expectedSing = item.expected.sing;
const expectedPlay = item.expected.play;
if (expectedSing?.kind !== "sungSequence" || expectedPlay?.kind !== "line") {
  throw new Error("not sing then play");
}
const sing = expectedSing;
const play = expectedPlay;
const beatMs = 60000 / play.tempoBpm;

const hz = (midi: number): number => 440 * 2 ** ((midi - 69) / 12);

/** The phrase sung one note per beat, `shift` semitones off. A wrong note is `wrongAt`'s index. */
function sung(shift = 0, wrongAt?: number): PitchFrame[] {
  const out: PitchFrame[] = [];
  sing.midi.forEach((m, i) => {
    const pitch = m + shift + (i === wrongAt ? 3 : 0);
    const from = SING_END + 300 + i * beatMs;
    for (let t = from; t < from + beatMs * 0.8; t += 10) {
      out.push({ hz: hz(pitch), confidence: 0.95, atMs: t });
    }
  });
  return out;
}

/** The phrase played with its rhythm, starting 500 ms after the sung part ended. */
function played(wrongAt?: number): NoteEvent[] {
  return play.midi.map((pitch, i) => ({
    pitch: i === wrongAt ? pitch + 1 : pitch,
    onsetMs: SING_END + 500 + (play.onsetsBeats[i] ?? 0) * beatMs,
    confidence: 1,
    source: "midi" as const,
  }));
}

function attempt(frames: PitchFrame[], notes: NoteEvent[]) {
  const s = scoreAttempt({
    expected: item.expected,
    notes: [],
    frames,
    stimulusEndMs: END,
    source: "mic",
    part: "sing",
  });
  const p = scoreAttempt({
    expected: item.expected,
    notes,
    stimulusEndMs: SING_END,
    source: "midi",
    part: "play",
  });
  return { s, p, both: combineParts({ sing: s, play: p }) };
}

describe("play it by ear: sing, then play (TP.6)", () => {
  it("expects a valid sung sequence and line", () => {
    expect(ExpectedResponseSchema.safeParse(item.expected).success).toBe(true);
    expect(sing.midi).toEqual(play.midi);
  });

  it.each([
    ["both parts right", undefined, undefined, true, 1],
    ["sung an octave down, played right", -12, undefined, true, 1],
    ["a wrong sung note, played right", 0, "sing", false, undefined],
    ["sung right, a wrong played note", undefined, "play", false, undefined],
  ] as const)("%s", (_name, shift, wrong, correct, partial) => {
    const { both } = attempt(
      sung(shift ?? 0, wrong === "sing" ? 1 : undefined),
      played(wrong === "play" ? 1 : undefined),
    );
    expect(both.outcome.correct).toBe(correct);
    if (partial !== undefined) expect(both.outcome.partial ?? 1).toBe(partial);
    else expect(both.outcome.partial ?? 0).toBeLessThan(1);
  });

  it("names the part that was wrong, so feedback can say 'you sang'", () => {
    const { both } = attempt(sung(0, 1), played());
    expect(both.outcome.correct).toBe(false);
    expect(both.errors.length).toBeGreaterThan(0);
    expect(both.errors.every((e) => e.detail?.part === "sing")).toBe(true);
  });

  it("scores nothing sung as wrong even when the played part is perfect", () => {
    const { both } = attempt([], played());
    expect(both.outcome.correct).toBe(false);
  });
});
