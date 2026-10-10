# Piano Trainer: Technical Architecture and v1 Build Plan

Status: draft v0.1
Companion to: `piano-learning-model-spec.md` (v0.3)

---

## 1. Constraints

| Constraint | Consequence |
|---|---|
| Primary devices are iPhone/iPad | No Web MIDI in Safari. Mic input must be first-class from day one |
| PWA, works offline | Local-first data; everything needed for a session is cached by the service worker |
| Cross-device sync, free to run | Cloudflare free tier only: Workers, Durable Objects (SQLite), R2 |
| Possible product later | Multi-user from the start (accounts, per-user data isolation), but no paid services |
| Learning model is the priority | The learning core is a pure TS package with no DOM or audio dependencies, fully unit-testable |

---

## 2. Stack choices

### 2.1 UI: Svelte 5 + Vite (static SPA)

Chosen over React and Solid because:

- Small runtime and bundles matter on phones, and for a PWA that caches everything.
- Svelte 5 runes give fine-grained reactivity without a separate state library.
- The performance-critical code (audio capture, pitch tracking, alignment) runs in an AudioWorklet and Web Workers, so the framework only renders UI. Framework choice is low-risk and swappable.

No SvelteKit SSR. Plain Vite SPA with a client router (or SvelteKit with `adapter-static` if file-based routing is wanted). Served as static assets from Cloudflare Workers.

### 2.2 Libraries

| Concern | Library | Notes |
|---|---|---|
| Spaced repetition | `ts-fsrs` | Reference TS implementation of FSRS, includes parameter optimiser support |
| Music theory | `tonal` | Scales, chords, intervals, Roman numerals, key signatures. Used by item generators |
| Notation rendering | Verovio (WASM) | Renders MusicXML, MEI, ABC, Humdrum to SVG; also converts between them. Lazy-loaded, cached by service worker |
| Piano playback | `smplr` (sampled piano) | Sampled acoustic piano over Web Audio. Used for stimuli, cadences, reference replay |
| MIDI input | Web MIDI API (+ `webmidi` wrapper) | Chromium/Android/desktop only |
| MIDI files | `@tonejs/midi` | Parse imported .mid to note events |
| Mono pitch | `pitchy` (McLeod Pitch Method) in an AudioWorklet | Singing, and single piano notes |
| Polyphonic transcription | `@spotify/basic-pitch` (TF.js) in a Web Worker | Run on recorded takes, not live. Later candidate: ONNX piano model via `onnxruntime-web` |
| Local storage | Dexie (IndexedDB) | Event log, snapshots, content cache |
| PWA | `vite-plugin-pwa` (Workbox) | Precache app shell, Verovio WASM, piano samples, content |
| Auth | Passkeys via `@simplewebauthn/server` + `@simplewebauthn/browser` | No email provider needed, free |
| Validation | `zod` | Event schemas shared client/server |
| Tests | Vitest, `fast-check` for property tests, Playwright for E2E |

Library versions to be pinned at scaffold time.

---

## 3. Repository layout

pnpm monorepo:

```
piano-trainer/
  apps/
    web/                 # Svelte 5 PWA
    worker/              # Cloudflare Worker: API, auth, sync DO, static assets
  packages/
    core/                # Learning model. Pure TS, no DOM, no audio
      graph/             # skill graph types + loader
      items/             # item generators (degreeSing, bassNoteRead, ...)
      grading/           # AttemptOutcome -> rating, mastery evaluation
      scheduler/         # ts-fsrs wrapper, task priority
      composer/          # session composer, Away mode
      events/            # event types (zod), reducers, snapshotting
    audio/               # input adapters, worklets, pitch, transcription worker
    notation/            # Verovio wrapper, score model, MusicXML/MIDI/ABC import
    scoring/             # alignment (DTW), note matching, rhythm scoring
    content/             # skill graph data (JSON), concept cards, benchmark pieces
  tools/
    card-drafter/        # build-time LLM drafting of concept cards
```

Dependency rule: `core` depends on nothing in the repo. `scoring` depends only on shared types. `apps/web` wires everything together. This keeps the learning model testable in isolation and reusable by the Worker if server-side recomputation is ever needed.

---

## 4. Runtime architecture (client)

```
              +--------------------------- Main thread (Svelte UI) ---------------------------+
              |  Session runner  <->  core (composer, grading, scheduler)  <->  Event store  |
              |        |                                                         (Dexie)      |
              |        v                                                            |         |
              |  Stimulus player (smplr)    Notation view (Verovio SVG)             | sync    |
              +--------|-----------------------------------------------------------|---------+
                       |                                                           v
   Input adapters ---> NoteEvent / PitchFrame stream                          Sync client
     - Web MIDI                                                                    |
     - Mic: AudioWorklet -> ring buffer -> Pitch worker (pitchy)                   v
     - Mic: recorded take -> Transcription worker (Basic Pitch)              Cloudflare Worker
     - On-screen keyboard (Away mode)
```

### 4.1 Input layer

