# Clavis

Clavis is an offline-first piano and ear-training PWA. It builds a model of what the learner knows (a skill graph with spaced repetition), composes short daily sessions, and listens to sung or played responses to grade them.

- Specs: [`docs/specs`](docs/specs)
- Plan and task breakdown: [`docs/implementation-plan.md`](docs/implementation-plan.md)
- Agent and contributor conventions: [`CLAUDE.md`](CLAUDE.md)

## Quickstart

Requires Node 22 (see `.nvmrc`) and pnpm 10 (`corepack enable` picks the pinned version).

```sh
pnpm install
pnpm check        # format:check, lint, typecheck, boundaries, test
pnpm test         # vitest run
pnpm format       # prettier --write
```

## Layout

- `packages/core`: learning model, pure TypeScript
- `packages/audio`, `packages/notation`, `packages/scoring`, `packages/content`
- `apps/web`, `apps/worker`: added in M0 (T0.2, T0.5)
