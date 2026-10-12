# Clavis: Implementation Plan

Status: v0.1
Inputs: `docs/specs/piano-learning-model-spec.md` (v0.3), `docs/specs/piano-trainer-architecture.md` (v0.1)

Scope of this document:

- Section 1 resolves gaps and contradictions in the specs that would otherwise block implementation.
- Sections 2-4 break M0-M2 (the critical path to daily ear training on iPhone) into PR-sized tasks with acceptance criteria.
- Section 5 outlines M3-M7 as epics; each gets a task-level plan when it starts.

Working assumptions:

- Implementation is mostly done by Claude, one PR per task (roughly 200-800 changed lines), each with tests that prove its acceptance criteria.
- Router: SvelteKit with `adapter-static` (SPA fallback, `ssr = false`). Closes arch open question 1.
- The repo is the monorepo root (no `piano-trainer/` wrapper directory).

---

## 1. Spec resolutions

These are proposed decisions. Each is cheap to change now and expensive after M2, because they shape event schemas and item identity.

| # | Issue in specs | Proposed resolution |
|---|---|---|
| R1 | Spec 5.1 says "degrees: one item per degree per key family", but 3.4 says EAR is key-independent with a randomised tonic | EAR item identity excludes key: `itemId = hash(nodeId, {mode, degree})`. Tonic is a **presentation** parameter chosen at runtime. Same for progressions and cells |
| R2 | Refold must be deterministic, but generators use randomness (tonic, register, cell content) | `item.presented` carries the full presentation params (tonic, register, notes, seed). Reducers never call generators; replay never needs to regenerate a stimulus |
| R3 | Away-mode rating cap is keyed by input source, but "singing without piano" uses the mic, same as singing at the piano | Add `mode: "instrument" \| "away"` to `session.started`. The rating cap and mastery-window filter use session mode, not `inputSource`. `inputSource` stays for scoring tolerances. Add `"tap"` to `NoteEvent.source` |
| R4 | `node.transitioned` is stored as an event, but node state is also derived by the fold. After a cross-device refold, stored transitions can contradict derived state | Node states are **derived only**. Replace `node.transitioned` with `node.introduced` (the composer's `available -> learning` decision, which is a real choice, not a derivation). Transitions for milestones/UI are computed by diffing folds |
| R5 | Placement results must seed node states, but there is no event for it | Add `placement.completed { results: Record<nodeId, "mastered" \| "fluent" \| "available"> }`. Reducer treats it as an override floor that ongoing demotion can lower |
| R6 | "distinctSessions with >= 1 day between" and "new items per day" need a day boundary | `session.started` records `tzOffsetMin`. "Day" = learner-local calendar date of the session start. Day rollover at 04:00 local (so late-night practice counts as the same day) |
| R7 | Events carry `userId`, which breaks "anonymous local use, then claim on sign-up" | Client events do not carry `userId`. The server binds events to the user from the auth token at push time. Claiming = first authenticated push. Envelope: `{ id: ULID, deviceId, at, v: schemaVersion, ...payload }` |
| R8 | Snapshots go stale when reducer logic or content changes | Snapshots keyed by `(reducerVersion, contentVersion)`. Mismatch = discard and refold from zero. Event volume makes this cheap |
| R9 | Placement step 3 (LH I-IV-V-I, melody + block chords) needs polyphonic input, which arrives in M5 | Placement ships in M3 with EAR and READ sections only. HANDS section added in M5; until then `hands.*` roots are `available` |
| R10 | `read.minor.accidentals` and `hands.minor.leadingTone` are referenced in 3.4 but absent from the graph tables | Add both. Proposed prereqs: `read.minor.accidentals` <- `read.bass.skips`, `ear.degrees.minor`; `hands.minor.leadingTone` <- `hands.lh.triads.root`, `ear.degrees.minor` |
| R11 | Key-family unlocking rule (for key of the day and per-family mastery) is undefined | A node's family B items become eligible once that node is `mastered` in family A; family C once `fluent` in B. Key of the day rotates around the circle of fifths over keys whose family is unlocked for at least one `learning` node |
| R12 | "Sing, then play" generators (`degreeSing`, `cellEcho`) have two responses but one `AttemptOutcome` | One attempt with sub-scores `{ sing?, play? }`. **Amended in T2.14:** at the instrument the attempt is correct only when both parts are (spec 7: "sung pitch within 50 cents; key correct"), latency comes from the played part, and `partial` is the mean of the sub-scores when either part has partial credit. Away mode rates the single part it has. Errors are tagged with their part (`detail.part`) so feedback can say "you sang" or "you played" |
| R13 | Estimated seconds per item (composer budget) has no data source at first | Derived from `item.presented -> attempt.completed` durations, rolling median per generator. Seed with constants per generator in content |
| R13a | Event versions after the first shipped schemas | **Added in T2.15:** `session.started` and `settings.changed` have v2 (v2 adds optional `practice` and optional `newItemsPerDay`). Both registry entries accept v1 and v2; the upcaster lifts v1 to v2 by setting `v: 2`. New events are written as v2. REDUCER_VERSION is 2 |
| R14 | Spec 3.2 gives a node a single `itemGenerator`, but degree nodes are drilled by both `degreeSing` (sing then play) and `degreeId` (play only, and the Away tap variant) | `SkillNode.itemGenerators: GeneratorId[]`, non-empty, first entry is the default. Item identity (R1) excludes the generator, so all generators for a node share one FSRS card per item |
| R15 | Spec 5.1 says "one item per note per clef position" and spec 3.4 tracks READ mastery per key family, but R1 leaves the key out of item identity and the composer ignores family, so a node mastered in family A never gets B or C items | For key-dependent nodes the item params include the family: `itemId = nodeId\|fam=A\|pos=F3` (`pos` is the staff position, not the sounding pitch). The key is chosen at presentation: the key of the day if it is in the item's family (in the node's mode), else a seeded pick from `keysInFamilies([fam])`, recorded in `presentation.key` (R2). A family is open for a node when: A, the node is `learning` or beyond; B, `byFamily.A` is `mastered`; C, `byFamily.B` is at least `fluent` (R11). New items come from every open family of any key-dependent node at `learning` or beyond, key-of-the-day family first, then A, B, C. **C major first:** until `read.bass.landmarks` is `fluent`, READ items use C major only (A minor for minor items); after that, all of family A. EAR is unchanged (R1) |
| R16 | Spec 13 allows one new concept per session, but the composer only introduces EAR nodes, the EAR fill uses up the new-item cap, and Away sessions are EAR only although spec 6.5 makes READ recognition Away-eligible | Each strand may introduce a node when none of its own enabled nodes is `learning`; still at most one introduction per session. If both strands have a candidate, the strand whose last introduction is older wins (ties: EAR). READ introductions emit `node.introduced` with `keyFamily: "A"`. When READ has new candidates it reserves `floor(allowance / 2)` new items. Away: no Orient; Ear 60% and Read 40% when Read has Away-eligible content, else all Ear |
| R17 | Latency is "stimulus end to first correct response", but reading items have a visual stimulus with no audio end | Reading items play no audio preview. The reference time is when the notation is painted (converted to the AudioContext clock); for `rhythmRead` it is the end of the count-in, which starts after the notation is shown. The reference audio plays only in feedback, as replay (spec 8.5) |
| R18 | Enabling `bassNoteRead` enables five nodes, including intervals and minor accidentals; `bassChordRead` and `sightLine` need polyphonic input and DTW (M5) | In M3 `bassNoteRead` covers landmarks, steps, skips, minor accidentals and an interval variant (two notes, the first on a landmark, the second a 2nd to 5th away, scored as an exact-octave `sequence`). `rhythmRead` ships. Deferred to M5: `bassChordRead`, `sightLine` (grand staff nodes) and the Read block's closing line |
| R19 | Spec 4 says placement results "seed node states" without thresholds | Placement writes only `placement.completed` (no session, item or attempt events). Instrument mode only. EAR: 9 `degreeId` items in C major (1, 3, 5, three each); 8+ correct with median latency within target is `mastered`, 7 is `fluent`, else `available` and the section stops; if 1-3-5 is mastered, 8 diatonic items (2, 4, 6, 7 twice) follow with the same rule (n-1 correct with median latency within target is `mastered`, n-2 is `fluent`: 7 and 6 of 8). READ: 10 `bassNoteRead` items in C major (4 landmarks, 3 steps, 3 skips); all correct within target is `mastered`, 3 of 4 or 2 of 3 is `fluent`, else `available`. Never above a prerequisite; the section stops at the first `available`; results only raise nodes (R5). Placement writes no cards, so the composer treats uncarded items of a node at `fluent` as new items (under the daily cap); in EAR they alternate with learning nodes' new items, learning first. Uncarded items of `mastered` nodes are offered only when the strand has nothing else to introduce |
| R20 | Phone mics often detect C2-B2 piano notes an octave high, and exact-octave bass reading depends on it | If real bass-register fixtures show mic octave accuracy below 95%, mic answers to exact-octave items are graded by pitch class with `detail.octaveUnverified` and can raise a node to `fluent` but never `mastered`. MIDI and the on-screen keyboard stay octave-exact |

