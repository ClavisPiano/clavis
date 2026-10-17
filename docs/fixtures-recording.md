# Recording the audio fixture corpus (T1.8)

A 30 to 45 minute session that produces the ground-truth audio for the pitch accuracy harness and the S1 polyphonic spike. Single notes and melodies tune the mic pitch pipeline (M1). Voice takes are no longer needed (R29): nothing is graded as sung. The two-hand takes decide whether mic-based HANDS ships in v1 (S1).

## Before you start

- Equipment: iPhone or iPad (built-in mic) is the primary device. A laptop mic is a nice second device if it is handy. Quiet room, phone about 50 cm from the piano or from your mouth, mic pointing at the sound source. Same position for the whole instrument.
- Check the piano is in tune enough: the harness grades equal temperament, so a badly flat upright costs you accuracy that is not the software's fault. Note it in `tags` if so.
- Keep the corpus small. Git LFS on the free GitHub plan has about 1 GB per month of storage and bandwidth, and every CI run downloads the whole corpus. At 22.05 kHz mono 16-bit, one minute is 2.6 MB, so the full session below is roughly 30 to 40 MB. Do not record more than this, and do not commit stereo or 44.1 kHz copies.

## Fastest path: the in-app recorder

1. Run the app (`pnpm --filter @clavis/web dev`, or the deployed preview) on the phone or iPad and open `/dev/record`.
2. Choose the instrument, type the device name (for example `iPhone 15 built-in mic`), pick a take and press Record.
   - Single-note takes (`singles-bass`, `singles-soft`, `singles-loud`) are self-paced and have no clicks. The screen shows one note; play it when ready and let it ring. The page hears the attack, ticks, and shows the next note about 2 seconds later. Skip note leaves a note out. Ground-truth onsets come from the attacks it heard, so timing cannot drift.
   - Timed takes (melodies, two-hand) keep a tempo: 4 count-in clicks, then exactly one click per note (none between notes). Play the note shown on its click; a bar fills towards the next note.
3. The page runs the app's pitch pipeline on the take and shows how many notes it heard, exact pitch and octave errors, note by note. Listen back, then Share (iOS) or Download. You get `<id>.wav` and `<id>.json` (a ready manifest entry).
4. Repeat for every take in the list below. The page records mono at 22.05 kHz, so no conversion is needed.

## Fallback: Voice Memos

1. Settings, Voice Memos, Audio Quality: Lossless. Use any metronome app. Start Voice Memos, then start the metronome, and play the take with a 4 beat count-in at the tempo in the list.
2. Share the memo to your computer (AirDrop). Convert and trim so that file time 0 is the first click (`SS` is the time of the first click in seconds, from any audio editor):

   ```sh
   ffmpeg -i memo.m4a -ss SS -ac 1 -ar 22050 -sample_fmt s16 out.wav
   ```

3. Write the manifest entry by hand from the template below. Onsets are `(4 + beat) * 60000 / bpm` milliseconds, where `beat` is the note's beat in the list (0 is the first note after the count-in). If you played freely instead of to a click, annotate onsets in an audio editor.

## Take list

Each instrument gets the takes that apply to it. Ids are `voice-…`, `ac-…` (acoustic piano) and `dig-…` (digital piano). Tempo is in beats per minute and the count-in is always 4 beats.

| Take (id suffix) | Instrument | What to play | Tempo |
| --- | --- | --- | --- |
| ~~`sung-c-low`, `sung-c-high`~~ | voice | **No longer needed (R29).** Was: the cadence I IV V I in C, then "ah" on 1 5 3 7 2 6 4 of C major | 60 |
| ~~`sung-g-low`, `sung-g-high`~~ | voice | **No longer needed (R29).** Was: the same in G major | 60 |
| `singles-bass` | both pianos | Every semitone from C2 to E4 (29 notes), medium loudness, self-paced: one note at a time, each left to ring. This is the bass reading range and decides R20 (octave-exact bass grading from the mic); the page scores it on the device | own pace |
| `singles-soft`, `singles-loud` | both pianos | A0, C1, D#1, F#1, A1 and on, every minor third up to C8 (30 notes), self-paced. Once soft, once loud | own pace |
| `melody-ode` | both pianos | E4 E4 F4 G4 G4 F4 E4 D4 C4 C4 D4 E4 E4(1.5) D4(0.5) D4(2), quarter notes unless shown | 80 |
| `melody-twinkle` | both pianos | C4 C4 G4 G4 A4 A4 G4(2) F4 F4 E4 E4 D4 D4 C4(2) | 80 |
| `melody-arpeggio` | both pianos | C3 E3 G3 C4 E4 G4 C5 E5 G5 C6, one note per beat | 60 |
| `two-hand-c` | both pianos | One bar each, 4 beats per bar. Left hand chord on beat 1, right hand notes on beats 1 and 3: C3-E3-G3 with E4, G4; F3-A3-C4 with F4, A4; G3-B3-D4 with D4, B4; C3-E3-G3 with C4, C5 | 60 |
| `two-hand-g` | both pianos | The same passage transposed up a fifth (G major) | 60 |

