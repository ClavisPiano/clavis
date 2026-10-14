# Clavis

Clavis is an offline-first piano and ear-training PWA: a skill graph plus spaced repetition drives short daily sessions, and sung or played answers are graded from the microphone, MIDI or an on-screen keyboard. Read `docs/specs/` for the product and architecture, and `docs/implementation-plan.md` for spec resolutions (R1-R22) and the task list. Work on one plan task at a time.

## Commands

Run from the repo root. Use Node 22 and pnpm 10.

- `pnpm install`: install (CI uses `--frozen-lockfile`)
- `pnpm check`: format:check, lint, typecheck, boundaries, test, in that order. Must pass before every PR
- `pnpm test`: Vitest (root `vitest.config.ts` uses `projects`)
- `pnpm lint`, `pnpm format`, `pnpm format:check`, `pnpm typecheck`
- `pnpm boundaries`: dependency-cruiser package boundary rules

## Package map

- `packages/core`: learning model (graph, items, grading, scheduler, composer, events). Pure TypeScript
- `packages/audio`: input adapters, worklets, pitch, stimulus playback
- `packages/notation`: Verovio wrapper, score model, import
- `packages/scoring`: alignment and note matching
- `packages/content`: skill graph data, concept cards
- `packages/store`: Dexie (IndexedDB) `EventStore` adapter. May import `@clavis/core` at runtime
- `apps/web`: Svelte PWA. `apps/worker`: Cloudflare Worker. `tools/`: build-time tools

Workspace packages export `src/index.ts` directly. There is no build step for packages.

## Boundary rules (enforced by `pnpm boundaries` and ESLint)

- `core` imports no `@clavis/*` package and nothing outside itself. It must not use `dexie`, `svelte` or anything under `apps/`.
- `scoring` imports only `@clavis/core`, and only with `import type`.
- `audio` and `notation` may use `@clavis/core` only with `import type`. Runtime imports are errors.
- `store` imports only `@clavis/core` (runtime allowed). `core` never imports `store`.
- No package or tool imports from `apps/`.
- No circular dependencies, no unresolvable imports.

Type-only imports are detected by dependency-cruiser (`tsPreCompilationDeps: true`). An ESLint `no-restricted-imports` rule with `allowTypeImports` backs this up for `audio` and `notation`. If a boundary blocks you, change the design, not the rule.

## Conventions

- TypeScript strict (plus `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax`). No `any` without a comment explaining why. ESM only.
- In `core`, write pure functions. Inject the clock and a seeded RNG; never call `Date.now()` or `Math.random()` there (ESLint enforces this).
- Use zod for schemas at boundaries (events, content, storage, network).
- Event schemas: never edit a shipped schema version. Add a new version and an upcaster.
- Pin exact dependency versions (no `^` or `~`). Look up current versions with `pnpm view <pkg> version`.
- Prose style: avoid em dashes in docs and comments.

## Testing

- Every PR adds tests that prove its acceptance criteria from the plan.
- Use `fast-check` property tests for reducers and other invariants (refold order independence, idempotent replay).
- Prefer table-driven tests for grading and scoring, and seeded golden tests for the composer.

## Pull requests

- One task per PR. Title starts with the task id, for example `T0.1: Monorepo scaffold`.
- The body says `Closes #<issue>`.
- `pnpm check` must be green.
- CI minutes are limited. Run `pnpm check` locally and push once it passes; every push to a PR runs CI. On a PR, CI runs the Chromium end-to-end tests only, and docs-only changes (`docs/` and Markdown) run just the format check. Mobile Safari runs after merge on `main`, desktop WebKit weekly. For a change that could behave differently in Safari, run the CI workflow by hand on the branch (Actions tab, Run workflow) before merging: that runs all three browsers.
