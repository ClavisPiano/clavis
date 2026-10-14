/**
 * Concept cards for the READ strand (T3.14). Same rules as `v1.ts`: `docs/content/cards.md`.
 *
 * Staff examples are in C major, which is where reading starts, and play their notes in order.
 * The READ generators ship with T3.15; the card test requires a card for each node listed here.
 */

const MT = "https://www.musictheory.net/lessons";

/** The READ nodes whose cards are written. T3.15 may not enable these without their cards. */
export const READ_CARD_NODE_IDS = [
  "read.bass.landmarks",
  "read.bass.steps",
  "read.bass.skips",
  "read.bass.intervals",
  "read.minor.accidentals",
  "read.rhythm.basic",
  "read.treble.landmarks",
  "read.treble.steps",
  "read.treble.skips",
] as const;

export const READ_CARDS_V1: unknown[] = [
  {
    id: "concept.read.bass.landmarks",
    nodeIds: ["read.bass.landmarks"],
    title: "Bass clef landmarks",
    body: [
      "The bass clef writes the low notes, the ones your left hand usually plays. Notes sit on five lines or in the spaces between them. The higher the note on the staff, the higher it sounds.",
      "You do not name every note from scratch. You learn a few landmarks and count from them. The two dots of the clef surround the F line, which is F below middle C. The bottom line is G. Low C hangs two ledger lines below the staff. Middle C sits on one ledger line above it, halfway between the bass and treble staves.",
      "Learn those four well and every other note is a short count away.",
    ],
    howTo: [
      "A bass staff appears with one note on it. There is no sound first.",
      "Find the note on your piano and play it. It must be in exactly the right octave: the same letter in another octave does not count.",
      "In Away mode, tap the note on the on-screen keyboard, which shows the bass register.",
      "After you answer, the note is played back so you can hear what it was.",
      "Quick answers count for more, but get it right first. Reading starts in C major.",
    ],
    examples: [
      {
        kind: "staff",
        label: "Low C, bottom-line G, F and middle C",
        clef: "bass",
        positions: ["C2", "G2", "F3", "C4"],
      },
      { kind: "staff", label: "F, between the clef dots", clef: "bass", positions: ["F3"] },
      {
        kind: "staff",
        label: "Middle C, one line above the staff",
        clef: "bass",
        positions: ["C4"],
      },
    ],
    links: [{ label: "The staff, clefs and ledger lines (musictheory.net)", url: `${MT}/10` }],
  },
  {
    id: "concept.read.bass.steps",
    nodeIds: ["read.bass.steps"],
    title: "Reading steps",
    body: [
      "A step is the move from one line to the very next space, or from a space to the very next line. On the page the two notes sit side by side, one just above or below the other. Their letter names are neighbours: after F comes G, before F comes E.",
      "Steps let you read from a landmark without counting lines. A note just above the F line is G. A note just below it is E. A note just above the bottom line is A, and just below middle C is B.",
      "Look at where the note sits compared with the landmark, then move one letter.",
    ],
    howTo: [
      "A bass staff appears with one note on it, next to a landmark. There is no sound first.",
      "Name the landmark, move one step, then play the note on your piano. It must be in exactly the right octave.",
      "In Away mode, tap the note on the on-screen keyboard, which shows the bass register.",
      "After you answer, the note is played back.",
    ],
    examples: [
      {
        kind: "staff",
        label: "F, then a step up to G and down to E",
        clef: "bass",
        positions: ["F3", "G3", "E3"],
      },
      {
        kind: "staff",
        label: "Steps from the bottom line: G, A, F",
        clef: "bass",
        positions: ["G2", "A2", "F2"],
      },
      {
        kind: "staff",
        label: "Steps beside middle C: B, C, D",
        clef: "bass",
        positions: ["B3", "C4", "D4"],
      },
    ],
    links: [{ label: "The staff, clefs and ledger lines (musictheory.net)", url: `${MT}/10` }],
  },
  {
    id: "concept.read.bass.skips",
    nodeIds: ["read.bass.skips"],
    title: "Reading skips",
    body: [
      "A skip jumps over one note: line to the next line, or space to the next space. The notes are a third apart, so you skip a letter. From F, a skip up lands on A and a skip down lands on D.",
      "On the staff a skip looks like two notes with one line or space between them. When both are on lines, or both are in spaces, you are looking at a skip.",
      "Once you can read steps and skips from the landmarks, you can place any note in the bass range, from low C up to the E above middle C. Count from the nearest landmark and choose the shorter way.",
    ],
    howTo: [
      "A bass staff appears with one note on it, one or two places from a landmark, or anywhere in the bass range. There is no sound first.",
      "Work out the note, then play it on your piano in exactly the right octave.",
      "In Away mode, tap the note on the on-screen keyboard, which shows the bass register.",
      "After you answer, the note is played back.",
    ],
    examples: [
      {
        kind: "staff",
        label: "Skips from F: A above, D below",
        clef: "bass",
        positions: ["F3", "A3", "D3"],
      },
      {
        kind: "staff",
        label: "Skips from low C: E, then G",
        clef: "bass",
        positions: ["C2", "E2", "G2"],
      },
      {
        kind: "staff",
        label: "Skips around middle C: A, C, E",
        clef: "bass",
        positions: ["A3", "C4", "E4"],
      },
    ],
    links: [{ label: "The staff, clefs and ledger lines (musictheory.net)", url: `${MT}/10` }],
  },
  {
    id: "concept.read.bass.intervals",
    nodeIds: ["read.bass.intervals"],
    title: "Reading by interval",
    body: [
      "Music is usually read as shapes, not one note at a time. Once you know where you are, you read the next note by its distance from the one before: a 2nd is a step, a 3rd is a skip, a 4th and a 5th are one and two further.",
      "Count the lines and spaces from the first note to the second, counting both. Line to the next line is a 3rd. Line to the line two above is a 5th. The direction on the page is the direction on the keys: higher on the staff is further right.",
      "Reading by interval is faster than naming every note, and it is how you read tunes.",
    ],
    howTo: [
      "A bass staff appears with two notes. The first is a landmark. There is no sound first.",
      "Play both notes on your piano, in order, in exactly the right octaves.",
      "In Away mode, tap them on the on-screen keyboard, which shows the bass register.",
      "After you answer, both notes are played back.",
    ],
    examples: [
      {
        kind: "staff",
        label: "F up a 3rd to A",
        clef: "bass",
        positions: ["F3", "A3"],
      },
      {
        kind: "staff",
        label: "F up a 5th to C",
        clef: "bass",
        positions: ["F3", "C4"],
      },
      {
        kind: "staff",
        label: "Low C up a 4th to F",
        clef: "bass",
        positions: ["C2", "F2"],
      },
    ],
    links: [
      { label: "Generic intervals (musictheory.net)", url: `${MT}/30` },
      { label: "The staff, clefs and ledger lines (musictheory.net)", url: `${MT}/10` },
    ],
  },
  {
    id: "concept.read.minor.accidentals",
    nodeIds: ["read.minor.accidentals"],
    title: "Minor accidentals",
    body: [
      "A minor key signature matches the natural minor scale, where 6 and 7 are the lower forms. In A minor there are no sharps or flats, so F and G are plain.",
      "Music in minor often raises 7, and sometimes 6 as well, so that the line pulls up to the home note. The key signature cannot say that, so the composer writes an accidental next to the note: a sharp, or a natural sign if the signature had made it flat.",
      "An accidental lasts for the rest of that bar, on that line or space and in that octave. So the sign tells you which form of the scale to play, and it will not be in the key signature.",
    ],
    howTo: [
      "A bass staff appears in a minor key, with one note on it. There is no sound first.",
      "Check for an accidental in front of the note. If it is there, the note is the raised one.",
      "Play the note on your piano in exactly the right octave.",
      "In Away mode, tap the note on the on-screen keyboard, which shows the bass register.",
      "After you answer, the note is played back.",
    ],
    examples: [
      {
        kind: "staff",
        label: "A natural minor, written with no signature",
        clef: "bass",
        positions: ["A2", "B2", "C3", "D3", "E3", "F3", "G3", "A3"],
      },
      {
        kind: "degrees",
        label: "Natural minor: 7 below home",
        mode: "minor",
        degrees: [6, 7, 8],
        afterCadence: false,
      },
      {
        kind: "degrees",
        label: "Raised 7: pulling up to home",
        mode: "minor",
        minorVariant: "harmonic",
        degrees: [6, 7, 8],
        afterCadence: false,
      },
    ],
    links: [{ label: "The minor scales (musictheory.net)", url: `${MT}/22` }],
  },
  {
    id: "concept.read.rhythm.basic",
    nodeIds: ["read.rhythm.basic"],
    title: "Reading rhythm",
    body: [
      "Written rhythm tells you when to play and how long each note lasts. In 4/4 there are four beats in every bar. A quarter note lasts one beat and an eighth note lasts half a beat, so two eighths fit in one beat and are joined by a beam.",
      "A dot after a note adds half its length. A dotted quarter lasts one and a half beats, the length of a quarter plus an eighth.",
      "A tie joins two notes of the same pitch into one longer sound. You play the first and hold through the second, so a tie means no new note.",
      "Counting 1 2 3 4 and splitting the beat with and keeps you steady.",
    ],
    howTo: [
      "A one-line staff appears with a rhythm of one or two bars, then four clicks count you in. No notes are played.",
      "Play the rhythm on any key of your piano. Only the timing matters, not the pitch.",
      "In Away mode, tap the pad.",
      "Keep the gaps in proportion. A slightly faster or slower tempo is fine.",
    ],
    examples: [
      { kind: "rhythm", label: "Four quarter notes", onsetsBeats: [0, 1, 2, 3] },
      { kind: "rhythm", label: "Quarters and eighths", onsetsBeats: [0, 1, 1.5, 2, 2.5, 3] },
      { kind: "rhythm", label: "Dotted quarter, then eighth", onsetsBeats: [0, 1.5, 2, 3] },
      { kind: "rhythm", label: "A tie holds across the beat: no new note", onsetsBeats: [0, 2] },
    ],
    links: [
      { label: "Note duration (musictheory.net)", url: `${MT}/11` },
      { label: "Dots and ties (musictheory.net)", url: `${MT}/14` },
    ],
  },
  {
    id: "concept.read.treble.landmarks",
    nodeIds: ["read.treble.landmarks"],
    title: "Treble clef landmarks",
    body: [
      "The treble clef writes the higher notes, the ones your right hand usually plays and most tunes are written in. Notes sit on five lines or in the spaces between them, and the higher the note on the staff, the higher it sounds.",
      "As in the bass clef, you learn a few landmarks and count from them. The curl of the treble clef wraps round the second line from the bottom. That line is G, the G above middle C. Middle C hangs below the staff on a ledger line of its own. The C an octave above middle C sits in the third space.",
      "Learn those three well and every other note is a short count away.",
    ],
    howTo: [
      "A treble staff appears with one note on it. There is no sound first.",
      "Find the note on your piano and play it. It must be in exactly the right octave: the same letter in another octave does not count.",
      "In Away mode, tap the note on the on-screen keyboard, which shows the treble register.",
      "After you answer, the note is played back so you can hear what it was.",
      "Quick answers count for more, but get it right first. Reading starts in C major.",
    ],
    examples: [
      {
        kind: "staff",
        label: "Middle C, the clef's G and the C above",
        clef: "treble",
        positions: ["C4", "G4", "C5"],
      },
      {
        kind: "staff",
        label: "G, the line the clef curls round",
        clef: "treble",
        positions: ["G4"],
      },
      {
        kind: "staff",
        label: "Middle C, on a ledger line below the staff",
        clef: "treble",
        positions: ["C4"],
      },
    ],
    links: [{ label: "The staff, clefs and ledger lines (musictheory.net)", url: `${MT}/10` }],
  },
  {
    id: "concept.read.treble.steps",
    nodeIds: ["read.treble.steps"],
    title: "Reading steps on the treble staff",
    body: [
      "A step is the move from one line to the very next space, or from a space to the very next line. On the page the two notes sit side by side, one just above or below the other. Their letter names are neighbours: after G comes A, before G comes F.",
      "Steps let you read from a landmark without counting lines. A note just above the G line is A. A note just below it is F. A note just above middle C is D, and the note just below the high C is B.",
      "Look at where the note sits compared with the landmark, then move one letter.",
    ],
    howTo: [
      "A treble staff appears with one note on it, next to a landmark. There is no sound first.",
      "Name the landmark, move one step, then play the note on your piano. It must be in exactly the right octave.",
      "In Away mode, tap the note on the on-screen keyboard, which shows the treble register.",
      "After you answer, the note is played back.",
    ],
    examples: [
      {
        kind: "staff",
        label: "G, then a step up to A and down to F",
        clef: "treble",
        positions: ["G4", "A4", "F4"],
      },
      {
        kind: "staff",
        label: "Steps up from middle C: C, D, E",
        clef: "treble",
        positions: ["C4", "D4", "E4"],
      },
      {
        kind: "staff",
        label: "Steps around the high C: B, C, D",
        clef: "treble",
        positions: ["B4", "C5", "D5"],
      },
    ],
    links: [{ label: "The staff, clefs and ledger lines (musictheory.net)", url: `${MT}/10` }],
  },
  {
    id: "concept.read.treble.skips",
    nodeIds: ["read.treble.skips"],
    title: "Reading skips on the treble staff",
    body: [
      "A skip jumps over one note: line to the next line, or space to the next space. The notes are a third apart, so you skip a letter. From G, a skip up lands on B and a skip down lands on E.",
      "On the staff a skip looks like two notes with one line or space between them. When both are on lines, or both are in spaces, you are looking at a skip.",
      "Once you can read steps and skips from the landmarks, you can place any note from middle C up to the A above the staff. Count from the nearest landmark and choose the shorter way.",
    ],
    howTo: [
      "A treble staff appears with one note on it, one or two places from a landmark, or anywhere in the treble range. There is no sound first.",
      "Work out the note, then play it on your piano in exactly the right octave.",
      "In Away mode, tap the note on the on-screen keyboard, which shows the treble register.",
      "After you answer, the note is played back.",
    ],
    examples: [
      {
        kind: "staff",
        label: "Skips from G: B above, E below",
        clef: "treble",
        positions: ["G4", "B4", "E4"],
      },
      {
        kind: "staff",
        label: "Skips from middle C: E, then G",
        clef: "treble",
        positions: ["C4", "E4", "G4"],
      },
      {
        kind: "staff",
        label: "Skips around the high C: A, C, E",
        clef: "treble",
        positions: ["A4", "C5", "E5"],
      },
    ],
    links: [{ label: "The staff, clefs and ledger lines (musictheory.net)", url: `${MT}/10` }],
  },
];
