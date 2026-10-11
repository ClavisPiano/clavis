# Concept cards

Concept cards carry the theory (spec 13). They live in `packages/content/src/cards/v1.ts`, are validated by `ConceptCardSchema` (`packages/core/src/cards/schema.ts`), and are written by hand for now. `tools/card-drafter` (LLM drafting at build time, reviewed before commit) is deferred until there are enough cards to justify it.

## Rules

- Every node with an implemented generator has a card. `packages/content/src/cards.test.ts` fails otherwise, so a new generator ships with its card.
- `body` explains the idea in plain language: what it is, what it sounds like, why it matters. At most 150 words.
- `howTo` says exactly what happens in an item and what the learner does: what they hear, whether they sing, play or tap, what counts as right (octave, tolerance, order), and how Away mode differs. At most 90 words.
- Examples are scale degrees, not pitches, so they play in the key of the day. Use `mode` to force major or minor (the parallel key is used). Prefer examples that match what the items play: after the cadence, in the same register.
- Links go to open resources (musictheory.net lessons, Open Music Theory). Check that each URL resolves.
- Prose: no em dashes, plain double quotes, British spelling to match the app.

## Delivery

- Intro: the card replaces the intro screen when a node is first introduced (one per session).
- Warm-up: the `concept.orient` card is shown in full on the first warm-up on a device, then behind "What's this?".
- Mid-session: "About this skill" on item and feedback screens opens the card and pauses the session until it is closed.
- Feedback tips (T2.13): `packages/content/src/tips.ts` maps scoring error codes to one-line explanations (degree confusions in the item's mode, rhythm timing, no sung note). The first error with a tip wins. Tips show on detailed feedback before a node is mastered, with "More about this" opening the node's card. Practical issues (slightly flat or sharp, timeouts) get no tip: the issue line already says it.