---

## 2. Cross-cutting decisions

| Area | Decision | Why |
|---|---|---|
| Package manager / runtime | pnpm workspaces, Node 22 LTS, TS `strict`, ESM only | Matches arch; one toolchain for web, worker and Node-side tests |
| Boundaries | `dependency-cruiser` rules in CI: `core` imports no workspace package; `scoring` imports only `core` types; `audio`/`notation` never import `core` logic | Enforces arch section 3 mechanically, so agent PRs can't erode it |
| Theory helpers | `core/theory` wraps `tonal` (keys, degrees, voicings, register clamping) | Generators and composer both need it; external libs are allowed in `core` |
| Determinism | All randomness via an injected seeded RNG (`pure-rand` or a tiny xoshiro); all "now" via injected clock | Golden tests for composer, reproducible refolds |
| Audio threading | `postMessage` with transferable buffers, **not** `SharedArrayBuffer` | SAB needs COOP/COEP cross-origin isolation, which complicates sample/WASM loading and iOS. Revisit only if profiling demands it |
| Samples | Self-host the `smplr` piano samples (subset of velocity layers, one or two mic positions) as static assets, precached | `smplr` defaults to a remote CDN, which breaks offline use |
| Persistence API | `EventStore` interface in `core/events`; Dexie implementation in `apps/web`; in-memory implementation for tests | Keeps `core` DOM-free while reducers and composer are tested against the real interface |
| Repo conventions | Root `CLAUDE.md`: commands, boundaries, test expectations, event-schema change rules (never edit a shipped schema version; add a new one with an upcaster) | Each PR is implemented by a fresh session; conventions need to live in the repo |
| Licences | Record in `docs/licences.md`. Note Verovio is LGPL-3.0 (fine as a separately loaded WASM module; keep it unmodified or publish changes) | Product-later constraint |

