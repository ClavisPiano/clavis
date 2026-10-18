import { readFileSync } from "node:fs";
import { URL, fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  PieceSchema,
  handsChords,
  handsFitErrors,
  isHandsPiece,
  listPieces,
  phraseScore,
  pieceHand,
  spelledToMidi,
  validatePieces,
  type Piece,
  type SkillGraph,
} from "@clavis/core";
import { loadGraph, loadPieces } from "../index";

function must<T>(x: T | undefined): T {
  if (x === undefined) throw new Error("expected a value");
  return x;
}

const pieces = loadPieces();
const graph = loadGraph();

/** Every note of the piece in order, as [name such as "C4", MIDI, duration]. */
function notes(piece: Piece) {
  const out: { name: string; midi: number; value: number; dots: number }[] = [];
  for (const measure of must(piece.score.staves[0]).measures)
    for (const el of measure)
      if (el.kind === "note") {
        const p = must(el.pitches[0]);
        out.push({
          name: `${p.step}${String(p.octave)}`,
          midi: spelledToMidi(p),
          value: el.duration.value,
          dots: el.duration.dots,
        });
      }
  return out;
}

/** Diatonic position of a note name such as "C4" or "A5": octave * 7 plus the step. */
function diatonic(name: string): number {
  return Number(name.slice(1)) * 7 + "CDEFGAB".indexOf(name.slice(0, 1));
}

/**
 * The lowest reading tier (0 landmarks, 1 steps, 2 skips) that covers a note, from the graph's own
 * node params, or null when no node of the clef covers it.
 */
function tierOf(g: SkillGraph, clef: "treble" | "bass", name: string): number | null {
  const node = (tier: string) => must(g.nodes.find((n) => n.id === `read.${clef}.${tier}`));
  const landmarks = node("landmarks").params.notes as string[];
  const steps = node("steps").params;
  const skips = node("skips").params;
  const d = diatonic(name);
  if (landmarks.includes(name)) return 0;
  const anchors = (steps.anchors as string[]).map(diatonic);
  if (anchors.some((a) => Math.abs(a - d) <= (steps.maxOffsetSteps as number))) return 1;
  const range = (skips.fullRange as string[]).map(diatonic);
  const low = must(range[0]);
  const high = must(range[1]);
  if (anchors.some((a) => Math.abs(a - d) <= (skips.maxOffsetSteps as number))) return 2;
  return d >= low && d <= high ? 2 : null;
}

