import type { SkillNode } from "../graph/schema.js";
import { handsChords } from "../pieces/hands.js";
import type { Piece } from "../pieces/schema.js";
import { isHandsPiece, phraseScore } from "../pieces/schema.js";
import { spelledToMidi, type ScoreSpec } from "../score/schema.js";
import type { StimulusEvent } from "../stimulus/types.js";
import { latencyField } from "./build.js";
import type { Hand, PerformanceTarget } from "./expected.js";
import { itemId } from "./ids.js";
import {
  PIECE_KEYBOARD_MARGIN,
  PIECE_TEMPO_BPM,
  PieceLineItemParams,
  responseWindowMs,
} from "./piece-line.js";
import { COUNT_IN_PITCH, COUNT_IN_VELOCITY } from "./rhythm.js";
import type { Generator, ItemInstance, ItemParams } from "./types.js";

/** The graph node whose items are hands-together phrases (T5.6). Separate from `apply.pieces`. */
export const PIECE_HANDS_NODE_ID = "apply.pieces-hands";

const HAND_OF_CLEF: Partial<Record<string, Hand>> = { treble: "rh", bass: "lh" };

/**
 * Every note of every staff of `score` as a performance expects it (R27): the ids, onsets and
 * hands that `expectedFromScore` in scoring gives the same score (a chord tone is `n17.1`), beat 0
 * at the first downbeat, in onset order with staff order kept at equal onsets. A tied note
 * lengthens the note it continues.
 */
export function performanceNotes(score: ScoreSpec): PerformanceTarget["notes"] {
  const beatValue = score.meter?.beatValue ?? 4;
  const notes = score.staves.flatMap((staff) => {
    const hand = HAND_OF_CLEF[staff.clef];
    if (hand === undefined) return [];
    const out: PerformanceTarget["notes"] = [];
    const open = new Map<number, PerformanceTarget["notes"][number]>();
    let t = 0;
    for (const measure of staff.measures) {
      for (const el of measure) {
        const beats = (beatValue / el.duration.value) * (el.duration.dots === 1 ? 1.5 : 1);
        if (el.kind === "note") {
          const tie = el.duration.tie;
          const tiedIn = tie === "stop" || tie === "continue";
          const tiesOn = tie === "start" || tie === "continue";
          el.pitches.forEach((p, k) => {
            const midi = spelledToMidi(p);
            const prev = tiedIn ? open.get(midi) : undefined;
            let n = prev;
            if (n !== undefined) {
              n.durationBeats += beats;
            } else {
              n = {
                id: el.pitches.length === 1 ? el.id : `${el.id}.${String(k)}`,
                midi,
                onsetBeats: t,
                durationBeats: beats,
                hand,
              };
              out.push(n);
            }
            if (tiesOn) open.set(midi, n);
            else open.delete(midi);
          });
        }
        t += beats;
      }
    }
    return out;
  });
  return notes.sort((a, b) => a.onsetBeats - b.onsetBeats);
}

/**
 * Hands-together phrases (T5.6): one item per phrase of every hands-together piece in `pieces`
 * (the ones with `handsOf`), in library order. The display is the phrase on a grand staff, the
 * stimulus a one-bar count-in only (R17, as for reading), and the answer a `performance` of both
 * hands (R27), so the generator needs polyphonic input and the composer offers it with MIDI only.
 * The chords' numerals and symbols go in the presentation (`prog`, `symbols`) for the labels
 * beside the staff. Injected like `pieceLine`, because the pieces live outside core.
 */
export function createPieceHands(pieces: readonly Piece[]): Generator {
  const own = pieces.filter(isHandsPiece);
  const find = (params: ItemParams) => {
    const { piece: pieceId, phrase } = PieceLineItemParams.parse(params);
    const piece = own.find((p) => p.id === pieceId);
    if (piece === undefined || phrase > piece.phrases.length) {
      throw new RangeError(`unknown hands-together phrase ${pieceId} ${String(phrase)}`);
    }
    return { piece, phrase };
  };
  return {
    id: "pieceHands",
    listItems(): ItemParams[] {
      return own.flatMap((piece) =>
        piece.phrases.map((_, i) => ({ piece: piece.id, phrase: i + 1 })),
      );
    },
    generate(node: SkillNode, params: ItemParams): ItemInstance {
      const { piece, phrase } = find(params);
      const display = phraseScore(piece, phrase - 1);
      const notes = performanceNotes(display);
      const beatsPerBar = display.meter?.beats ?? 4;
      const tempoBpm = PIECE_TEMPO_BPM;
      const beatSec = 60 / tempoBpm;
      const events: StimulusEvent[] = Array.from({ length: beatsPerBar }, (_, i) => ({
        atSec: i * beatSec,
        midi: [COUNT_IN_PITCH],
        durationSec: 0.1,
        velocity: COUNT_IN_VELOCITY,
        role: "count-in" as const,
      }));
      const chords = handsChords(display);
      const midi = notes.map((n) => n.midi);
      const itemParams: ItemParams = { piece: piece.id, phrase };
      return {
        itemId: itemId(node.id, itemParams),
        nodeId: node.id,
        generator: "pieceHands",
        params: itemParams,
        presentation: {
          piece: piece.id,
          phrase,
          tempoBpm,
          prog: chords.map((c) => c.roman ?? c.symbol),
          symbols: chords.map((c) => c.symbol),
        },
        stimulus: { events, tempoBpm },
        display,
        inputRange: {
          low: Math.max(21, Math.min(...midi) - PIECE_KEYBOARD_MARGIN),
          high: Math.min(108, Math.max(...midi) + PIECE_KEYBOARD_MARGIN),
        },
        expected: {
          play: { kind: "performance", notes, tempoBpm, beatsPerBar },
          responseWindowMs: responseWindowMs(
            notes.map((n) => n.onsetBeats),
            tempoBpm,
          ),
        },
        ...latencyField(node),
      };
    },
  };
}
