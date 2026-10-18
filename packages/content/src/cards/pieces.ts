/**
 * Concept cards for the pieces nodes (TP.5, TP.6). Same rules as `v1.ts`: `docs/content/cards.md`.
 * The card test requires a card for every enabled node, and `apply.pieces` and `apply.piece-ear`
 * are enabled with `pieceLine` and `pieceEar`, and `apply.pieces-hands` with `pieceHands` (T5.6).
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
  {
    id: "concept.apply.pieces-hands",
    nodeIds: ["apply.pieces-hands"],
    title: "Playing a piece with both hands",
    body: [
      "Once you have played a tune all the way through with your right hand, and you can play a melody over left-hand chords, the tune comes back for both hands.",
      "The right hand plays the melody you already know, on the top staff. The left hand holds a chord under it on the bottom staff: I, IV or V, one to a bar or one to each half bar. Each chord shares a note with the melody where it starts.",
      "You learn it a phrase or two at a time, as before, and when every phrase has been played right once, you play it from start to finish. It needs a MIDI keyboard, so the app can hear both hands at once.",
    ],
    howTo: [
      "The phrase appears on the grand staff, with the chord names beside it, and four clicks count you in at a slow, steady pulse.",
      "Play both hands together from the beat after the fourth click: strike each chord with the melody note above it and hold it until the next one.",
      "Every note must be in the exact octave and in time. The feedback names the bar and the hand of any slip, for example: bar 3, LH late.",
    ],
    examples: [
      {
        kind: "staff",
        label: "The left hand's C chord under the start of Hot Cross Buns",
        clef: "bass",
        positions: ["C3", "E3", "G3"],
      },
    ],
    links: [],
  },
];