describe("piece library (TP.3)", () => {
  it("has 8 to 10 one-hand pieces and 5 hands-together ones, each valid and with a unique id", () => {
    const oneHand = pieces.filter((p) => !isHandsPiece(p));
    expect(oneHand.length).toBeGreaterThanOrEqual(8);
    expect(oneHand.length).toBeLessThanOrEqual(10);
    expect(pieces.filter(isHandsPiece)).toHaveLength(5);
    expect(new Set(pieces.map((p) => p.id)).size).toBe(pieces.length);
    for (const p of pieces) expect(PieceSchema.safeParse(p).success, p.id).toBe(true);
  });

  it("is consistent with the skill graph: nodes exist and are enabled, difficulty ascends", () => {
    expect(validatePieces(pieces, graph)).toEqual([]);
  });

  it("puts the right-hand treble pieces before the left-hand bass pieces", () => {
    const hands = pieces.map(pieceHand);
    expect(hands.indexOf("left")).toBeGreaterThan(hands.lastIndexOf("right"));
    expect(hands.filter((h) => h === "right").length).toBeGreaterThan(0);
    expect(hands.filter((h) => h === "left").length).toBeGreaterThanOrEqual(2);
  });

  it("phrases tile every score exactly", () => {
    for (const p of pieces) {
      const measures = must(p.score.staves[0]).measures.length;
      const covered = p.phrases.flatMap((ph) =>
        Array.from({ length: ph.lastMeasure - ph.firstMeasure + 1 }, (_, i) => ph.firstMeasure + i),
      );
      expect(covered, p.id).toEqual(Array.from({ length: measures }, (_, i) => i + 1));
    }
  });

  it("requires exactly the reading nodes that cover its pitches", () => {
    for (const p of pieces.filter((x) => !isHandsPiece(x))) {
      const clef = pieceHand(p) === "right" ? "treble" : "bass";
      const tiers = notes(p).map((n) => tierOf(graph, clef, n.name));
      expect(tiers.includes(null), `${p.id} has a pitch outside the ${clef} reading nodes`).toBe(
        false,
      );
      const top = Math.max(...tiers.map((t) => t ?? 0));
      const expected = ["landmarks", "steps", "skips"]
        .slice(0, top + 1)
        .map((t) => `read.${clef}.${t}`);
      expect([...p.requiredNodeIds].sort(), p.id).toEqual([...expected].sort());
    }
  });

  it("ends every tune on the tonic, in C major", () => {
    for (const p of pieces) {
      expect(must(notes(p).at(-1)).midi % 12, `${p.id} final note`).toBe(0);
      expect(p.score.key).toEqual({ tonic: "C", mode: "major" });
    }
  });

  it("the left-hand version of a tune is the right-hand notes an octave lower", () => {
    for (const lh of pieces.filter((p) => p.id.endsWith("-lh"))) {
      const rh = pieces.find((p) => p.id === lh.id.replace(/-lh$/, ""));
      // Frère Jacques is bass only: its low G is below the treble reading nodes.
      if (rh === undefined) continue;
      expect(
        notes(lh).map((n) => [n.midi, n.value, n.dots]),
        lh.id,
      ).toEqual(notes(rh).map((n) => [n.midi - 12, n.value, n.dots]));
      expect(lh.phrases).toEqual(rh.phrases);
    }
  });

  it("matches the melodies note for note (pitch contour of the opening)", () => {
    const first = (id: string, n: number) =>
      notes(must(pieces.find((p) => p.id === id)))
        .slice(0, n)
        .map((x) => x.midi - 60);
    // E D C | E D C
    expect(first("piece.hot-cross-buns", 6)).toEqual([4, 2, 0, 4, 2, 0]);
    // Ode to Joy: E E F G | G F E D | C C D E
    expect(first("piece.ode-to-joy", 12)).toEqual([4, 4, 5, 7, 7, 5, 4, 2, 0, 0, 2, 4]);
    // Mary: E D C D | E E E | D D D | E G G
    expect(first("piece.mary-had-a-little-lamb", 15)).toEqual([
      4, 2, 0, 2, 4, 4, 4, 2, 2, 2, 4, 7, 7, 4, 2,
    ]);
    // Twinkle: C C G G A A G | F F E E D D C
    expect(first("piece.twinkle-twinkle", 14)).toEqual([0, 0, 7, 7, 9, 9, 7, 5, 5, 4, 4, 2, 2, 0]);
    // Au clair: C C C D E D | C E D D C
    expect(first("piece.au-clair-de-la-lune", 11)).toEqual([0, 0, 0, 2, 4, 2, 0, 4, 2, 2, 0]);
  });

  it("records the provenance of every piece in docs/licences.md", () => {
    const path = fileURLToPath(new URL("../../../../docs/licences.md", import.meta.url));
    const licences = readFileSync(path, "utf8");
    for (const p of pieces) expect(licences, p.title).toContain(p.title);
  });

  it("offers the right-hand pieces once the treble reading chain is fluent, not before", () => {
    const state = (s: "learning" | "fluent") => ({
      pieces: {},
      nodes: Object.fromEntries(
        ["landmarks", "steps", "skips"].map((t) => [`read.treble.${t}`, { state: s }]),
      ),
    });
    expect(listPieces(pieces, state("learning")).some((s) => s.unlocked)).toBe(false);
    const unlocked = listPieces(pieces, state("fluent")).filter((s) => s.unlocked);
    expect(unlocked.map((s) => s.piece.id)).toEqual(
      pieces.filter((p) => pieceHand(p) === "right").map((p) => p.id),
    );
  });
});

