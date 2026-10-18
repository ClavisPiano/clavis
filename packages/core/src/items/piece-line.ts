import { z } from "zod";
import type { SkillNode } from "../graph/schema.js";
import type { Piece } from "../pieces/schema.js";
import { isHandsPiece, phraseScore } from "../pieces/schema.js";
import { spelledToMidi, type ScoreSpec } from "../score/schema.js";
import type { StimulusEvent } from "../stimulus/types.js";
import type { VoiceRange } from "../theory/keys.js";
import { latencyField } from "./build.js";
import { itemId } from "./ids.js";
import { COUNT_IN_PITCH, COUNT_IN_VELOCITY } from "./rhythm.js";
import type { Generator, ItemInstance, ItemParams } from "./types.js";

/** The graph node whose items are piece phrases. Attempts on phrases are recorded against it. */
export const PIECES_NODE_ID = "apply.pieces";

/** Slow and steady: the learner reads and plays, so the count-in sets a gentle pulse. */
export const PIECE_TEMPO_BPM = 60;

/** Room either side of a phrase's notes on the on-screen keyboard, in semitones. */
export const PIECE_KEYBOARD_MARGIN = 7;

export const PieceLineItemParams = z.object({ piece: z.string(), phrase: z.int().min(1) });

/** One struck note of a score: pitch, onset and sounding length, in beats of the meter's beat value. */
export interface LineNote {
  midi: number;
  onsetBeats: number;
  durationBeats: number;
}

/**
 * The struck notes of a score, first onset at 0. A tied note continues the sound before it, so it
 * adds no note and lengthens the one it ties to.
 */
export function lineNotes(score: ScoreSpec): LineNote[] {
  const staff = score.staves[0];
  const beatValue = score.meter?.beatValue ?? 4;
  const notes: LineNote[] = [];
  let t = 0;
  for (const measure of staff?.measures ?? []) {
    for (const el of measure) {
      const beats = (beatValue / el.duration.value) * (el.duration.dots === 1 ? 1.5 : 1);
      const tiedOn = el.duration.tie === "stop" || el.duration.tie === "continue";
      if (el.kind === "note") {
        const pitch = el.pitches[0];
        const last = notes[notes.length - 1];
        if (tiedOn && last !== undefined) {
          last.durationBeats += beats;
        } else if (pitch !== undefined) {
          notes.push({ midi: spelledToMidi(pitch), onsetBeats: t, durationBeats: beats });
        }
      }
      t += beats;
    }
  }
  const first = notes[0]?.onsetBeats ?? 0;
  return notes.map((n) => ({ ...n, onsetBeats: n.onsetBeats - first }));
}

/** The sounding notes of a score and the onset of each in beats of the meter's beat value. */
export function lineTiming(score: ScoreSpec): { midi: number[]; onsetsBeats: number[] } {
  const notes = lineNotes(score);
  return { midi: notes.map((n) => n.midi), onsetsBeats: notes.map((n) => n.onsetBeats) };
}

/** How long the learner has to play a phrase, after the count-in, before it times out. */
export function responseWindowMs(onsetsBeats: readonly number[], tempoBpm: number): number {
  const beatMs = 60000 / tempoBpm;
  const length = (onsetsBeats[onsetsBeats.length - 1] ?? 0) + 2;
  return Math.round(Math.max(12000, length * beatMs * 2.5 + 6000));
}

/**
 * Piece phrases (MP, TP.4): one item per phrase of every piece in `pieces`, in library order. The
 * score is the phrase as written, the stimulus is only a count-in (R17: no audio of the phrase
 * before the learner plays), and the expected response is a `line` (pitch first, then rhythm).
 * Built over the library because `core` cannot import `content`, so the caller supplies the pieces
 * (the composer's generator registry is injectable for the same reason).
 */
export function createPieceLine(library: readonly Piece[]): Generator {
  // One hand only: hands-together pieces (T5.6) are `pieceHands` phrases.
  const pieces = library.filter((p) => !isHandsPiece(p));
  const find = (params: ItemParams) => {
    const { piece: pieceId, phrase } = PieceLineItemParams.parse(params);
    const piece = pieces.find((p) => p.id === pieceId);
    if (piece === undefined || phrase > piece.phrases.length) {
      throw new RangeError(`unknown piece phrase ${pieceId} ${String(phrase)}`);
    }
    return { piece, phrase };
  };
  return {
    id: "pieceLine",
    listItems(): ItemParams[] {
      return pieces.flatMap((piece) =>
        piece.phrases.map((_, i) => ({ piece: piece.id, phrase: i + 1 })),
      );
    },
    generate(node: SkillNode, params: ItemParams): ItemInstance {
      const { piece, phrase } = find(params);
      const display = phraseScore(piece, phrase - 1);
      const { midi, onsetsBeats } = lineTiming(display);
      const beatsPerBar = display.meter?.beats ?? 4;
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
      const inputRange: VoiceRange = {
        low: Math.max(21, Math.min(...midi) - PIECE_KEYBOARD_MARGIN),
        high: Math.min(108, Math.max(...midi) + PIECE_KEYBOARD_MARGIN),
      };
      const itemParams: ItemParams = { piece: piece.id, phrase };
      return {
        itemId: itemId(node.id, itemParams),
        nodeId: node.id,
        generator: "pieceLine",
        params: itemParams,
        presentation: { piece: piece.id, phrase, tempoBpm },
        stimulus: { events, tempoBpm },
        display,
        inputRange,
        expected: {
          play: { kind: "line", midi, onsetsBeats, tempoBpm, beatsPerBar },
          responseWindowMs: responseWindowMs(onsetsBeats, tempoBpm),
        },
        ...latencyField(node),
      };
    },
  };
}