---

## 3. Milestone dependency overview

```
M0 skeleton ──> M1 hear & respond ──> M2 learning core ──> [dogfood gate] ──> M3 reading
                      │                                                   └─> M4 accounts & sync (parallel with M3)
                      └─> S1 polyphonic spike (parallel, de-risks M5)
M3 + M4 ──> M5 hands ──> M6 progress ──> M7 by ear & import
```

Two changes to the arch build plan:

1. **Pull a polyphonic transcription spike (S1) forward into M1/M2.** M5 is the highest technical risk; knowing Basic Pitch accuracy on your instruments and iPad early may change the HANDS design (for example, leaning on MIDI-only for HANDS until a better model lands). It needs the fixture corpus from T1.8 and nothing else.
2. **Dogfood gate after M2:** at least one week of daily sessions on iPhone before starting M3, feeding fixes into a short M2.x tail. The learning loop is the product; reading on top of a broken loop wastes work.

---

## 4. Task breakdown: M0-M2

Notation: **Deps** lists tasks that must merge first. **Accept** lists what the PR's tests or demo must show. Tasks marked **[you]** need you on a real device or instrument.

### M0: Skeleton

Goal: installable empty PWA served from Cloudflare, with the event store and CI in place.

| ID | Task | Deps | Accept |
|---|---|---|---|
| T0.1 | **Monorepo scaffold.** pnpm workspace, `tsconfig.base.json`, ESLint flat config, Prettier, Vitest workspace, empty packages per arch section 3 (`core`, `audio`, `notation`, `scoring`, `content`), `dependency-cruiser` rules, root `CLAUDE.md`, GitHub Actions CI (install, lint, typecheck, test, boundaries) | - | CI green; a deliberate `core -> audio` import fails the boundary check |
| T0.2 | **Web app shell.** `apps/web` SvelteKit + `adapter-static` (fallback `index.html`, `ssr=false`, `prerender` off), routes `/`, `/session`, `/settings`, `/dev`; mobile layout with safe-area insets; minimal design tokens | T0.1 | `pnpm --filter web build` produces a static bundle; deep link to `/settings` works under the SPA fallback |
| T0.3 | **PWA.** `@vite-pwa/sveltekit`: manifest, icons, precache app shell, update-available prompt, `navigator.storage.persist()` on first run, iOS "Add to Home Screen" guidance screen | T0.2 | Lighthouse PWA installable; offline reload of a visited route works (Playwright, Chromium, offline context) |
| T0.4 | **Event envelope and store.** `core/events`: zod schemas for envelope (R7) and initial payloads (`device.registered`, `settings.changed`), ULID, `EventStore` interface, in-memory impl; `apps/web` Dexie impl (events table indexed by `id`, `at`, `synced`; snapshots table). Device id generated once and persisted | T0.1 | Contract test suite runs against both impls; schema rejects malformed events; append is idempotent on `id` |
| T0.5 | **Worker and deploy.** `apps/worker` with Workers static assets serving the web build, `/api/health`, `wrangler.toml`, security headers (CSP allowing WASM, no COOP/COEP per section 2), deploy workflow on `main`, preview deploy per PR if within free tier | T0.2 | `wrangler dev` serves the app; deploy job succeeds. **[you]** create the Cloudflare account/API token and add it as a repo secret |
| T0.6 | **E2E harness.** Playwright with Chromium and WebKit projects in CI; smoke test: app loads, navigates, registers a device event | T0.3, T0.4 | Both browsers green in CI |

Exit: **[you]** install on iPhone/iPad home screen from the deployed URL; app opens offline.

### M1: Hear and respond

Goal: play a stimulus and detect a sung or played single note, reliably, on iOS.

