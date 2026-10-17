/**
 * Concept cards for the pieces nodes (TP.5, TP.6). Same rules as `v1.ts`: `docs/content/cards.md`.
 * The card test requires a card for every enabled node, and `apply.pieces` and `apply.piece-ear`
 * are enabled with `pieceLine` and `pieceEar`.
 */
export const PIECE_CARDS_V1: unknown[] = [
  {
    id: "concept.apply.pieces",
    nodeIds: ["apply.pieces"],
    title: "Playing a piece",
    body: [
      "A piece is a short, familiar tune for one hand, split into phrases. In your normal sessions you learn it a phrase or two at a time. When you have played every phrase, you play the whole tune from start to finish.",
      "A phrase is a few bars, shown on the staff. Four clicks set the pulse, then you play the notes, starting on the next beat.",
      "Pitch comes first. If a note is wrong, that is what you are told. Once every note is right, your rhythm is checked against your own pace, so a slow, steady performance is fine.",
    ],
    howTo: [
      "The phrase appears on the staff and four clicks count you in.",
      "Play the notes on your piano, starting on the beat after the fourth click. Every note must be in the exact octave.",
      "Keep it even. You are judged on your own tempo, not a fixed one.",
      "After you answer, the score marks the notes you got right, and the phrase is played back.",
      "When every phrase has been played right once, Home offers to play the whole piece through.",
    ],
    examples: [
      {
        kind: "staff",
        label: "Hot Cross Buns, the first three notes",
        clef: "treble",
        positions: ["E4", "D4", "C4"],
      },
    ],
    links: [],
  },
  {
    id: "concept.apply.piece-ear",
    nodeIds: ["apply.piece-ear"],
    title: "Playing a tune by ear",
    body: [
      "Once you can read every phrase of a tune, you can try it the other way round: listen first, with no music in front of you, then play it from memory.",
      "Singing or humming it first, out loud or in your head, makes you hear the tune before your fingers move. Nothing listens to your voice: only the notes you play are marked.",
      "Afterwards the score appears so you can check what you did against what is written.",
    ],
    howTo: [
      "Four clicks set the pulse, then the phrase plays. Replay it if you need to.",
      "Sing or hum it, out loud or in your head, then press Ready. Nothing is timed or marked at this step.",
      "Now play it on your piano. Every note must be in the exact octave, and your rhythm is judged against your own pace.",
      "The score is shown with the notes you got right and wrong marked.",
    ],
    examples: [],
    links: [],
  },
];
