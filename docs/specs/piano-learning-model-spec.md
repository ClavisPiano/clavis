# Piano Trainer: Learning Model Spec

Status: draft v0.3 (decisions in section 16; remaining open questions in section 17)
Scope: the learning model (skill graph, scheduling, session composition, exercise catalogue, feedback policy). Audio and MIDI input are covered only as an interface.

---

## 1. Goals

1. Get the learner to **play by ear**: hear a short piece of pop, folk, classical or film music and make a credible attempt at melody plus harmony.
2. Build **bass clef and hands-together reading** fluency as a supporting skill.
3. Make every session effective in **10-15 minutes per day**.
4. Be product-ready: learner-agnostic model, with placement rather than hardcoded assumptions.

Non-goals for v1: advanced technique (scales at speed, pedalling), repertoire library, teacher dashboards.

---

## 2. Pedagogical principles

Each principle maps to a concrete mechanism.

| Principle | Mechanism |
|---|---|
| Retrieval practice beats re-exposure | Every exercise requires a produced response (play, sing, name). No passive "watch and listen" items. |
| Spaced repetition | Discrete items scheduled with FSRS (section 5). |
| Interleaving | Session mixes strands; ear items within a block mix degrees/progressions rather than blocking one type. |
| Fluency, not just accuracy | Mastery requires response latency under a threshold, not only correctness. |
| Context-dependent hearing | Ear work always happens inside an established key (cadence first). Functional, not isolated intervals. |
| Sing before play | Audiation step: learner sings the target before finding it on the keyboard. |
| Guidance hypothesis | Summary feedback after an attempt, never note-by-note red marks during play. Feedback frequency fades with mastery. |
| Error-driven deliberate practice | Mistakes in longer tasks spawn targeted micro-drills (bar loops, specific degrees). |
| Cross-strand reinforcement | Reading items use the same chords/progressions as ear items in the same key of the day. |

---

## 3. Skill graph

### 3.1 Strands

- **EAR**: scale degrees, bass motion, chord quality, progressions, real-music transcription.
- **READ**: bass clef note recognition, chord shapes on staff, hands-together sight-reading.
- **HANDS**: LH accompaniment patterns, RH melody, coordination.
- **BYEAR**: capstone tasks combining all three.

Rhythm is **not** a separate strand. It is a scoring dimension on every played item (timing measured against local tempo) and appears as a small number of nodes inside EAR and READ (`ear.rhythm.echo`, `read.rhythm.basic`).

### 3.2 Node schema

```ts
type Strand = "EAR" | "READ" | "HANDS" | "BYEAR";

interface SkillNode {
  id: string;                    // "ear.degrees.major.135"
  strand: Strand;
  title: string;
  prerequisites: string[];       // node ids; all must be "mastered" (or "fluent" for soft prereqs)
  softPrerequisites?: string[];  // must be at least "learning"
  itemGenerator: string;         // key into exercise catalogue (section 7)
  params: Record<string, unknown>; // e.g. { mode: "major", degrees: [1,3,5] }
  mastery: MasteryCriteria;
  keyDependent: boolean;         // if true, mastery tracked per key family (see 3.4)
}

interface MasteryCriteria {
  minAccuracy: number;           // e.g. 0.9 over the window
  maxMedianLatencyMs?: number;   // e.g. 1500 for degree ID
  windowAttempts: number;        // e.g. 20
  distinctSessions: number;      // e.g. 2, with >= 1 day between
}

type NodeState = "locked" | "available" | "learning" | "fluent" | "mastered";
```

State transitions:

- `locked -> available`: all prerequisites mastered.
- `available -> learning`: first introduced by the composer.
- `learning -> fluent`: accuracy criterion met.
- `fluent -> mastered`: accuracy and latency met across `distinctSessions`.
- `mastered -> fluent` (demotion): rolling accuracy over the last window drops below `minAccuracy - 0.1`.

### 3.3 Initial graph (v1)

**EAR**

