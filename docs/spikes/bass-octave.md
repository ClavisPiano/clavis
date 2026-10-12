# Bass octave accuracy from the mic (T3.12, R20)

R20: bass reading items are graded octave-exact from the microphone only if real piano recordings in
the reading range (C2 to E4) reach at least 95% exact octave. Below that, the fallback applies
(pitch class only, `octaveUnverified`, fluent cap).

## Results

| Take | Piano | Device | Notes | Exact pitch | Octave errors | C2 to B2 octave errors |
|---|---|---|---|---|---|---|
| `dig-singles-bass` | digital | iPhone built-in mic, about 50 cm | 30 | 30 (100%) | 0 | 0 of 13 (12 distinct notes plus the repeated C#2) |

Recorded 2026-10-12 with the self-paced recorder (`/dev/record`), scored by the same pipeline as
the app with the reading input range (C2 to E4). The full report is `fixtures/audio/REPORT.md`.

The recorder mistook the tap on Record for the first note, so the C2 onset in the manifest was
corrected by hand (2.08 s, where it was played), and a repeated C#2 was added; the entry is tagged
`onsets-corrected`. The recorder now ignores the first 500 ms and was retuned on this take.

## Caveats

- Sample size: 13 low notes. A single octave error would put C2 to B2 at about 92%, below the 95%
  bar, so the margin is one note.
- The onset detector was retuned on this take. That does not bias the R20 number: scoring uses the
  hand-corrected truth onsets, and pitch and octave come from the app pipeline, not the recorder.
- One piano and one phone. Acoustic pianos, with stronger low partials and room sound, are untested.

## Decision

**Octave-exact bass grading from the mic: keep (no R20 fallback).** Decided on the digital piano
evidence; the owner has no acoustic piano, so no acoustic take is planned. Revisit if acoustic
users report bass notes graded an octave off; the fallback (pitch class, `octaveUnverified`,
fluent cap) remains the remedy.