The 4 voice takes (`sung-*`) are no longer needed (R29). That leaves 8 takes on each piano, and for the digital piano `dig-singles-bass` and `dig-melody-ode` are already recorded, so the list still to record is 6 takes: `singles-soft`, `singles-loud`, `melody-twinkle`, `melody-arpeggio`, `two-hand-c` and `two-hand-g`. Allow about 2 minutes for each 30 note take and 1 minute for the rest, plus setup and retakes, so 30 to 45 minutes in all. If you also record a laptop mic, repeat only the `singles-soft` and `two-hand-c` takes and use the id suffix `laptop` (the recorder has a field for it).

Why these: single notes across A0 to C8 expose octave errors and the weak low fundamentals. The melodies exercise onset detection with repeated notes and fast restrikes. The two-hand takes are the S1 test set, so play them cleanly and at a steady tempo.

## Manifest entry template

Entries live in `fixtures/audio/manifest.json` (an array). The recorder's `.json` snippet is exactly this shape.

```json
{
  "id": "ac-melody-twinkle",
  "file": "piano-sequence/ac-melody-twinkle.wav",
  "kind": "piano-sequence",
  "instrument": "acoustic-piano",
  "device": "iPhone 15 built-in mic",
  "sampleRate": 22050,
  "notes": [
    { "midi": 60, "onsetMs": 4000, "offsetMs": 4675 },
    { "midi": 60, "onsetMs": 4750, "offsetMs": 5425 }
  ],
  "expectedRange": { "low": 55, "high": 72 },
  "tags": ["upright"]
}
```

`kind` is one of `sung-degree`, `piano-single`, `piano-sequence`, `two-hand`. `instrument` is `voice`, `acoustic-piano` or `digital-piano`. `onsetMs` and `offsetMs` are milliseconds from the first sample. `expectedRange` is optional; set it where the app would know the register (sung degrees, melodies) and leave it out for `piano-single` so octave errors show up. The schema is `packages/audio/src/fixtures/manifest.ts` and the full take scripts are `packages/audio/src/fixtures/takes.ts`.

## Adding the files and committing

```sh
git lfs install            # once per clone
mkdir -p fixtures/audio/sung-degree fixtures/audio/piano-single fixtures/audio/piano-sequence fixtures/audio/two-hand
# copy each <id>.wav into the folder named by its kind, and append each snippet to fixtures/audio/manifest.json
pnpm --filter @clavis/audio accuracy:update   # rewrites baseline.json and REPORT.md, prints the report
git add fixtures/audio
git lfs ls-files           # confirm the new .wav files are listed (stored as LFS objects)
git commit -m "T1.8: record fixture corpus"
```

Read `fixtures/audio/REPORT.md` before committing: it is the first real accuracy report. Low numbers are findings, not failures; `accuracy:update` accepts them as the new baseline. From then on `pnpm check` fails if any entry, kind or the overall F1 drops by more than 0.02, or the median onset error worsens by more than 10 ms. Rerun `accuracy:update` deliberately when an algorithm change is meant to move the numbers.

The synthetic seed fixtures (`synthetic-*` entries, generated by `pnpm --filter @clavis/audio fixtures:synthetic`) can stay as a sanity check or be deleted along with their manifest entries once real takes exist.

A clone without LFS files makes the accuracy test skip with a message instead of failing. CI checks out with `lfs: true`.