| id | Content | Prereqs |
|---|---|---|
| ear.degrees.major.135 | Sing/play degrees 1, 3, 5 after cadence | none |
| ear.rhythm.echo | Hear a 1-2 bar rhythm, tap or play it back | none |
| ear.degrees.major.diatonic | All 7 degrees, single notes | ear.degrees.major.135 |
| ear.cells.major.2-4 | 2-4 note melodic cells | ear.degrees.major.diatonic |
| ear.bass.I-IV-V-vi | Identify bass root motion | ear.degrees.major.diatonic |
| ear.quality.triad | Major vs minor (then dim) triads in context | ear.bass.I-IV-V-vi |
| ear.prog.core | I-V-vi-IV, I-IV-V, ii-V-I, vi-IV-I-V | ear.quality.triad |
| ear.cadence | Perfect, plagal, imperfect, deceptive | ear.prog.core |
| ear.degrees.minor | Natural/harmonic minor degrees | ear.cells.major.2-4 |
| ear.prog.minor | i-iv-v, i-VI-III-VII, Andalusian | ear.degrees.minor, ear.prog.core |
| ear.prog.colour | V/V, borrowed iv, bVII | ear.prog.minor |
| ear.real.phrase | Short phrases from real recordings | ear.prog.core, ear.cells.major.2-4 |

**READ**

| id | Content | Prereqs |
|---|---|---|
| read.bass.landmarks | Bass landmarks: low C, F (clef line), middle C, low G | none |
| read.rhythm.basic | Read and play quarter, eighth, dotted and tied rhythms on one pitch | none |
| read.bass.steps | Notes a step from landmarks | read.bass.landmarks |
| read.bass.skips | Notes a 3rd from landmarks, then full range | read.bass.steps |
| read.bass.intervals | Read by interval from previous note | read.bass.steps |
| read.bass.chords | Root-position and inverted triads on bass staff | read.bass.skips, hands.lh.triads.root |
| read.grand.2line | Simple two-staff lines, key of the day | read.bass.intervals |
| read.grand.sight | Short sight-reading passages, graded | read.grand.2line, hands.coord.basic |

**HANDS**

| id | Content | Prereqs |
|---|---|---|
| hands.lh.triads.root | Root-position I, IV, V, vi in key | none (placement likely skips) |
| hands.lh.inversions | Close voice leading between chords | hands.lh.triads.root |
| hands.lh.broken | Broken chords, Alberti | hands.lh.inversions |
| hands.lh.pop | Pop rhythm patterns (root-5-8, syncopated) | hands.lh.broken |
| hands.coord.basic | RH melody + LH block chords | hands.lh.triads.root |
| hands.coord.moving | RH melody + LH broken/pop pattern | hands.coord.basic, hands.lh.broken |

**BYEAR**

| id | Content | Prereqs |
|---|---|---|
| byear.melody.simple | Play a heard 4-8 bar diatonic melody | ear.cells.major.2-4 |
| byear.harmonise | Add LH chords to a known/heard melody | byear.melody.simple, ear.prog.core, hands.coord.basic |
| byear.full.phrase | Melody + harmony from a real recording | byear.harmonise, ear.real.phrase |

### 3.4 Key dependence

**EAR nodes are key-independent.** Functional hearing should transfer across keys, so ear items randomise the tonic (within a comfortable register) and are scheduled once regardless of key. The learner learns the sound of "degree 6 in major", not "A in C". The cadence before each item establishes the key. Exception: on days with a key of the day, the composer biases ear items toward that tonic for coherence, without tracking mastery per key.

**READ and HANDS nodes are key-dependent**, grouped into families by key signature complexity. Minor keys share a family with their relative major, because the signature (and therefore the reading task) is the same:

| Family | Major | Relative minor |
|---|---|---|
| A (0-1 accidentals) | C, G, F | a, e, d |
| B (2-3 accidentals) | D, Bb, A, Eb | b, g, f#, c |
| C (4+ accidentals) | E, Ab, B, Db, F#/Gb | c#, f, g#, bb, d#/eb |

