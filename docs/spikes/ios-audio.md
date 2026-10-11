# T1.1 iOS audio spike: findings

Issue #8. Diagnostic page: `/dev/audio` (source in `apps/web/src/routes/dev/audio`). Goal: answer the four questions below on a real iPhone and iPad, with a desktop baseline, then fill in Decisions.

## Questions

1. Playback volume and route when the mic is open.
2. Does echo cancellation (and noise suppression, auto gain) distort a piano tone?
3. Output and input latency ranges.
4. Does an AudioWorklet keep running after the app is backgrounded?

## How to run (every device)

Use the deployed preview or `pnpm --filter @clavis/web dev --host` on the same network, open `/dev/audio` in Safari, portrait. Repeat once as an installed PWA (Add to Home Screen, standalone). Note the iOS version in the report (it is in the user agent).

1. Check the Environment panel. Note any "no" entries.
2. Pick an audio session type (start with `play-and-record`), tap **Unlock audio**, wait for "Samples: ready".
3. Tap **Play C major cadence** and **Play single A4**. Fill the volume note (loudness, speaker or headphones, silent switch state).
4. Set all three mic toggles off, tap **Start mic**, allow access. Read the Applied settings: iOS may ignore requests.
5. With the mic open, replay the cadence and A4. Did the volume drop or the route change (speaker to earpiece)? Note it.
6. Tap **Play cadence with mic open** in a quiet room (speaker, no headphones). Record the silence versus playback peak.
7. Tap **Run latency probe** (speaker, mic near it).
8. Play A4 near the mic and note the raw pitch readout. Stop the mic, turn on `echoCancellation`, start again, and compare the readout and the sound of the A4 through the speaker. Repeat with `noiseSuppression` and `autoGainControl`.
9. Repeat steps 4 to 8 with the other session types (`playback`, `ambient`, `auto`), reloading the page between types.
10. Tap **Start heartbeat**. Background the app (home screen or another app) for 30 s, then 2 min, then lock the screen for 30 s. Return and compare the heartbeat count and event log.
11. Tap **Copy report** and paste it under the run heading below. Add headphone runs as a second report.

## Results

Fill from the reports. Use short entries with numbers.

### Q1. Playback volume and route with the mic open

| Device | Session type | Mic constraints | Volume change when mic opens | Route change | Silence peak vs playback peak |
| --- | --- | --- | --- | --- | --- |
| iPhone | | | | | |
| iPad | | | | | |
| Desktop | | | | | |

### Q2. Echo cancellation effect on the piano tone

| Device | Setting | Applied (from `getSettings()`) | A4 raw pitch stable? | Audible change in playback | Notes |
| --- | --- | --- | --- | --- | --- |
| iPhone | all off | | | | |
| iPhone | echoCancellation on | | | | |
| iPhone | noiseSuppression on | | | | |
| iPhone | autoGainControl on | | | | |
| iPad | all off | | | | |
| iPad | echoCancellation on | | | | |
| Desktop | all off | | | | |
| Desktop | echoCancellation on | | | | |

### Q3. Latency

| Device | Output (headphones) | baseLatency | outputLatency | Probe runs (ms) | Probe median (ms) |
| --- | --- | --- | --- | --- | --- |
| iPhone | speaker | | | | |
| iPhone | wired or Bluetooth | | | | |
| iPad | speaker | | | | |
| Desktop | speaker | | | | |

The probe is rough (one animation frame resolution plus loopback). T1.7 does the real measurement.

### Q4. AudioWorklet after backgrounding

| Device | Background duration | Heartbeats before | After return | Gap logged? | Context state on return | Needed a tap to resume? |
| --- | --- | --- | --- | --- | --- | --- |
| iPhone | 30 s | | | | | |
| iPhone | 2 min | | | | | |
| iPhone | screen lock 30 s | | | | | |
| iPad | 30 s | | | | | |
| Desktop | tab hidden 30 s | | | | | |

## Reports

Paste the output of **Copy report** here, one block per run, under a heading like `#### iPhone 15, iOS 18.x, Safari, play-and-record`.

### iPhone

### iPad

### Desktop baseline

## Decisions

Fill after the runs.

- Default `navigator.audioSession.type` for the app, and when to switch (for example `playback` while only playing, `play-and-record` while the mic is open):
- Default `getUserMedia` constraints (`echoCancellation`, `noiseSuppression`, `autoGainControl`), and whether the app must verify them via `getSettings()` at runtime:
- Headphones requirement or recommendation (when the stimulus bleeds into the mic, or the route changes to the earpiece):
- Latency budget to carry into T1.7 and grading windows:
- AudioWorklet resilience (what to do on return from background: resume, recreate the worklet node, restart the mic):
- Follow-ups for other tasks:
