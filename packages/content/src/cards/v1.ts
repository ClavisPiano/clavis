/**
 * Concept cards, v1 (spec 13). Written directly for now; see `docs/content/cards.md` for the
 * style rules. Every node whose generators are implemented needs a card (content test).
 *
 * Validated by `ConceptCardSchema` when loaded. Examples use scale degrees, so they sound in the
 * learner's key of the day.
 */

import { PIECE_CARDS_V1 } from "./pieces.js";
import { READ_CARDS_V1 } from "./read.js";

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
      "As the last chord rings, listen for its lowest note. That is 1, the note everything else is measured from.",
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
      "Degrees 1, 3 and 5 are the notes of the home chord. In C major they are C, E and G, in G major they are G, B and D. They are the most stable notes in the key, so melodies tend to rest on them.",
      "Each has its own feel after the cadence. 1 sounds settled and finished. 5 sounds strong and open, but not quite finished. 3 sits between them and gives the key its bright, major colour.",
      "The skill is recognising them by that feel, in any key, rather than working out letter names.",
    ],
    howTo: [
      "Listen to the cadence, then one note. Work out whether it is 1, 3 or 5.",
      "When asked to play, press that note on your piano. Any octave counts.",
      "In Away mode, tap the note on the on-screen keyboard.",
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
      "If you are unsure, step up or down to the nearest 1, 3 or 5 in your head and count the steps.",
      "When asked to play, press that note on your piano. Any octave counts.",
      "In Away mode, tap the note on the on-screen keyboard.",
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
      "When asked to play, press that note on your piano. Any octave counts.",
      "In Away mode, tap the note on the on-screen keyboard.",
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
      "Hear a cell as a shape relative to home rather than as separate notes: up a step, down to 1, a leap from 5 down to 3. Once you hear the shape, playing it back gets much easier.",
    ],
    howTo: [
      "Listen to the cadence, then two to four notes.",
      "Then play them in order on your piano. The octave does not matter, the order does.",
      "A missing or wrong note costs part of the score, not the whole item.",
      "In Away mode, tap the notes on the on-screen keyboard.",
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
  {
    id: "concept.bass.motion",
    nodeIds: ["ear.bass.I-IV-V-vi"],
    title: "Bass motion",
    body: [
      "Under every melody sits a bass line. The lowest note of each chord is its root, and the way the roots move from chord to chord is called root motion. It is the skeleton of a progression.",
      "This skill uses four chords built on the scale: I (root 1), IV (root 4), V (root 5) and vi (root 6). I and IV sound settled and warm. V pushes back towards home. vi is the softer, sadder relative of I.",
      "Listen to the lowest voice as it steps or leaps. Each move has its own pull, and hearing those pulls tells you which chord has arrived.",
    ],
    howTo: [
      "Listen to the cadence, then four chords. The first is always I.",
      "Play the lowest note, the root, of each chord in order. The first is the home note, 1.",
      "Any octave on your piano counts. The order matters, the octave does not.",
      "A wrong or missing root costs part of the score, not the whole item.",
      "In Away mode, tap the roots on the on-screen keyboard.",
    ],
    examples: [
      {
        kind: "progression",
        label: "I IV V vi: the roots climb 1 4 5 6",
        romans: ["I", "IV", "V", "vi"],
        afterCadence: true,
      },
      {
        kind: "progression",
        label: "I vi IV V: the roots go 1 6 4 5",
        romans: ["I", "vi", "IV", "V"],
        afterCadence: true,
      },
      {
        kind: "degrees",
        label: "Just the roots: 1 4 5 6",
        degrees: [1, 4, 5, 6],
        afterCadence: true,
      },
    ],
    links: [
      { label: "Diatonic triads (musictheory.net)", url: `${MT}/43` },
      { label: "Root motion (musictheory.net)", url: `${MT}/56` },
    ],
  },
  {
    id: "concept.quality.triad",
    nodeIds: ["ear.quality.triad"],
    title: "Triad quality",
    body: [
      "A triad is three notes stacked in thirds: a root, a third above it and a fifth above that. The gap between the root and the middle note sets the colour. A major third sounds bright and open. A minor third, one half step smaller, sounds darker and sadder.",
      "You do not need to name the root to hear this. Listen to the whole chord and ask whether it is bright or dark. In a major key the chords on 1, 4 and 5 are major, and the chords on 2, 3 and 6 are minor, so you can compare them by ear.",
    ],
    howTo: [
      "Listen to the cadence, then one chord held for two beats.",
      "Tap the button that names its quality, such as major or minor.",
      "There is nothing to play: you choose an answer. Away mode works the same way.",
      "Quick answers count for more than slow ones, but get it right first.",
    ],
    examples: [
      {
        kind: "progression",
        label: "Major then minor: I then vi",
        romans: ["I", "vi"],
        afterCadence: true,
      },
      {
        kind: "progression",
        label: "Major then minor: IV then ii",
        romans: ["IV", "ii"],
        afterCadence: true,
      },
      {
        kind: "progression",
        label: "Major then minor: V then iii",
        romans: ["V", "iii"],
        afterCadence: true,
      },
    ],
    links: [{ label: "Triads (musictheory.net)", url: `${MT}/40` }],
  },
  {
    id: "concept.prog.core",
    nodeIds: ["ear.prog.core"],
    title: "Core progressions",
    body: [
      "A progression is a short chord loop, and a handful of them carry most of the pop and classical music you know. I-V-vi-IV is the famous four chord loop. I-IV-V climbs from home to the bright IV, then the tense V. ii-V-I is the classic jazz and classical turnaround. vi-IV-I-V starts on the sad relative of home and ends hanging on V.",
      "Do not try to name each chord. Listen to the shape: where it starts, which chord feels like an arrival, and where it leaves you. The first chord and the last chord tell you most.",
    ],
    howTo: [
      "Listen to the cadence, then one progression.",
      "Tap the progression you heard. The Roman numerals show the chords, such as I-V-vi-IV.",
      "There is nothing to play: you choose an answer. Away mode works the same way.",
      "Quick answers count for more than slow ones, but get it right first.",
    ],
    examples: [
      {
        kind: "progression",
        label: "I-V-vi-IV: bright, then sad, then home stretch",
        romans: ["I", "V", "vi", "IV"],
        afterCadence: true,
      },
      {
        kind: "progression",
        label: "ii-V-I: the turnaround",
        romans: ["ii", "V", "I"],
        afterCadence: true,
      },
      {
        kind: "progression",
        label: "vi-IV-I-V: starts dark and hangs open",
        romans: ["vi", "IV", "I", "V"],
        afterCadence: true,
      },
    ],
    links: [{ label: "Diatonic triads (musictheory.net)", url: `${MT}/43` }],
  },
  {
    id: "concept.cadence",
    nodeIds: ["ear.cadence"],
    title: "Cadences",
    body: [
      "A cadence is the two chord ending of a phrase, the musical full stop or comma. A perfect cadence, V to I, sounds finished: the tension of V resolves to home. A plagal cadence, IV to I, is softer, the amen at the end of a hymn. An imperfect cadence, I to V, stops on V and feels like a question or a comma. A deceptive cadence, V to vi, sets up the finish and then swerves to the sad relative.",
      "Ask whether the ending feels closed, open or surprised. Closed and firm is perfect, closed and gentle is plagal, open is imperfect, and a swerve is deceptive.",
    ],
    howTo: [
      "Listen to two warm-up chords, then the two chord ending.",
      "Tap the name of the cadence you heard.",
      "There is nothing to play: you choose an answer. Away mode works the same way.",
      "Quick answers count for more than slow ones, but get it right first.",
    ],
    examples: [
      {
        kind: "progression",
        label: "Perfect: I ii V I",
        romans: ["I", "ii", "V", "I"],
        afterCadence: false,
      },
      {
        kind: "progression",
        label: "Plagal: I ii IV I",
        romans: ["I", "ii", "IV", "I"],
        afterCadence: false,
      },
      {
        kind: "progression",
        label: "Deceptive: I ii V vi",
        romans: ["I", "ii", "V", "vi"],
        afterCadence: false,
      },
    ],
    links: [{ label: "Diatonic triads (musictheory.net)", url: `${MT}/43` }],
  },
  {
    id: "concept.prog.minor",
    nodeIds: ["ear.prog.minor"],
    title: "Minor progressions",
    body: [
      "In a minor key the chords change character. The home chord i is dark, iv is its darker neighbour, and v, built on the natural minor scale, is soft and modal. The major chords VI, III and VII come from the same scale and sound like bright patches in a dark room.",
      "Three loops to know: i-iv-v is the plain minor loop. i-VI-III-VII circles through the major chords and sounds like a rock anthem. i-VII-VI-V is the Andalusian cadence, a falling bass line that ends on a major V, found all through flamenco.",
    ],
    howTo: [
      "Listen to the minor cadence, then one progression.",
      "Tap the progression you heard. The Roman numerals show the chords, such as i-iv-v.",
      "A capital numeral is a major chord and a small one is minor.",
      "There is nothing to play: you choose an answer. Away mode works the same way.",
    ],
    examples: [
      {
        kind: "progression",
        label: "i-iv-v: the plain minor loop",
        mode: "minor",
        romans: ["i", "iv", "v"],
        afterCadence: true,
      },
      {
        kind: "progression",
        label: "i-VI-III-VII: the anthem loop",
        mode: "minor",
        romans: ["i", "VI", "III", "VII"],
        afterCadence: true,
      },
      {
        kind: "progression",
        label: "i-VII-VI-V: the Andalusian cadence",
        mode: "minor",
        romans: ["i", "VII", "VI", "V"],
        afterCadence: true,
      },
    ],
    links: [{ label: "Diatonic triads (musictheory.net)", url: `${MT}/43` }],
  },
  {
    id: "concept.prog.colour",
    nodeIds: ["ear.prog.colour"],
    title: "Colour chords",
    body: [
      "A colour chord is a chord from outside the key, borrowed to add flavour. V/V, said five of five, is the dominant of the dominant: a major chord on the second degree that pulls strongly towards V. The borrowed iv is the minor four chord taken from the parallel minor, and it adds a wistful shadow. bVII is the major chord a whole step below home, the bright rock sound of a mixolydian groove.",
      "Each one has a tell. V/V has a raised note that leans upward. iv turns a bright IV dark in a single step. bVII sounds like a flat, open step away from home.",
    ],
    howTo: [
      "Listen to the cadence, then one progression with a colour chord.",
      "Tap the progression you heard, such as I-bVII-IV-I.",
      "A small b before a numeral means that chord is lowered a half step.",
      "There is nothing to play: you choose an answer. Away mode works the same way.",
    ],
    examples: [
      {
        kind: "progression",
        label: "I-V/V-V-I: the secondary dominant",
        romans: ["I", "V/V", "V", "I"],
        afterCadence: true,
      },
      {
        kind: "progression",
        label: "I-IV-iv-I: bright IV turns dark",
        romans: ["I", "IV", "iv", "I"],
        afterCadence: true,
      },
      {
        kind: "progression",
        label: "I-bVII-IV-I: the rock step",
        romans: ["I", "bVII", "IV", "I"],
        afterCadence: true,
      },
    ],
    links: [{ label: "Diatonic triads (musictheory.net)", url: `${MT}/43` }],
  },
  {
    id: "concept.hands.lh.triads.root",
    nodeIds: ["hands.lh.triads.root"],
    title: "Left-hand triads",
    body: [
      "A triad is three notes stacked in thirds, and in root position the chord's name note, the root, is the lowest. Your left hand can play all three together as a block chord. In a major key the chords on 1, 4 and 5 are major (I, IV, V) and the chord on 6 is minor (vi).",
      "Each chord is written as three notes stacked on the bass staff, with its symbol and numeral shown alongside. Reading the shape is quicker than reading each note: a triad in root position sits on three lines or three spaces.",
      "Keep your hand relaxed and move the shortest way to the next chord. Press the three notes at the same moment.",
    ],
    howTo: [
      "This skill needs a MIDI keyboard. Choose it in Settings.",
      "Four chords are written on the bass staff, with a count-in of four clicks before the first.",
      "Play each chord with your left hand, all three notes together, holding it for two beats.",
      "Every chord tone must be right, and the rhythm judged against your own pace. A wrong note is named, for example E instead of F.",
    ],
    examples: [
      {
        kind: "progression",
        label: "I IV V I as block chords",
        romans: ["I", "IV", "V", "I"],
        afterCadence: false,
      },
      {
        kind: "staff",
        label: "The home chord in the bass: C E G",
        clef: "bass",
        positions: ["C3", "E3", "G3"],
      },
    ],
    links: [{ label: "Triads (musictheory.net)", url: `${MT}/40` }],
  },
  {
    id: "concept.byear.melody.simple",
    nodeIds: ["byear.melody.simple"],
    title: "Playing a heard melody",
    body: [
      "Playing by ear means hearing a tune and finding it on your instrument with no music in front of you. Start with a short, simple tune: it moves mostly by step, begins on 1, 3 or 5, and comes to rest on 1, home.",
      "Hearing it in your head first is the trick. Sing it or hum it, out loud or silently: if you can hold the tune in your head, your fingers only need to follow. Hear the shape and the rhythm as well as the notes: where it rises, where it settles, where it breathes. Nobody checks your voice, so this step is for you.",
      "Afterwards the score appears, so you can check what you did against what is written.",
    ],
    howTo: [
      "Listen to the cadence, then the whole tune. Replay it if you need to.",
      "Sing or hum it, out loud or in your head. Hear it again as often as you like, and press Ready when you are sure of it. Nothing listens to your voice and nothing is timed.",
      "Now play it on your piano, in the exact octave you heard. Only what you play is marked, and your rhythm is judged against your own pace.",
      "The score then shows what you got right and wrong.",
    ],
    examples: [
      {
        kind: "degrees",
        label: "Mostly steps, resting home: 1 2 3 2 1",
        degrees: [1, 2, 3, 2, 1],
        afterCadence: true,
      },
      {
        kind: "degrees",
        label: "A skip, then back by step: 3 5 4 3 2 1",
        degrees: [3, 5, 4, 3, 2, 1],
        afterCadence: true,
      },
    ],
    links: [{ label: "The major scale (musictheory.net)", url: `${MT}/21` }],
  },
  ...READ_CARDS_V1,
  ...PIECE_CARDS_V1,
];