- The raised 7th of harmonic minor (and raised 6th/7th of melodic minor) is not covered by the signature, so it gets its own nodes: `read.minor.accidentals` and `hands.minor.leadingTone`.
- A key-dependent node is "mastered" globally when mastered in family A and fluent in at least one key of family B. Family C feeds review only.
- Minor-key tonic is treated as its own home (degree 1 with b3), not as degree 6 of the relative major. This matches Roman-numeral analysis (i-iv-v) and how pop, film and classical minor music is heard.

---

## 4. Placement

Product requirement: no assumed level. A 5-minute placement runs on first launch:

1. Cadence + degree ID (3 items each for 1/3/5, then diatonic).
2. Bass clef recognition (10 timed items across landmarks, steps, skips).
3. Play I-IV-V-I in C with LH, then simple melody + block chords.

Results seed node states (`mastered`, `fluent` or `available`). Placement can be re-run from settings. Ongoing demotion (3.2) corrects any over-placement.

---

## 5. Items and scheduling

### 5.1 Items

An **item** is the unit FSRS schedules. Items are generated from a node plus parameters.

```ts
interface Item {
  id: string;                 // stable hash of nodeId + canonical params
  nodeId: string;
  params: Record<string, unknown>; // e.g. { key: "G", degree: 6 } or { note: "A2" }
  fsrs: FsrsCard;             // stability, difficulty, due, lapses, etc.
}
```

Granularity guidelines:

- Reading: one item per note (or chord shape) per clef position. Small, many items.
- Degrees: one item per degree per key family.
- Progressions: one item per progression per key family.
- HANDS and BYEAR: one item per pattern or task template; these are scheduled more loosely (see 5.4).

### 5.2 Grading

Each attempt produces an outcome which maps to an FSRS rating.

```ts
interface AttemptOutcome {
  correct: boolean;
  latencyMs: number;          // stimulus end to first correct response
  retries: number;            // within-attempt corrections
  partial?: number;           // 0..1 for multi-note tasks
}

function rate(o: AttemptOutcome, target: number): Rating {
  if (!o.correct || (o.partial ?? 1) < 0.6) return "again";
  if (o.retries > 0 || o.latencyMs > target * 1.5) return "hard";
  if (o.latencyMs <= target * 0.6) return "easy";
  return "good";
}
```

Input mode adjusts the rating:

- **Instrument** (MIDI or mic note events, or singing at the piano): rating as computed.
- **Away** (on-screen tap, note-name buttons, singing without piano): rating capped at `good`. Away attempts update FSRS and count toward `fluent`, but the `mastered` window is computed from instrument attempts only. Recognition can be trained anywhere; production must be proven at the keyboard.

`target` latency is per node (e.g. 1500 ms for single-note degree ID, 3000 ms for progression ID, 1200 ms for bass note naming).

### 5.3 Scheduler

- FSRS with default parameters initially; optimise per learner once they have ~1000 reviews.
- Target retention: 0.9.
- Daily review cap per strand to stay inside the time budget (composer enforces).
- New items introduced per day: capped (default 5 across all strands), and only from nodes in `learning` state.

### 5.4 Task-level scheduling (HANDS, BYEAR)

Longer tasks don't fit card-style scheduling well. These use a simpler rule:

- Each task template has a `lastPracticed` and a rolling score.
- Priority = days since last practiced x (1 - rolling score).
- Errors inside a task spawn **micro-drill items** (e.g. "degree 6 in G", "bar 3 LH transition IV to V") which do go into FSRS, tagged with the source task.

---

## 6. Session composer

### 6.1 Budget

User-configurable daily duration; default 12 minutes. The composer works in estimated seconds per item (tracked per learner, per item type, rolling median).

### 6.2 Block structure

| Block | Share of budget | Content |
|---|---|---|
| Orient | ~10% | Scale + I-IV-V-I cadence in key of the day. Unscored warm-up but logged. |
| Ear | ~30% | Due EAR items, then new EAR items. Interleaved by type. |
| Read | ~25% | Due READ items, then new. Last 30-60 s is a short line in key of the day once `read.grand.2line` is available. |
| Apply | ~35% | One HANDS or BYEAR task, chosen by task priority (5.4). Micro-drills from the previous session first if any are due. |