| ID | Task | Deps | Accept |
|---|---|---|---|
| T1.1 | **iOS audio spike [you].** `/dev/audio` page: unlock `AudioContext` on gesture; play via `smplr`; open mic with `echoCancellation`/`noiseSuppression`/`autoGainControl` toggles; set `navigator.audioSession.type` (`play-and-record` vs `playback`); show live level and raw pitch. Write findings to `docs/spikes/ios-audio.md` | T0.6 | Documented answers on: playback volume/route when mic is open, whether echo cancellation distorts piano, output/input latency ranges, AudioWorklet stability after backgrounding |
| T1.2 | **Audio context and stimulus player.** `packages/audio`: single shared context manager (resume, interruption/backgrounding recovery), `StimulusPlayer` over `smplr` with self-hosted samples, API `play(spec: StimulusSpec): { startAt, endAt }` in context time, where `StimulusSpec` is plain data (notes, chords, onsets, velocities) defined in `core` | T1.1 | Unit tests on scheduling maths; `/dev` page plays a scheduled spec; samples precached and playable offline |
| T1.3 | **Theory helpers and cadence generator.** `core/theory`: key/mode model, scale degrees to MIDI in a register, I-IV-V-I (and i-iv-V-i) voicings with smooth voice leading, register clamping for voice ranges (low/high voice settings) | T0.1 | Table tests across all 12 major and minor keys; voicings stay within declared ranges; property test: degree -> pitch -> degree round-trips |
| T1.4 | **Mono pitch pipeline.** AudioWorklet capture -> worker running `pitchy` (MPM): emits `PitchFrame`s; note segmenter emits `NoteEvent`s from energy-rise onsets plus stable-pitch windows; confidence gating. Shared pure DSP code so the same pipeline runs in Node on WAV fixtures | T1.2 | Synthetic tests (generated sine/harmonic tones, onsets at known times) within ±20 cents and ±30 ms; runs in Node via a fixture runner |
| T1.5 | **Input adapter layer and on-screen keyboard.** `InputAdapter` interface (`start/stop`, `NoteEvent`/`PitchFrame` observables), mic adapter wrapping T1.4, tap adapter; Svelte keyboard component (scrollable, 2+ octaves, multi-touch, register follows item) emitting `source: "tap"`. Fake adapter for tests that replays scripted events | T1.4 | Component tests for touch handling; fake adapter drives a test page in Playwright |
| T1.6 | **Stimulus gating and headphones prompt.** Suppress detection during stimulus plus configurable tail; prompt for headphones when mic is active for ear items; remember choice per device | T1.2, T1.5 | Test: scripted stimulus + scripted mic events, events inside the gate are dropped |
| T1.7 | **Latency calibration.** Screen: click track, learner taps (tap path) or mic hears the click (loopback path); compute output and input latency; store per device (local-only setting, not synced) | T1.2, T1.5 | Pure estimator tested with synthetic jitter; **[you]** run on iPhone, iPad, laptop and record values in the spike doc |
| T1.8 | **Fixture corpus and accuracy harness [you].** Record: sung degrees (your voice, plus any volunteers), single notes on acoustic and digital piano across the range, a few short two-hand passages (for S1). Store under `fixtures/audio` via Git LFS with a manifest of ground truth. Vitest job reports pitch/onset accuracy; CI fails on regression below a baseline | T1.4 | Baseline accuracy report committed; regression threshold enforced. Closes arch open question 3 (yes, record early) |
| S1 | **Polyphonic spike (parallel).** Run Basic Pitch (TF.js, Node) over the two-hand fixtures; measure note F1, onset error, and runtime on iPad in a worker. Compare against an ONNX piano transcription model if Basic Pitch is weak. Findings in `docs/spikes/polyphonic.md` with a go/adjust recommendation for M5 | T1.8 | Report with numbers per instrument and device |

Exit: on iPhone, the `/dev` page plays a cadence and target, and correctly detects your sung and played response.

### M2: Learning core

Goal: daily ear-training sessions (Orient + Ear, plus Away mode) on iPhone.

