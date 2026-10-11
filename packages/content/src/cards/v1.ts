/**
 * Concept cards, v1 (spec 13). Written directly for now; see `docs/content/cards.md` for the
 * style rules. Every node whose generators are implemented needs a card (content test).
 *
 * Validated by `ConceptCardSchema` when loaded. Examples use scale degrees, so they sound in the
 * learner's key of the day.
 */

const MT = "https://www.musictheory.net/lessons";

export const ORIENT_CARD_ID = "concept.orient";

export const CARDS_V1: unknown[] = [
  {
    id: ORIENT_CARD_ID,
    nodeIds: [],
    title: "The key of the day",
    body: [
      "Each session is built around one key, shown at the top of the screen, for example C major. A key is a home note, called the tonic, plus the seven notes of its scale. Music in that key keeps pulling back towards home.",
      "Clavis names notes by their place in the scale. 1 is the tonic, 3 is the third note up, 5 the fifth, and 8 is 1 again an octave higher. These are scale degrees. They mean the same thing in every key, so what you learn in C major carries over to G major or E flat major.",
      "The warm-up plays the scale, then four chords: I, IV, V and back to I. This is a cadence. It sets the key in your ear so you can hear where each note sits relative to home. Ear items start with the same cadence.",
    ],
    howTo: [
      "Just listen. Nothing in the warm-up is marked.",
      "As the last chord rings, try humming its lowest note. That is 1, the note everything else is measured from.",
      "Tap Continue when you are ready for the first item.",
    ],
    examples: [
      { kind: "scale", label: "The scale, 1 to 8" },
      { kind: "cadence", label: "The cadence: I, IV, V, I" },
      { kind: "degrees", label: "Home: 1 after the cadence", degrees: [1], afterCadence: true },
    ],
    links: [
      { label: "The major scale (musictheory.net)", url: `${MT}/21` },
      { label: "Scale degrees (musictheory.net)", url: `${MT}/23` },
    ],
  },
  {
    id: "concept.degrees.major.135",
    nodeIds: ["ear.degrees.major.135"],
    title: "Degrees 1, 3 and 5",
    body: [
      "Degrees 1, 3 and 5 are the notes of the home chord. In C major they are C, E and G. They are the most stable notes in the key, so melodies tend to rest on them.",
      "Each has its own feel after the cadence. 1 sounds settled and finished. 5 sounds strong and open, but not quite finished. 3 sits between them and gives the key its bright, major colour.",
      "The skill is recognising them by that feel, in any key, rather than working out letter names.",
    ],
    howTo: [
      "Listen to the cadence, then one note. Work out whether it is 1, 3 or 5.",
      "When asked to sing, sing it back on any vowel, in any octave. Within a quarter of a tone counts.",
      "When asked to play, press that note on your piano. Any octave counts.",
      "In Away mode you sing, or tap the note on the on-screen keyboard.",
      "Quick answers count for more than slow ones, but get it right first.",
    ],
    examples: [
      { kind: "degrees", label: "1 after the cadence", degrees: [1], afterCadence: true },
      { kind: "degrees", label: "3 after the cadence", degrees: [3], afterCadence: true },
      { kind: "degrees", label: "5 after the cadence", degrees: [5], afterCadence: true },
      { kind: "degrees", label: "1, 3, 5, 8 in a row", degrees: [1, 3, 5, 8], afterCadence: false },
    ],
    links: [{ label: "Scale degrees (musictheory.net)", url: `${MT}/23` }],
  },
  {
    id: "concept.degrees.major.diatonic",
    nodeIds: ["ear.degrees.major.diatonic"],
    title: "All seven major degrees",
    body: [
      "The major scale has seven notes before it repeats. Besides the stable 1, 3 and 5 there are 2, 4, 6 and 7. These feel less settled: each leans towards a stable neighbour.",
      "7 is a half step below home and pulls hard up to 1. 4 leans down to 3. 2 wants to fall to 1 or rise to 3. 6 is gentler and usually falls to 5.",
      "Hearing that pull is the skill. It tells you where a note sits in the key, whatever the key.",
    ],
    howTo: [
      "Listen to the cadence, then one note. Work out which degree it is, 1 to 7.",
      "If you are unsure, sing up or down to the nearest 1, 3 or 5 in your head and count the steps.",
      "When asked to sing, sing it back on any vowel, in any octave.",
      "When asked to play, press that note on your piano. Any octave counts.",
      "In Away mode you sing, or tap the note on the on-screen keyboard.",
    ],
    examples: [
      { kind: "scale", label: "The scale, 1 to 8" },
      { kind: "degrees", label: "7 pulling up to 1", degrees: [7, 8], afterCadence: true },
      { kind: "degrees", label: "4 leaning down to 3", degrees: [4, 3], afterCadence: true },
      { kind: "degrees", label: "6 falling to 5", degrees: [6, 5], afterCadence: true },
    ],
    links: [
      { label: "The major scale (musictheory.net)", url: `${MT}/21` },
      { label: "Scale degrees (musictheory.net)", url: `${MT}/23` },
    ],
  },
  {
    id: "concept.degrees.minor",
    nodeIds: ["ear.degrees.minor"],
    title: "Minor degrees",
    body: [
      "A minor key has its own home note and scale. Compared with major on the same tonic, degrees 3, 6 and 7 are each a half step lower. The lower 3 is what makes minor sound darker.",
      "Minor has a second common form, harmonic minor, which raises 7 again so it pulls up to 1 like it does in major. You will hear both forms, so 7 can be a whole step or a half step below home.",
      "Items in this skill are always in a minor key, with a minor cadence (i, iv, V, i) first.",
    ],
    howTo: [
      "Listen to the minor cadence, then one note. Work out which degree it is, 1 to 7.",
      "Use 1, 3 and 5 of the minor home chord as anchors, as you did in major.",
      "When asked to sing, sing it back on any vowel, in any octave.",
      "When asked to play, press that note on your piano. Any octave counts.",
      "In Away mode you sing, or tap the note on the on-screen keyboard.",
    ],
    examples: [
      { kind: "scale", label: "Major scale on the same tonic", mode: "major" },
      { kind: "scale", label: "Natural minor scale", mode: "minor" },
      {
        kind: "degrees",
        label: "Harmonic minor: 7 pulling up to 1",
        mode: "minor",
        minorVariant: "harmonic",
        degrees: [7, 8],
        afterCadence: true,
      },
      {
        kind: "degrees",
        label: "Minor 3 after the cadence",
        mode: "minor",
        degrees: [3],
        afterCadence: true,
      },
    ],
    links: [{ label: "The minor scales (musictheory.net)", url: `${MT}/22` }],
  },
  {
    id: "concept.cells.major",
    nodeIds: ["ear.cells.major.2-4"],
    title: "Melodic cells",
    body: [
      "A melodic cell is a short group of two to four notes from the scale. Cells are the building blocks of tunes. Most move by step, to the next note of the scale, or leap between 1, 3 and 5.",
      "Hear a cell as a shape relative to home rather than as separate notes: up a step, down to 1, a leap from 5 down to 3. Once you hear the shape, singing and playing it back gets much easier.",
    ],
    howTo: [
      "Listen to the cadence, then two to four notes.",
      "When asked to sing, sing them back in order, on any vowel, in any octave.",
      "Then play them in order on your piano. The octave does not matter, the order does.",
      "A missing or wrong note costs part of the score, not the whole item.",
      "In Away mode you sing, or tap the notes on the on-screen keyboard.",
    ],
    examples: [
      { kind: "degrees", label: "Up by step: 1 2 3", degrees: [1, 2, 3], afterCadence: true },
      {
        kind: "degrees",
        label: "Down the home chord: 5 3 1",
        degrees: [5, 3, 1],
        afterCadence: true,
      },
      {
        kind: "degrees",
        label: "Step and leap: 3 2 1 5",
        degrees: [3, 2, 1, 5],
        afterCadence: true,
      },
    ],
    links: [{ label: "Generic intervals (musictheory.net)", url: `${MT}/30` }],
  },
  {
    id: "concept.rhythm.echo",
    nodeIds: ["ear.rhythm.echo"],
    title: "Rhythm echo",
    body: [
      "Rhythm is when notes happen, not which notes. The beat is the steady pulse you would tap your foot to. These rhythms are in 4/4: four beats to a bar.",
      "A note can land on a beat or halfway between two beats, and some notes last longer than one beat. The gaps between notes carry the rhythm as much as the notes do.",
    ],
    howTo: [
      "Listen to four clicks, one bar, which set the speed.",
      "Then listen to a rhythm of one or two bars, all on the same note.",
      "Play it back on any key of your piano. In Away mode, tap the pad.",
      "Keep the gaps between notes in proportion. A slightly faster or slower tempo is fine.",
    ],
    examples: [
      { kind: "rhythm", label: "Four even beats", onsetsBeats: [0, 1, 2, 3] },
      { kind: "rhythm", label: "Two halves of a beat: 1, 2 and, 3", onsetsBeats: [0, 1, 1.5, 2] },
      { kind: "rhythm", label: "A silent beat: 1, 2, 3, (rest)", onsetsBeats: [0, 1, 2] },
    ],
    links: [
      { label: "Note duration (musictheory.net)", url: `${MT}/11` },
      { label: "Measures and time signatures (musictheory.net)", url: `${MT}/12` },
    ],
  },
];