If the learner has time pressure (e.g. chooses "5 minute session"), drop Apply first, then trim Read.

### 6.3 Key of the day

- Rotates around the circle of fifths within unlocked key families.
- Due items from other keys are still allowed, but the composer prefers items in the key of the day when a choice exists (cross-strand coherence).
- Orient cadence always uses key of the day; Ear items in another key get their own cadence first.

### 6.4 Selection algorithm (sketch)

```ts
function composeSession(budgetSec: number, state: LearnerState): Session {
  const key = nextKeyOfDay(state);
  const blocks = allocate(budgetSec, BLOCK_SHARES);
  return {
    key,
    orient: orientBlock(key),
    ear: fill(blocks.ear, dueItems(state, "EAR", key), newItems(state, "EAR", key)),
    read: fill(blocks.read, dueItems(state, "READ", key), newItems(state, "READ", key)),
    apply: pickTask(blocks.apply, state, key),
  };
}

// fill: overdue first (most overdue relative to stability), then due,
// then new up to cap, then interleave so no two adjacent items share a type.
```

### 6.5 Away mode

A shorter session (default 5 minutes) for when the learner has a phone but no piano.

- Eligible items: EAR (sung responses and tap responses), READ recognition (find the note on an on-screen keyboard, not note-name buttons, so the skill is locating rather than naming), progression ID, theory concept review (section 13).
- Excluded: HANDS, BYEAR, sight-reading lines, anything requiring coordinated playing.
- Headphones recommended for ear work; singing uses the phone mic.
- Away sessions never introduce new HANDS-dependent nodes and never promote a node to `mastered` (see 5.2).
- Away sessions do count toward consistency tracking (section 14).

---

## 7. Exercise catalogue

Each `itemGenerator` produces stimulus, expected response and scoring.

| Generator | Stimulus | Response | Input | Scoring |
|---|---|---|---|---|
| degreeSing | Cadence + target note | Sing, then play | Mic (mono pitch), keys | Sung pitch within 50 cents of degree; key correct |
| degreeId | Cadence + note | Play the note | Keys | Correct pitch class; latency |
| cellEcho | Cadence + 2-4 note cell | Sing back, then play | Mic, keys | Per-note pitch; partial credit |
| bassMotion | Progression audio | Play the bass roots | Keys | Root sequence match |
| chordQuality | Chord in context | Choose major/minor/dim, or play it | Tap or keys | Correct quality |
| progressionId | 4-chord progression | Choose or play Roman numerals | Tap or keys | Per-chord partial credit |
| bassNoteRead | Note on bass staff | Play it | Keys | Correct pitch (octave-exact); latency |
| bassChordRead | Chord on bass staff | Play it | Keys | All chord tones present |
| sightLine | Short grand-staff line | Play it | Keys | Alignment-based (notes + rhythm) |
| lhPattern | Progression + pattern spec | Play LH pattern | Keys | Notes + timing vs metronome |
| coordTask | Lead sheet (melody + chord symbols) | Play hands together | Keys | Alignment-based |
| byEarPhrase | Audio phrase | Sing, then play melody, then add roots/chords | Mic, keys | Staged: melody score, root score, chord score |

Notes:

- "Keys" means the `NoteEvent` stream from either MIDI or mic transcription. Scoring tolerances widen when the source is mic.
- Singing uses monophonic pitch tracking (YIN/pYIN). Reliable on any device mic; this is the ear-training input most robust on iOS.
- Tap responses (on-screen keyboard or buttons) are used in Away mode only (6.5). At the instrument, responses are always played or sung.
- Every played generator scores rhythm as well as pitch: onset deviation relative to local tempo, plus duration for held notes. Summary feedback reports whichever dimension is weaker.

---

## 8. Feedback policy

