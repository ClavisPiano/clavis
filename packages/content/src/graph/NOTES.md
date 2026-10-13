# v1 graph content notes

JSON cannot carry comments, so the rationale for `v1.json` lives here.

- **Counts.** 12 EAR, 12 READ, 7 HANDS, 3 BYEAR. READ and HANDS each include one R10 node (`read.minor.accidentals`, `hands.minor.leadingTone`). Three of the READ nodes are the treble nodes added in TP.2.
- **Bass landmarks.** Spec: "low C, F (clef line), middle C, low G". Chosen pitches: C2 (low C), F3 (the F line of the bass clef), C4 (middle C), G2 (low G). Scientific pitch notation, middle C = C4.
- **`read.bass.skips` full range.** `fullRange: ["C2", "E4"]` covers the bass staff plus two ledger lines above.
- **Key dependence.** EAR and BYEAR false. READ and HANDS true, except `read.rhythm.basic` (rhythm only, single pitch) which is false.
- **Mastery defaults.** `minAccuracy 0.9`, `windowAttempts 20`, `distinctSessions 2`, `maxMedianLatencyMs` equal to the node `targetLatencyMs`.
- **Rhythm nodes.** `ear.rhythm.echo` and `read.rhythm.basic` have no latency criterion: they are scored on onset deviation, not response speed. Reading uses a window of 15.
- **HANDS and BYEAR.** Whole tasks are slow (spec 5.4), so `windowAttempts 5`, `minAccuracy 0.8` (4 of 5; 0.9 over 5 would demand a perfect run), no latency.
- **Alignment-scored reading and `ear.real.phrase`.** Window of 10, no latency. `read.grand.2line` 0.85, `read.grand.sight` and `ear.real.phrase` 0.8, because whole-line scoring is harsher than single-note scoring.
- **Target latencies (ms).** Single degrees 1500 (spec), bass landmarks/steps 1200 (spec, bass note naming), bass skips/intervals/minor accidentals 1500, bass chords 2500, triad quality 2000, cells 3000, bass motion 4000 (several roots), progressions and cadences 3000 (spec).
- **Generators.** Degree nodes list `degreeSing` first, then `degreeId`. Implemented: the four ear generators (T2.6) and `bassNoteRead` and `rhythmRead` (T3.15, `contentVersion` 2026.10.2). Everything else is `implemented: false` until its milestone (`bassChordRead`, `sightLine` in M5).
- **Away eligibility (spec 6.5).** True for EAR generators, `bassNoteRead` (locate on an on-screen keyboard) and `concept`. False for `rhythmRead`, `bassChordRead`, `sightLine`, `lhPattern`, `coordTask`, `byEarPhrase`.
- **Seed durations (seconds per item).** degreeSing 8, degreeId 6, cellEcho 12, rhythmEcho 12, rhythmRead 12, bassMotion 15, chordQuality 8, progressionId 15, bassNoteRead 5, bassChordRead 8, sightLine 60, lhPattern 90, coordTask 90, byEarPhrase 180, concept 30.
- **`ear.cadence`.** Reuses `progressionId` with a `cadences` param (two-chord endings) rather than a separate generator.
- **`contentVersion`** must change whenever graph semantics change.
- **Reading enabled (T3.15).** `bassNoteRead` enables `read.bass.landmarks`, `read.bass.steps`, `read.bass.skips`, `read.bass.intervals` and `read.minor.accidentals` (R18); `rhythmRead` enables `read.rhythm.basic`. `read.bass.chords`, `read.grand.2line` and `read.grand.sight` stay disabled. Flipping the flags changes graph semantics, so `contentVersion` moved from 2026.10.1 to 2026.10.2 and stored snapshots are discarded and refolded (R8).
- **Treble reading enabled (TP.2).** `trebleNoteRead` enables `read.treble.landmarks` (C4, G4, C5: middle C, the G the clef curls round, the C above), `read.treble.steps` and `read.treble.skips` (the whole range C4 to A5, one ledger line below the staff to one above). They mirror the bass nodes: key dependent, the same mastery and latency targets, the same generator rules (R15, R17). The generator is the bass one with a different staff (`makeNoteRead`). The nodes sit after the other READ nodes in the file, so the composer still introduces bass landmarks and rhythm before treble landmarks (it breaks ties by file order); move them earlier to change that. Treble has no interval or minor accidental nodes yet and is not part of placement. `contentVersion` moved to 2026.10.5.
