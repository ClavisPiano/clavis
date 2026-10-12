# Bass octave accuracy from the mic (T3.12, R20)

R20: bass reading items are graded octave-exact from the microphone only if real piano recordings in
the reading range (C2 to E4) reach at least 95% exact octave. Below that, the fallback applies
(pitch class only, `octaveUnverified`, fluent cap).

## Results

| Take | Piano | Device | Notes | Exact pitch | Octave errors | C2 to B2 octave errors |
|---|---|---|---|---|---|---|
| `dig-singles-bass` | digital | iPhone built-in mic, about 50 cm | 30 | 30 (100%) | 0 | 0 of 13 |

Recorded 2026-10-12 with the self-paced recorder (`/dev/record`), scored by the same pipeline as
the app with the reading input range (C2 to E4). The full report is `fixtures/audio/REPORT.md`.

The recorder mistook the tap on Record for the first note, so the C2 onset in the manifest was
corrected by hand (2.08 s, where it was played), and a repeated C#2 was added; the entry is tagged
`onsets-corrected`. The recorder now ignores the first 500 ms and was retuned on this take.

## Decision

**Octave-exact bass grading from the mic: keep (no R20 fallback), provisionally.** The digital
piano take passes with no octave errors at all. An acoustic piano take (`ac-singles-bass`) is
still to come; if it falls below 95% exact octave, revisit for acoustic pianos only.
