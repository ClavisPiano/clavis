import type { SkillNode } from "../graph/schema.js";
import type { Piece } from "../pieces/schema.js";
import { phraseScore } from "../pieces/schema.js";
import type { StimulusEvent } from "../stimulus/types.js";
import type { VoiceRange } from "../theory/keys.js";
import { latencyField } from "./build.js";
import { itemId } from "./ids.js";
import {
  PIECE_KEYBOARD_MARGIN,
  PIECE_TEMPO_BPM,
  PieceLineItemParams,
  lineNotes,
  responseWindowMs,
} from "./piece-line.js";
import { COUNT_IN_PITCH, COUNT_IN_VELOCITY } from "./rhythm.js";
import type { Generator, ItemInstance, ItemParams } from "./types.js";

/** The graph node whose items are phrases played by ear. Separate from `apply.pieces` (MP, TP.6). */
export const PIECE_EAR_NODE_ID = "apply.piece-ear";

/** A little air between repeated notes so each one is heard as a new note. */
const NOTE_GAP = 0.9;

/**
 * Play it by ear (MP, TP.6): one item per phrase of every piece in `pieces`. The learner hears the
 * phrase with no notation, is cued to sing or hum it (ungraded, R29), then plays it, and only then
 * is the score revealed (`reveal`, drawn with the feedback). Only the played line is graded. The audio is a one bar count-in and
 * the phrase at the piece's slow tempo. Which phrases are offered, and when, is the composer's
 * call: it only offers the phrases of pieces the learner has already read.
 */
export function createPieceEar(pieces: readonly Piece[]): Generator {
  const find = (params: ItemParams) => {
    const { piece: pieceId, phrase } = PieceLineItemParams.parse(params);
    const piece = pieces.find((p) => p.id === pieceId);
    if (piece === undefined || phrase > piece.phrases.length) {
      throw new RangeError(`unknown piece phrase ${pieceId} ${String(phrase)}`);
    }
    return { piece, phrase };
  };
  return {
    id: "pieceEar",
    listItems(): ItemParams[] {
      return pieces.flatMap((piece) =>
        piece.phrases.map((_, i) => ({ piece: piece.id, phrase: i + 1 })),
      );
    },
    generate(node: SkillNode, params: ItemParams): ItemInstance {
      const { piece, phrase } = find(params);
      const reveal = phraseScore(piece, phrase - 1);
      const notes = lineNotes(reveal);
      const midi = notes.map((n) => n.midi);
      const onsetsBeats = notes.map((n) => n.onsetBeats);
      const beatsPerBar = reveal.meter?.beats ?? 4;
      const tempoBpm = PIECE_TEMPO_BPM;
      const beatSec = 60 / tempoBpm;

      const events: StimulusEvent[] = [];
      for (let i = 0; i < beatsPerBar; i++) {
        events.push({
          atSec: i * beatSec,
          midi: [COUNT_IN_PITCH],
          durationSec: 0.1,
          velocity: COUNT_IN_VELOCITY,
          role: "count-in",
        });
      }
      const start = beatsPerBar * beatSec;
      for (const n of notes) {
        events.push({
          atSec: start + n.onsetBeats * beatSec,
          midi: [n.midi],
          durationSec: n.durationBeats * beatSec * NOTE_GAP,
          velocity: 0.8,
          role: "target",
        });
      }
      const inputRange: VoiceRange = {
        low: Math.max(21, Math.min(...midi) - PIECE_KEYBOARD_MARGIN),
        high: Math.min(108, Math.max(...midi) + PIECE_KEYBOARD_MARGIN),
      };
      const itemParams: ItemParams = { piece: piece.id, phrase };
      return {
        itemId: itemId(node.id, itemParams),
        nodeId: node.id,
        generator: "pieceEar",
        params: itemParams,
        presentation: { piece: piece.id, phrase, tempoBpm },
        stimulus: { events, tempoBpm },
        reveal,
        inputRange,
        cue: true,
        expected: {
          play: { kind: "line", midi, onsetsBeats, tempoBpm, beatsPerBar },
          responseWindowMs: responseWindowMs(onsetsBeats, tempoBpm),
        },
        ...latencyField(node),
      };
    },
  };
}
