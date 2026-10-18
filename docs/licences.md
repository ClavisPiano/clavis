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

## ts-fsrs

- Version 5.4.2, MIT licence (https://github.com/open-spaced-repetition/ts-fsrs). FSRS
  scheduling, wrapped by `packages/core/src/scheduler`.

## zod

- MIT licence (https://github.com/colinhacks/zod). Schema validation in `packages/core`.

## Dexie

- Apache-2.0 licence (https://github.com/dexie/Dexie.js). IndexedDB event store in
  `packages/store`.

## pitchy

- Version 4.1.0, MIT licence, Copyright 2018-2021 Ian Johnson
  (https://github.com/ianprime0509/pitchy). McLeod pitch method (MPM) detector with its own FFT
  autocorrelation. Used by `packages/audio` (`src/pitch/analyse.ts`) in the mic worker and in the
  Node fixture runner. No runtime dependencies of its own beyond `fft.js`, which is MIT as well.

## Verovio

- Version 6.3.0, LGPL-3.0-or-later (https://github.com/rism-digital/verovio, npm `verovio`). Music
  notation engraver compiled to WASM. Used by the T3.2 notation spike in `apps/web`
  (`src/lib/notation/verovio.worker.ts`); the keep-or-fallback decision is in
  `docs/spikes/notation.md`.
- Obligations: the LGPL applies to Verovio itself, not to Clavis. We ship the unmodified npm build
  as a separate, replaceable worker chunk (`verovio.worker-*.js`), which is loaded only on the
  notation pages, and the source stays available upstream. Before release, show the licence and
  a link to the Verovio source in the app's About or licences screen. If Verovio is dropped for
  the fallback renderer, this entry can go with it (or stay if M7 imports keep it).

## Piece library (MP, TP.3)

The tunes in `packages/content/src/pieces/library.ts`. Each is typed in by hand as a bare melody
(pitches and note values, one staff). No engraving, edition, arrangement or fingering is copied from
any publication. The tunes themselves are in the public domain: the traditional ones have no known
author and a long history in print, and Beethoven died in 1827. The left-hand versions are the same
melodies an octave lower. The hands-together versions (T5.6) add left-hand block chords (I, IV and V)
written for Clavis, not taken from any arrangement.

| Piece | Source | Status |
|---|---|---|
| Hot Cross Buns | Traditional (English street cry) | Public domain |
| Ode to Joy | Ludwig van Beethoven, Symphony No. 9 (1824), main theme | Public domain (composer died 1827) |
| Mary Had a Little Lamb | Traditional nursery song | Public domain |
| Au clair de la lune | Traditional French song | Public domain |
| Twinkle, Twinkle, Little Star | Traditional French tune ("Ah! vous dirai-je, maman") | Public domain |
| Mary Had a Little Lamb (left hand) | As above, an octave lower | Public domain |
| Ode to Joy (left hand) | As above, an octave lower | Public domain |
| Twinkle, Twinkle, Little Star (left hand) | As above, an octave lower | Public domain |
| Frère Jacques (left hand) | Traditional French round | Public domain |
| Hot Cross Buns (hands together) | The melody above, with left-hand chords written for Clavis | Melody public domain; chords are part of Clavis |
| Ode to Joy (hands together) | The melody above, with left-hand chords written for Clavis | Melody public domain; chords are part of Clavis |
| Mary Had a Little Lamb (hands together) | The melody above, with left-hand chords written for Clavis | Melody public domain; chords are part of Clavis |
| Au clair de la lune (hands together) | The melody above, with left-hand chords written for Clavis | Melody public domain; chords are part of Clavis |
| Twinkle, Twinkle, Little Star (hands together) | The melody above, with left-hand chords written for Clavis | Melody public domain; chords are part of Clavis |

New pieces need a row here before they are added to the library (a test checks every title).

## fflate

- Version 0.8.3, MIT licence (https://github.com/101arrowz/fflate). Pure-JavaScript zip and
  deflate, about 8 KB gzipped, no dependencies. Used by `packages/notation` to unzip `.mxl`
  (compressed MusicXML) files, and in tests to build one.