| ID | Task | Deps | Accept |
|---|---|---|---|
| T2.1 | **Content schema and full v1 graph.** `packages/content`: zod schemas for `SkillNode`, `MasteryCriteria`, generator registry ids, per-generator seed durations and target latencies; full v1 graph JSON including R10 nodes. Nodes whose generator is not implemented yet are flagged and treated as locked. Build-time validator: cycles, dangling prereqs, unknown generators, soft vs hard prereq sanity | T0.1 | Validator rejects fixture graphs with each error class; real graph passes |
| T2.2 | **Event payloads for learning.** Add `session.started` (with `mode`, `tzOffsetMin`, key, budget), `item.presented` (with presentation params, R2), `attempt.completed` (outcome, sub-scores, input source), `node.introduced`, `placement.completed`, `session.ended`. Schema versioning and upcaster pattern | T0.4 | Round-trip tests; old-version fixture events upcast correctly |
| T2.3 | **Grading.** `core/grading`: `rate()` per spec 5.2 with Away cap (R3), mastery evaluation per node (accuracy window, median latency, distinct sessions with day gap per R6, instrument-only for `mastered`), demotion rule | T2.2 | Table-driven tests covering every transition, including Away attempts never producing `mastered` |
| T2.4 | **Scheduler.** `core/scheduler`: `ts-fsrs` wrapper with injected clock, retention 0.9, default params; due/overdue ranking (overdue relative to stability); new-item cap per learner-day; card state serialisable for snapshots | T2.2 | Tests: deterministic outputs for fixed review histories; caps respected across day boundaries and time zones |
| T2.5 | **Reducers, snapshots, refold.** `core/events`: fold events to `LearnerState` (cards, node states derived per R4/R5, per-generator duration medians, daily counters, key-of-day history); snapshots per R8; `refoldFrom(event)` | T2.3, T2.4 | Property tests (`fast-check`): any interleaving of two devices' event streams, ordered by `(at, id)`, folds to the same state; replaying duplicates is a no-op; snapshot + tail equals full fold |
| T2.6 | **Item generators (ear).** `core/items`: generator interface `generate(node, ctx, rng) -> ItemInstance { itemId, presentation, stimulus: StimulusSpec, expected, scorerId, targetLatencyMs }`; canonical item ids (R1); implement `degreeSing`, `degreeId`, `cellEcho`, `rhythmEcho`. Enumerate the item universe per node for new-item introduction | T1.3, T2.1 | Tests: ids stable across tonics; stimuli always preceded by a cadence in the presentation key; cells are diatonic and within range |
| T2.7 | **Scoring (single note, sequence, rhythm).** `packages/scoring`: pitch-class and exact-pitch match with latency from stimulus end; sung pitch within 50 cents; edit-distance sequence scoring with partial credit; rhythm echo scoring via IOI comparison normalised to the learner's own tempo (full DTW deferred to M5). Source-dependent tolerances; outputs `AttemptOutcome` plus a structured error list | T1.4, T2.2 | Synthetic event sequences with injected errors (wrong note, octave error, ±ms jitter, missing/extra notes) give expected classifications |
| T2.8 | **Composer (Orient + Ear) and Away mode.** `core/composer`: budget allocation with dropped blocks reallocated (Read/Apply empty until M3/M5), due-then-new fill, max one new concept per session, interleave with no adjacent same-type items, key of the day (EAR bias only for now), Away session (5 min default, eligible generators only, no introductions of HANDS-dependent nodes) | T2.5, T2.6 | Seeded golden tests for representative learner states; invariant property tests (budget, caps, adjacency, Away eligibility) |
| T2.9 | **Session runner.** `apps/web`: state machine (orient -> item loop -> summary), plays stimulus, arms input adapter, collects response with timeout and retry, scores, writes events, picks next item. Summary feedback per spec 8 (at most two issues; fading by node state). Replay of the learner's attempt next to the reference. Resumable if the app is backgrounded mid-session | T1.5, T1.6, T2.7, T2.8 | Playwright (WebKit + Chromium) runs a full session with the fake adapter and asserts the event log; unit tests for the state machine |
| T2.10 | **Home and settings.** Home: start session, start Away session, today's done/not-done, last 7 days. Settings: budget, voice range, headphones, latency recalibration, input mode. Minimal intro card placeholder per node (title + one paragraph from content) until M3 cards | T2.9 | Playwright flows; settings persist as `settings.changed` events |
| T2.11 | **Debug and export.** `/dev/state` view of folded state and due items; export/import of the event log as JSON (safety net until M4 sync) | T2.5 | Export -> wipe -> import reproduces identical state |

Exit (dogfood gate): one week of daily sessions on iPhone with no data loss; median session within ±20% of budget; fix list triaged into M2.x.

#### M2.x tail (dogfood fixes)

| ID | Task | Deps | Accept |
|---|---|---|---|
| T2.12 | **Concept cards and intro delivery** (moved forward from M3 after dogfooding: sessions never explained the key, degrees or what to do). `ConceptCardSchema` in core with degree-based audio examples; hand-written cards for the warm-up and every enabled node, each with a "What you'll do" section; card at node intro, warm-up card in full once then behind "What's this?", "About this skill" on item screens (pauses the session). See `docs/content/cards.md` | T2.10 | Schema and content tests (coverage of enabled nodes, length budget); Playwright for the three delivery points |
| T2.13 | **Inline concept lines in feedback.** Templated one-liners per error pattern (spec 13 delivery point 2) with a link to the card, faded per spec 8 | T2.12 | Table tests from error lists to lines; Playwright: a wrong answer shows the line and the link opens the card |
| T2.14 | **Sung part counts, and feedback names the part.** Dogfood: a wrong sung note before a right played note showed "Correct" with "You found 5". Amend R12 so both parts must be right; tag errors with their part; "You sang" / "You played" | T2.13 | Table tests for combining parts; machine test for a wrong sung part; Playwright shows "Not quite" and "You sang" |
| T2.15 | **Practise more, and a daily new-items setting.** Dogfood: a second session on the same day was almost empty (daily cap of 5 spent, nothing due). Setting "New items per day" (3 to 15, default 5, `settings.changed` v2). Home "Practise more" after the day's session: a `?practice=1` session of already-started items, weakest first by retrievability, due-ness ignored, graded and logged (`session.started` v2 `practice: true`) as mastery evidence but with no FSRS review applied | T2.14 | Schema and upcaster tests; reducer tests (practice leaves cards unchanged, counts toward mastery, refold order independent); composer goldens and properties (no new items, no introductions, every item has a card, budget); Playwright: practise after a full session, settings persist as a v2 event |

Suggested parallel lanes for agent sessions:

- Lane A (pure TS, no device needed): T1.3, T2.1, T2.2, T2.3, T2.4, T2.5, T2.6, T2.7, T2.8
- Lane B (audio/UI): T1.1, T1.2, T1.4, T1.5, T1.6, T1.7, then T2.9-T2.11
- Lane C (you): T1.1 device runs, T1.8 recordings, S1 review, dogfooding

Lane A can start as soon as T0.1 merges, in parallel with the rest of M0.

---

## 5. Outline: M3-M7

### M3: Reading

Goal: full Orient + Ear + Read sessions on iPhone and iPad, bass clef and rhythm reading, placement for EAR and READ, and READ in Away mode. Resolutions R15-R20 apply. Support floor for performance: iPad 9th generation (A13).

Findings that shape the order:

- Setting `bassNoteRead` to implemented enables five READ nodes at once, and each needs a concept card (content test).
- `content/src/index.test.ts` requires the registry to match the graph's `implemented` flags, so generator PRs export without registering and T3.15 flips everything.
- The composer only introduces EAR nodes (R16 fixes this).
- The reducer already tracks per-family state for key-dependent nodes from `presentation.key`.
- The pitch segmenter supports `expectedRange` but nothing passes it, and the Away keyboard is fixed at C3..C6.

Boundaries: `core` stays pure; `notation` imports `@clavis/core` with `import type` only, so core writes everything notation needs (spelling, written accidentals, note ids) as plain data.