1. **No concurrent per-note error marking** during an attempt. Optional metronome and score highlight only.
2. **Summary feedback after attempt**: overall result, then at most two specific issues ("bar 3: LH late on the IV chord", "degree 6 heard as 5").
3. **Fading**: show detailed summary feedback on every attempt while a node is `learning`; every second attempt when `fluent`; only on errors when `mastered`.
4. **Knowledge of results vs performance**: early, show what was wrong; later, ask the learner to self-assess first ("Was that right?"), then reveal. Self-assessment accuracy is logged as a metacognition signal.
5. **Replay**: the learner can hear their attempt next to the reference. Particularly important for by-ear tasks.

---

## 9. By-ear capstone loop

The core loop for `byear.*` tasks:

1. **Listen** to the phrase (max 3 plays before step 2; unlimited after).
2. **Sing** the melody. Scored loosely; purpose is audiation.
3. **Find the tonic**: play the note that feels like home. Scored.
4. **Melody**: play the melody. Scored by alignment, pitch first, rhythm second.
5. **Bass**: play the roots under each bar. Scored.
6. **Harmonise**: play melody with LH chords. Scored.
7. **Compare**: side-by-side replay; summary feedback; micro-drills generated from errors.

Each stage unlocks only after a minimum score on the previous one, so a failed tonic doesn't cascade into a meaningless harmony score. The learner can bail out at any stage; partial completion still schedules the task sooner.

Content sources for v1: generated melodies over generated progressions (synthesised), then public-domain folk and classical, then licensed or user-supplied audio for `ear.real.phrase`.

---

## 10. Data model and events

Event-sourced so the scheduler and analytics can be recomputed.

```ts
type LearningEvent =
  | { type: "session.started"; sessionId: string; key: string; budgetSec: number; at: number }
  | { type: "item.presented"; sessionId: string; itemId: string; at: number }
  | { type: "attempt.completed"; sessionId: string; itemId: string; outcome: AttemptOutcome; inputSource: "midi" | "mic" | "tap"; at: number }
  | { type: "task.completed"; sessionId: string; taskId: string; stageScores: Record<string, number>; spawnedItems: string[]; at: number }
  | { type: "node.transitioned"; nodeId: string; from: NodeState; to: NodeState; at: number }
  | { type: "session.ended"; sessionId: string; at: number };
```

- Stored locally (IndexedDB) for offline PWA use; synced when online.
- Raw performance (`NoteEvent[]`) stored per attempt for replay and later re-scoring, with a retention limit.

---

## 11. Input interface (boundary only)

```ts
interface NoteEvent {
  pitch: number;          // MIDI note number
  onsetMs: number;
  offsetMs?: number;
  velocity?: number;      // 0-127, MIDI only or estimated
  confidence: number;     // 1.0 for MIDI, model confidence for mic
  source: "midi" | "mic";
}

interface PitchFrame {    // for singing
  hz: number | null;
  cents?: number;
  confidence: number;
  atMs: number;
}
```

Adapters: Web MIDI (Chromium/Android/desktop), mic transcription (all platforms), mic monophonic pitch (singing). A native shell with CoreMIDI can provide MIDI on iOS later without changing the learning model.

---

## 12. Metrics

- Retention: FSRS predicted vs observed recall.
- Fluency: median latency trend per node.
- Transfer: by-ear task stage scores over time (the headline metric).
- Engagement: sessions per week, completion rate of the Apply block.
- Feedback calibration: self-assessment accuracy.

---

## 13. Theory content

Theory is delivered as short **concept cards** attached to nodes, never as a separate course.

```ts
interface ConceptCard {
  id: string;                 // "concept.vi-chord"
  nodeIds: string[];          // nodes this explains
  title: string;              // "The vi chord: the relative minor"
  body: string;               // <= ~120 words, plain language
  audioExamples: string[];    // generated: played on the in-app piano voice
  tryIt?: string;             // one-item exercise id to do immediately
  links: { label: string; url: string }[]; // further reading
}
```

Two delivery points:

1. **Intro**: when a node first enters `learning`, its card is shown before the first item (target under 60 seconds including audio). It counts against the session budget, so the composer introduces at most one new concept per session.
2. **Inline with feedback**: when summary feedback identifies an error pattern linked to a node (e.g. confusing IV and ii), the feedback includes a one-line explanation and a link to the card.

Cards are reviewable from the skill map and in Away mode. External links point to open resources (e.g. Open Music Theory, musictheory.net) rather than duplicating them.

---

## 14. Progress and commitment

No points, badges, leaderboards or streak counters that reset to zero. The aim is to make progress visible and practice easy to start.

- **Consistency calendar**: days practised, shaded by minutes. Missed days are neutral, not "broken".
- **Weekly target**: learner sets days per week (default 5). Progress shown against that, which tolerates missed days.
- **Skill map**: the graph from section 3 with node states, so the learner sees what is opening up next.
- **Fluency trends**: median latency and accuracy per strand over time.
- **Capability milestones**: plain statements when a meaningful node is mastered, e.g. "You can now hear and play I-V-vi-IV in any key" or "You can read the bass clef from low C to middle C".
- **Monthly benchmark**: the learner picks a benchmark piece from 3-4 options appropriate to their current level, and records it once a month. Side-by-side replay of past recordings is the most concrete evidence of progress.
- **Practice cue**: learner picks a time and an existing habit to attach practice to (implementation intention). Delivered as a PWA push notification (supported on iOS when installed to the home screen).

---

## 15. User content import

Imported pieces become task templates for `coordTask`, `sightLine` and `byEarPhrase`. Error micro-drills (5.4) apply to them like any other task.

| Format | Use | Notes |
|---|---|---|
| MusicXML (.musicxml, .mxl) | Primary. Reading, hands-together tasks, scored by alignment | Full notation, spelling, key, metre. Exported by MuseScore, Sibelius, Dorico, Finale |
| MIDI (.mid) | By-ear targets, alignment reference | No note spelling or reliable notation; key and quantisation inferred. Rendered as simplified notation only on request |
| Audio (.mp3, .m4a) | By-ear only | Learner marks loop regions. No automatic correctness unless a reference is supplied; optional chord/key estimation as a hint |
| ABC (.abc) | Nice-to-have, for folk tunes | Large public-domain and traditional corpus; converts cleanly to MusicXML |

Import pipeline: parse, normalise to an internal score model (notes, voices, chord symbols, key, metre), split into phrases (by rests/barlines, learner-adjustable), estimate difficulty, attach to relevant nodes (e.g. a piece in D major using I-IV-V links to family B HANDS nodes).

Licensing: v1 is personal use; user-uploaded content stays private to the uploader. Bundled content is generated or public domain. Licensed content is out of scope until there is a product decision.

---

## 16. Decisions log

| # | Question | Decision |
|---|---|---|
| 1 | Tap responses | On-screen responses only in Away mode. Away attempts count toward fluency, not mastery |
| 2 | Key families | EAR key-independent with randomised tonic; READ/HANDS by signature family, minor with relative major, extra nodes for minor accidentals |
| 3 | Rhythm | Cross-cutting scoring dimension plus a few rhythm nodes; not a strand |
| 4 | Theory | Concept cards: intro when a node starts, inline with related feedback, external links |
| 5 | Gamification | None. Consistency calendar, weekly target, skill map, milestones, monthly benchmark |
| 6 | Content | User import (MusicXML, MIDI, audio, ABC); licensing deferred |
| 7 | Away-mode mastery | Mastery computed from instrument attempts only |
| 8 | Away-mode reading input | On-screen keyboard |
| 9 | Benchmark piece | Learner chooses from 3-4 level-appropriate options |
| 10 | Concept card authoring | LLM-drafted at build time, stored as static content, reviewed before release. Audio examples generated from structured data; inline feedback lines templated per error pattern |

---

## 17. Open questions

1. Concept card review process (personal cross-check vs teacher review before wider use). Deferred.