All inputs normalise to the interfaces in spec section 11 (`NoteEvent`, `PitchFrame`).

- **Web MIDI adapter**: direct `NoteEvent`s, `confidence: 1`.
- **Mono pitch adapter**: AudioWorklet captures frames, posts to a worker running MPM. Emits `PitchFrame`s for singing, and `NoteEvent`s for single-note piano items (onset from energy rise, pitch from stable frames).
- **Transcription adapter**: records a take (MediaRecorder or worklet PCM), runs Basic Pitch in a worker after the take ends, emits `NoteEvent[]`. Fits the summary-feedback policy, since feedback is post-attempt anyway.
- **On-screen keyboard**: emits `NoteEvent`s tagged `source: "tap"` (extend the union).

Key point for iOS: most early items (degree ID, sing-back, bass note reading, single-note cells) need only the mono adapter, which is reliable. Polyphonic transcription is only needed for HANDS and BYEAR tasks, which unlock later.

### 4.2 Audio and iOS specifics

- One shared `AudioContext`, resumed on first user gesture.
- Request mic once per session; keep the stream alive across items to avoid repeated permission/latency.
- Latency calibration screen: play a click, learner taps along (or the mic hears the click) to measure output/input latency. Store per device; subtract from onset timing in rhythm scoring.
- Use headphones prompt for ear items when mic is active, to avoid the stimulus being detected as the response. Fallback: mute detection while the stimulus plays plus a short tail.
- Call `navigator.storage.persist()`; installed home-screen PWAs are much less likely to have storage evicted. Sync is the real safeguard.
- Push notifications (practice cue) need the app installed to the home screen on iOS.

### 4.3 Notation