| ID | Task | Deps | Accept |
|---|---|---|---|
| T3.1 | **Shared contracts.** `core/score`: `ScoreSpecSchema` (zod) and types `ScoreSpec`, `StaffSpec`, `ScoreNote`, `ScoreRest`, `SpelledPitch { step, alter, octave }`, `Duration` (1, 2, 4, 8, 16; dots; ties). `ScoreNote` has an `id` (`n1`...), `pitches[]` and an optional written `accidental` chosen by core. `ScoreSpec` has `staves` (exactly 1 in M3), `key`, `meter`, `measures`; `StaffSpec` has `clef` (bass, treble, percussion) and `lines` (5 or 1). Helpers `spelledToMidi`, `scoreNoteIds`. `ItemInstance` gains optional `display?: ScoreSpec` and `inputRange?: VoiceRange` (not in events; `presentation` still carries replay params). `core/items/family.ts`: `openFamilies(nodeRecord)` and `keyForFamily(fam, mode, preferredKey, rng, opts)` including the C-major-first rule (R15). `packages/notation`: `NotationRenderer` interface (`preload`, `render(score, { widthPx }) -> { svg, noteIds }`) and a deterministic `StubRenderer`. `apps/web`: `NotationPort` type (`preload`, `show(score)` resolving once painted, `highlight`, `hide`). Golden `ScoreSpec` fixtures (bass note in G major with implied F#, minor raised 7 with written accidental, interval pair, rhythm line with dot and tie). CLAUDE.md says R1-R20 | - | Zod round trip on fixtures; rejects bad durations, more than one staff, duplicate ids. `fast-check`: `spelledToMidi` agrees with `tonal`. Table tests for `openFamilies` (each R11 case) and the C-major-first rule. `pnpm boundaries` green. `StubRenderer` returns every note id. Existing goldens unchanged |
| T3.2 | **Verovio spike and decision [you].** Pin `verovio`. `/dev/notation` renders the T3.1 fixtures through a worker prototype. Measure chunk size (raw, gzip, brotli), cold init from cache, first render, warm render p50/p95 over 50 renders, heap; desktop numbers from CI Playwright. **[you]** run on iPhone and an iPad 9th gen or equivalent. `docs/spikes/notation.md` records the decision: keep Verovio if cold init from cache is at most 1.5 s, warm p95 at most 100 ms on the floor iPad, and brotli at most 5 MB; otherwise build `SvgStaffRenderer` (one staff, notes and simple rhythms) behind the same interface and keep Verovio for M7 imports. LGPL-3.0 note in `docs/licences.md`; confirm the CSP is enough | T3.1 | Spike doc with device numbers and the decision. CI size check fails if the notation chunk grows more than 10% over the baseline |
| T3.3 | **MEI generation.** `packages/notation/src/mei.ts`: pure `toMei(score): string` with `scoreDef` (clef, keysig, meterSig, one-line percussion staff), notes with `pname`, `oct`, written `accid` or gestural `accid.ges`, `dur`, `dots`, ties, and `xml:id` = `ScoreNote.id`; escaped text | T3.1 | Golden MEI per fixture. `fast-check` over generated specs: well-formed XML, each note id once, pitch and octave match, measures fill the meter. If Verovio is kept, a Node test renders each fixture and finds every note id in the SVG |
| T3.4 | **Notation runtime.** Lazy module worker (Verovio or the T3.2 fallback); `createNotationClient()` with promise RPC, idempotent `preload()`, typed load error. `NotationView.svelte`: inline SVG scaled to width, dark mode, highlight by note id via CSS classes. `NotationPort` in `session/runtime.ts` (`show` resolves after two animation frames). Service worker: notation chunk and WASM stay out of the versioned precache and are served cache-first from the asset cache, filled on first fetch and warmed in the background after the first online load | T3.2, T3.3 | Component test with `StubRenderer`: `show` resolves after the SVG is in the DOM; highlight sets classes. Playwright (Chromium, WebKit): `/dev/notation` renders. Chromium: online load, offline reload, still renders. Unit test that the precache list excludes the notation assets |
| T3.5 | **Staff theory helpers.** `core/theory`: `staffPosition`, `positionInKey(pos, key)` (sounding pitch and MIDI with the key signature), `writtenAccidental`, `stepOffset`, `positionsInRange` | T3.1 | Table tests: F3 in G major is F#3 (54); B2 in F major is Bb2; d minor raised 7 is C# with a written sharp; g minor raised 6 is E with a written natural. `fast-check`: offset n then -n round-trips; MIDI order follows staff order in any key |
| T3.6 | **`bassNoteRead`, single-note variants.** Landmarks, steps, skips, minor accidentals per node params (zod). `listItems`: families times positions (R15 ids). `generate`: key from `keyForFamily`, `display` (bass clef, key signature, one whole note), empty stimulus, `expected.play` `exactPitch` with a 6 s window, `inputRange` (C2..E4 or the node range), `presentation { key, pos, midi, clef, fam, seed }`. Exported, not registered | T3.5 | Seeded tests: ids stable across keys within a family and contain `fam`. Property: the generated key's family equals `fam`; MIDI within `inputRange`. Universe size per variant. Display validates and matches fixture shapes |
| T3.7 | **`bassNoteRead` interval variant (R18).** Families times interval (2nd..5th) times direction; first note a landmark, second placed in range; two whole notes; `expected.play` exact-octave `sequence` | T3.6 | Both notes in range for every key in each family; staff-step interval matches; universe 3 x 4 x 2 = 24 |
| T3.8 | **`rhythmRead`.** Notated pattern table (4/4, 1-2 bars, quarter, eighth, dotted quarter, tie), filtered by node params. Onsets from durations (ties add none). `display` on a one-line percussion staff; stimulus is a 4-click count-in at 60-80 bpm only (R17); `expected.play` `rhythm` with any key. Exported, not registered | T3.1 | Durations fill bars exactly; onsets match a hand table; a tie removes one onset; every pattern scores 1.0 against its own onsets |
| T3.9 | **Composer for READ.** Injectable generator registry (`ComposeInput.generators`). Per-family candidates and order (R15), cross-strand introductions and allowance split (R16), key-of-the-day family preference, Away Read block, `introductions` carry `keyFamily`. `preferredKey = plan.key` for EAR and READ | T3.1 | Seeded goldens: READ `learning`; family B opening after A mastered; C-major-first; Away with READ. `fast-check`: no items from closed families, at most one introduction, allowance respected, Away items eligible, no adjacent same type, budget respected |
| T3.10 | **Notation items in the session.** `SessionDeps.notation?: NotationPort`. With `instance.display`: present, `await notation.show`, reference is `shownAt` (R17); a count-in plays after `show` and its end is the reference; empty stimulus skips playback and gate. `ItemView` carries `display` and `inputRange`. Prompts "Play this note", "Play the rhythm", "Find it on the keyboard". Preload in `#prepare` when needed; on failure read items are dropped with a summary note. Pause/resume re-shows and re-references. Feedback highlights notes, names both notes ("You played E2. This note is D2") and replays the target. Session page renders `NotationView` | T3.1 | Machine tests with a fake `NotationPort` with controllable delay: latency from `shownAt`; no playback for empty stimulus; count-in after `show`; preload failure drops read items; pause/resume re-references; event log has `presentation.key` and `block: "read"`. Feedback table tests for `pitch.wrong`, `pitch.octave`, sequence |
| T3.11 | **Away READ on the on-screen keyboard.** `Keyboard` range from `ItemView.inputRange` (fallback 48..84), scrolled to the register without revealing the target; tap adapter; Away rating cap applies | T3.9, T3.10 | Component test: range follows the item, C2 reachable. Machine test: Away read item scored exact-pitch from a tap. Playwright (both browsers): Away session with a seeded READ learner, correct tap passes, octave-above tap gives `pitch.octave` |
| T3.12 | **Exact-octave mic input in the bass register (R20).** `setExpectedRange` on `InputAdapter`, passed through the pitch worker to the segmenter; the machine sets it per item. Octave candidate check for low notes (fundamental energy against 2nd and 3rd harmonics). Bass-range synthetic fixtures. **[you]** record single notes C2..E4 on acoustic and digital piano with `/dev/record`. If real octave accuracy is below 95%, apply the R20 fallback (pitch class, `octaveUnverified`, fluent cap) | T3.1 | Synthetic tests with a weak fundamental choose the right octave for C2..B2. Accuracy harness reports bass octave error with a CI baseline. Machine test: range set per item and cleared |
| T3.13 | **Placement core (R19).** `core/placement`: `placementPlan(graph, rng)`, `nextPlacementStep(progress)`, `placementResults(attempts, graph)` with prerequisite capping. Pure | T3.6 | Table tests at every threshold edge; never above a prerequisite; early stop; seeded golden plan |
| T3.14 | **READ concept cards and tips.** Cards for `read.bass.landmarks`, `read.bass.steps`, `read.bass.skips`, `read.bass.intervals`, `read.minor.accidentals`, `read.rhythm.basic` per `docs/content/cards.md`, including the Away difference and the octave rule. `CardExampleSchema` gains a `staff` kind rendered by `NotationView` and playable. Tips for `pitch.octave` and reading `pitch.wrong` | T3.1 (staff UI: T3.4) | Content tests (schema, length, prose, coverage); tip table tests; Playwright: a READ intro card shows a staff example |
| T3.15 | **Enable reading.** Register `bassNoteRead` and `rhythmRead`; set `implemented: true`; bump `contentVersion`; update `graph/NOTES.md` | T3.4, T3.6-T3.11, T3.14 | `pnpm check` green (registry and card coverage tests). Playwright (both browsers): full instrument session with Orient, Ear and Read from a seeded learner; Away session with READ; offline reload inside a session; snapshot discard on the content version change |
| T3.16 | **Placement flow.** `/placement`, offered on first run (skippable) and re-runnable from settings; EAR then READ, reusing item views with a `"placement"` machine mode (no intro cards, minimal feedback, no learning events); results summary; one `placement.completed` | T3.13, T3.15 | Machine tests: exactly one event, early stop. Playwright: first run, placement, placed states in `/dev/state`; re-running never lowers a node |
| T3.17 | **Device validation [you].** iPhone and iPad as installed PWAs: placement, a week of daily sessions with Read, airplane mode after one online launch, Away READ. Issues go to an M3.x tail | T3.12, T3.16 | Exit criterion below |

Merge order and lanes:

1. T3.1 merges first; it is the only contract the lanes share. Later changes to these types get their own small contracts PR.
2. In parallel: Lane A (core) T3.5, T3.6, T3.7, T3.13, with T3.8 and T3.9 alongside; Lane B (notation) T3.2 and T3.3, then T3.4; Lane C (web) T3.10 against `StubRenderer`, then T3.11; Lane D (audio) T3.12; Lane E (content) T3.14 text, with its staff examples after T3.4.
3. Integration: T3.15, then T3.16, then T3.17.

Exit: on iPhone and an iPad 9th gen or newer, installed, with airplane mode on after one online launch: placement places EAR and READ nodes; daily sessions show Orient, Ear and Read with notation within the T3.2 thresholds; bass-note items are graded octave-exact through the mic or by the R20 fallback; Away sessions include READ; one week of daily sessions with no data loss, median session within ±20% of budget, and at least one READ node past `learning`.

### M4: Accounts and sync (parallel with M3)

- Passkeys via `@simplewebauthn`; credentials in D1; HMAC-signed session cookie; recovery codes; add-second-passkey flow.
- Per-user Durable Object (SQLite): `INSERT OR IGNORE` push, `serverSeq` pull with pagination; Miniflare tests for concurrent and duplicate pushes.
- Client sync loop (session end, foreground, periodic) with refold-on-merge (T2.5 already proves correctness).
- Anonymous-to-account claim per R7.
- R2 upload endpoint for recordings, keyed `userId/...`, with a local size cap.
- Risk: DO free-tier write limits under batch pushes. Mitigation: batch per request, measure in staging.

### M5: Hands

- Web MIDI adapter (Chromium/Android/desktop).
- Transcription worker (Basic Pitch or the S1 winner), post-take only; take length cap.
- DTW alignment with local-tempo model; per-note classification (correct, wrong pitch, missed, extra, early, late, short); tolerances by source.
- Generators: `lhPattern`, `coordTask`; task-level scheduling (spec 5.4) and micro-drill spawning into FSRS.
- Apply block in the composer; placement HANDS section.
- Risk: polyphonic mic accuracy. S1 results decide whether mic-based HANDS ships in v1 or HANDS is MIDI-first.

### M6: Progress

- Skill map (graph view with node states), consistency calendar, weekly target, fluency trends, capability milestones (from fold diffs, R4).
- Monthly benchmark recordings with side-by-side replay (R2 storage).
- Practice cue push notifications (Web Push from the Worker; iOS requires home-screen install).
- Self-assessment flow (spec 8.4) and calibration metric.

### M7: By ear and import

- EAR progression nodes and generators (`bassMotion`, `chordQuality`, `progressionId`), minor and colour progressions.
- `byEarPhrase` staged loop (spec 9) with stage gating.
- Import: MusicXML/MXL (primary), MIDI, ABC (via Verovio conversion), audio with loop regions; phrase splitting and difficulty estimate; private R2 storage.
- `ear.real.phrase` content sourcing (public domain first).

---

## 6. Open items for you

1. Approve or amend resolutions R1-R13 (section 1). R1-R4 and R7 affect event schemas and should be settled before T2.2.
2. Cloudflare account and API token for T0.5.
3. Recording session for the fixture corpus (T1.8): roughly 30-45 minutes across voice, acoustic and digital piano.
4. Attempt replay retention (arch open question 2): proposal is last 50 attempts locally, benchmarks only in R2, revisit in M6.
5. Whether to file section 4's tasks as GitHub issues (one per task, with deps and acceptance criteria) so each agent session can pick one up.