describe("hands-together pieces (T5.6)", () => {
  const handsPieces = pieces.filter(isHandsPiece);
  const byId = (id: string): Piece => must(pieces.find((p) => p.id === id));

  it("is each treble piece again, for both hands, after every one-hand piece", () => {
    const treble = pieces.filter((p) => pieceHand(p) === "right").map((p) => p.id);
    expect(handsPieces.map((p) => p.handsOf)).toEqual(treble);
    expect(handsPieces.map((p) => p.id)).toEqual(treble.map((id) => `${id}-hands`));
    const firstHands = pieces.findIndex(isHandsPiece);
    expect(pieces.slice(firstHands).every(isHandsPiece)).toBe(true);
    for (const p of handsPieces) {
      expect(pieceHand(p)).toBe("both");
      expect(p.requiredNodeIds).toEqual(["hands.coord.basic"]);
      expect(p.score.staves.map((s) => s.clef)).toEqual(["treble", "bass"]);
    }
  });

  it("keeps the melody and the phrases of its one-hand piece", () => {
    for (const p of handsPieces) {
      const base = byId(must(p.handsOf));
      expect(p.score.staves[0], p.id).toEqual(base.score.staves[0]);
      expect(p.phrases, p.id).toEqual(base.phrases);
      expect(p.title).toBe(`${base.title} (hands together)`);
    }
  });

  it("phrases tile both staves: each cuts both at the same bars, and together they are the score", () => {
    for (const p of handsPieces) {
      const cut = p.phrases.map((_, i) => phraseScore(p, i));
      p.phrases.forEach((ph, i) => {
        const bars = ph.lastMeasure - ph.firstMeasure + 1;
        expect(
          must(cut[i]).staves.map((s) => s.measures.length),
          `${p.id} phrase ${String(i + 1)}`,
        ).toEqual([bars, bars]);
      });
      for (const staff of [0, 1]) {
        expect(
          cut.flatMap((c) => must(c.staves[staff]).measures),
          `${p.id} staff ${String(staff)}`,
        ).toEqual(must(p.score.staves[staff]).measures);
      }
    }
  });

  it("left-hand chords fit the melody: a shared pitch at every chord onset, or I at a cadence", () => {
    for (const p of handsPieces) expect(handsFitErrors(p), p.id).toEqual([]);
  });

  it("uses only I, IV and V block chords in C2 to C4, one per bar or half bar, ending on I", () => {
    for (const p of handsPieces) {
      const chords = handsChords(p.score);
      expect(chords.length, p.id).toBeGreaterThanOrEqual(must(p.score.staves[1]).measures.length);
      for (const c of chords) {
        expect(["I", "IV", "V"], p.id).toContain(c.roman);
        expect(Math.min(...c.midi)).toBeGreaterThanOrEqual(36);
        expect(Math.max(...c.midi)).toBeLessThanOrEqual(60);
        expect([2, 4]).toContain(c.durationBeats);
      }
      expect(must(chords.at(-1)).roman, `${p.id} ends on I`).toBe("I");
    }
  });

  it("writes the chords chosen for each tune, voiced so the hand moves least", () => {
    const romans = (id: string) =>
      handsChords(byId(id).score)
        .map((c) => c.roman)
        .join(" ");
    expect(romans("piece.hot-cross-buns-hands")).toBe("I I I V I");
    expect(romans("piece.ode-to-joy-hands")).toBe("I V I I V I V I V I");
    expect(romans("piece.au-clair-de-la-lune-hands")).toBe("I I V I V I");
    // Twinkle: C3-E3-G3, then F3-A3-C4 (the F above is nearer than the one below), then back.
    const twinkle = handsChords(byId("piece.twinkle-twinkle-hands").score);
    expect(twinkle.slice(0, 4).map((c) => c.midi)).toEqual([
      [48, 52, 55],
      [53, 57, 60],
      [48, 52, 55],
      [53, 57, 60],
    ]);
  });

  it("unlocks once its one-hand piece is played through and hands.coord.basic is fluent", () => {
    const treble = Object.fromEntries(
      ["landmarks", "steps", "skips"].map((t) => [`read.treble.${t}`, { state: "mastered" }]),
    );
    const cases: [string, "available" | "learning" | "fluent" | "mastered", boolean, boolean][] = [
      ["coord learning, tune played through", "learning", true, false],
      ["coord available, tune played through", "available", true, false],
      ["coord fluent, tune not played through", "fluent", false, false],
      ["coord fluent, tune played through", "fluent", true, true],
      ["coord mastered, tune played through", "mastered", true, true],
    ];
    for (const [label, coord, done, unlocked] of cases) {
      const learner = {
        nodes: { ...treble, "hands.coord.basic": { state: coord } },
        pieces: done ? { "piece.ode-to-joy": { phrases: {}, runs: 1, completedAt: 1 } } : {},
      } as Parameters<typeof listPieces>[1];
      const statuses = listPieces(pieces, learner);
      const ode = must(statuses.find((s) => s.piece.id === "piece.ode-to-joy-hands"));
      expect(ode.unlocked, label).toBe(unlocked);
      // Only the hands version of the tune that was played through.
      expect(statuses.filter((s) => isHandsPiece(s.piece) && s.unlocked).length, label).toBe(
        unlocked ? 1 : 0,
      );
    }
  });
});
