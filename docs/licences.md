# Third-party licences

## Piano samples

- Set: Splendid Grand Piano, a Steinway grand recorded by Akai with four velocity layers.
- Licence: public domain. Released into the public domain by Akai in early 2000, per the
  SFZ Instruments distribution (https://github.com/sfzinstruments/SplendidGrandPiano, README:
  "Public Domain samples by AKAI"). No attribution is legally required. We credit Akai and the
  SFZ Instruments project (kinwie, who cleaned and mapped the set) as a courtesy.
- What we ship: 48 AAC (`.m4a`) files, 5.1 MB, in `apps/web/static/samples/piano/`. They are
  the PP, MP and MF layers (velocity 41-100) at 16 notes from B0 to C6. `smplr` pitch-shifts
  the nearest sample for the notes in between.
- How: the files are the pre-converted m4a versions that `smplr` hosts at
  https://smpldsnds.github.io/sfzinstruments-splendid-grand-piano/samples, fetched by
  `apps/web/scripts/fetch-samples.mjs` (re-runnable; it also writes `manifest.json`).

## smplr

- Version 1.1.0, MIT licence (https://github.com/danigb/smplr). Sampled instruments over Web
  Audio. Used by `packages/audio`.

## tonal

- `@tonaljs/key` and `@tonaljs/note` (used by `packages/core`), part of the `tonal` project
  (https://github.com/tonaljs/tonal), MIT licence.