- Verovio WASM loaded in a worker on first READ item, cached by the service worker.
- Item generators produce **MEI** (Verovio's native format, easy to generate) for drills; imports arrive as MusicXML/ABC and are converted to the internal score model, with Verovio rendering the original.
- Rendered SVG elements carry note IDs, so post-attempt feedback can highlight specific notes (after the attempt, per the feedback policy).

### 4.4 Scoring

`packages/scoring`:

- **Single-note items**: pitch class or exact pitch match, latency from stimulus end.
- **Sequence items** (cells, bass roots): edit-distance alignment of expected vs played pitch sequences; partial credit = 1 - normalised distance.
- **Timed items** (rhythm, lhPattern, sightLine, coordTask): DTW over (onset, pitch) with a local-tempo model. Output per-note classification: correct, wrong pitch, missed, extra, early, late, short. Tolerances depend on `source` (wider for mic).
- Output feeds `AttemptOutcome` plus a structured error list used for summary feedback and micro-drill generation.

---

## 5. Data and sync

### 5.1 Local model

- **Event log** (append-only) is the source of truth: the `LearningEvent` union from spec section 10, plus `device.registered`, `content.imported`, `settings.changed`.
- Every event has a client-generated ULID `id`, `userId`, `deviceId`, and `at` (device clock).
- **Derived state** (FSRS cards, node states, task priorities, progress stats) is a fold over the event log via pure reducers in `core/events`. Snapshots stored every N events for fast startup.
- Content (skill graph, cards) is static and versioned; events reference content by stable IDs.

### 5.2 Sync protocol

Event-sourcing makes sync simple: there are no conflicting writes, only events to merge.

- Server stores events in a **per-user Durable Object** with SQLite storage. One DO per user gives natural isolation and serialised writes. Available on the free plan.
- **Push**: client sends unsynced events (batched). DO inserts with `INSERT OR IGNORE` on `id` (idempotent), assigns a monotonically increasing `serverSeq`.
- **Pull**: client sends its last `serverSeq`; DO returns newer events.
- **Merge**: after pulling events from another device, the client re-folds from the last snapshot before the earliest new event, ordering by `(at, id)`. FSRS is order-sensitive, so deterministic ordering plus refold keeps all devices consistent. Event volume is small (thousands per year), so refolds are cheap.
- Clock skew: `at` is device time; the server records `receivedAt`. Acceptable for this domain; a session's events come from one device anyway.
- Sync triggers: session end, app foreground, and periodic when online. Offline sessions sync later.

### 5.3 Binary data

- Recordings (benchmarks, optional attempt replay) and imported files go to **R2**, keyed by `userId/…`, uploaded via the Worker with auth. Local copies kept in IndexedDB with a size cap.
- Events reference blobs by key.

### 5.4 Free-tier fit

Durable Objects on the free plan: 100,000 requests/day, 100,000 rows written/day, 5 GB stored. A daily session generates perhaps 100-300 events and a handful of sync requests, so a single user uses a tiny fraction; even hundreds of users fit if pushes are batched. R2 free tier covers recordings for personal and early product use.

---

## 6. Auth

- **Passkeys (WebAuthn)** as the only login method. Free, no email service, good UX on iOS (Face ID / Touch ID, synced via iCloud Keychain).
- Worker endpoints: register options/verify, login options/verify. Credentials stored in a small **D1** table (or a global "accounts" DO) mapping credential ID to `userId`.
- Session: short-lived signed token (JWT or HMAC cookie) issued by the Worker; the token's `userId` routes to the user's DO.
- Recovery: one-time recovery codes shown at registration; adding a second passkey from another device is encouraged in onboarding.
- Anonymous local use is allowed before sign-up; on sign-up, the local event log is assigned the new `userId` and pushed.

---

## 7. Content pipeline

- Skill graph and node definitions: JSON in `packages/content`, validated by zod schemas at build time (cycle detection, missing prereqs, unknown generators).
- Concept cards: `tools/card-drafter` drafts cards with an LLM from node definitions and a style guide; output written as Markdown/JSON files committed to the repo, then reviewed. Audio examples are structured data (key + chords/notes) rendered at runtime by `smplr`.
- Feedback templates: keyed by error pattern (e.g. `degree.confusion.6-5`, `chord.confusion.IV-ii`, `rhythm.late.lh`), with slots filled from the error list.
- Benchmark pieces: MusicXML in the repo, tagged by level.

---

## 8. Testing strategy

| Layer | Approach |
|---|---|
| core reducers | Property tests: refold of any permutation of a device's events gives the same state as ordered fold; idempotent replay |
| composer | Seeded RNG, golden tests for given learner states and budgets; invariants (budget respected, no adjacent same-type items, caps honoured) |
| grading/mastery | Table-driven tests on outcome sequences |
| scoring | Synthetic `NoteEvent` sequences with injected errors (wrong note, ±ms jitter, missing notes) and expected classifications |
| audio | Fixture recordings (sung degrees, single piano notes, short passages on acoustic and digital piano) run through the workers in Node; track accuracy over time as a regression metric |
| sync | Worker tests with Miniflare: concurrent pushes, duplicate pushes, pull pagination |
| E2E | Playwright on WebKit and Chromium: a session run with a fake input adapter |

---

## 9. v1 build plan

Milestones are ordered to get a usable daily practice loop on iPhone/iPad as early as possible.

| # | Milestone | Scope | Usable outcome |
|---|---|---|---|
| M0 | Skeleton | Monorepo, Svelte PWA shell, service worker, Dexie event store, Worker serving static assets, CI deploy to Cloudflare | Installable empty app |
| M1 | Hear and respond | `smplr` playback, cadence generator, mono pitch worker, on-screen keyboard, latency calibration | Can play a stimulus and detect a sung or played single note |
| M2 | Learning core | Graph loader, items for `degreeSing`, `degreeId`, `cellEcho`, `ear.rhythm.echo`; grading; ts-fsrs scheduler; composer (Orient + Ear); Away mode | **Daily ear-training sessions on iPhone** |
| M3 | Reading | Verovio worker, `bassNoteRead`, `read.rhythm.basic`, key-of-the-day coherence; concept card display; placement | **Bass clef practice added; full Orient/Ear/Read session** |
| M4 | Accounts and sync | Passkeys, per-user DO, push/pull, refold-on-merge, R2 uploads | Same progress on phone, iPad and laptop |
| M5 | Hands | Web MIDI adapter, Basic Pitch transcription worker, DTW scoring, `lhPattern`, `coordTask`, Apply block, micro-drill spawning | Hands-together practice with post-attempt feedback |
| M6 | Progress | Skill map, consistency calendar, weekly target, fluency trends, milestones, benchmark recordings, practice cue notifications | Visible progress |
| M7 | By ear and import | Progression items, `byEarPhrase` staged loop, MusicXML/MIDI/ABC import, audio loop regions | Play-by-ear capstone on generated and imported material |

Rough sequencing: M0-M2 is the critical path to daily use. M3 and M4 can overlap. M5 is the highest technical risk (polyphonic mic accuracy) and is deliberately after the learning loop is proven.

---

## 10. Risks

| Risk | Mitigation |
|---|---|
| Mic detects stimulus playback as response | Headphones prompt; gate detection during stimulus + tail; echo cancellation constraints on `getUserMedia` (tested per device, since it can also distort piano tone) |
| Mono pitch octave errors on piano | Pitch-class scoring where octave doesn't matter; for octave-exact reading items, constrain search to the expected register and use spectral peak voting |
| Basic Pitch accuracy/speed on older iPads | Run post-take in a worker; cap take length; score-informed matching tolerant of extra/missing low-confidence notes; ONNX model as fallback |
| iOS storage eviction | Persist request, home-screen install prompt, sync |
| FSRS defaults poorly suited to motor/aural skills | Log everything; run the optimiser once enough reviews exist; adjust latency targets per node from data |
| Verovio WASM size | Lazy-load on first READ item; precache after first load |

---

## 11. Open questions

1. Router: plain Vite SPA with a small router, or SvelteKit with `adapter-static`?
2. Attempt replay retention: how many raw recordings to keep locally and in R2?
3. Fixture recordings: record a test corpus on your own acoustic and digital piano early (M1), so audio accuracy is measured on real instruments from the start?
