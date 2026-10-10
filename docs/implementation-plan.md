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
| R12 | "Sing, then play" generators (`degreeSing`, `cellEcho`) have two responses but one `AttemptOutcome` | One attempt with sub-scores `{ sing?, play? }`. Rating uses `play` at the instrument, `sing` in Away mode. Sing score is logged for metacognition/metrics |
| R13 | Estimated seconds per item (composer budget) has no data source at first | Derived from `item.presented -> attempt.completed` durations, rolling median per generator. Seed with constants per generator in content |

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

Suggested parallel lanes for agent sessions:

- Lane A (pure TS, no device needed): T1.3, T2.1, T2.2, T2.3, T2.4, T2.5, T2.6, T2.7, T2.8
- Lane B (audio/UI): T1.1, T1.2, T1.4, T1.5, T1.6, T1.7, then T2.9-T2.11
- Lane C (you): T1.1 device runs, T1.8 recordings, S1 review, dogfooding

Lane A can start as soon as T0.1 merges, in parallel with the rest of M0.

---

## 5. Outline: M3-M7

### M3: Reading

- Verovio WASM in a worker, lazy-loaded and precached; MEI generation for single notes, chords and short lines; note ids in SVG for post-attempt highlighting.
- Generators: `bassNoteRead` (octave-exact, register-constrained pitch search per arch risk table), `read.rhythm.basic` (rhythm reading on one pitch; reuse T2.7 rhythm scorer).
- Key-dependent items and family unlocking (R11); key of the day across Ear and Read.
- Concept cards: schema, renderer with `smplr` audio examples, intro delivery (one per session), inline links from feedback templates. `tools/card-drafter` (build-time LLM drafting, committed output, review step).
- Placement (EAR + READ sections, R9).
- Away-mode READ via on-screen keyboard.
- Risk: Verovio bundle size and first-render latency on older iPads. Mitigation: measure in the first PR; fall back to a hand-rolled SVG renderer for single notes if needed.

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
