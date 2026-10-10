/**
 * Package boundary rules. Run with `pnpm boundaries`.
 *
 * Type-only imports: with `tsPreCompilationDeps: true` dependency-cruiser sees
 * imports before TypeScript erases them and tags `import type` edges with
 * dependencyType "type-only". Rules that allow type imports use
 * `dependencyTypesNot: ["type-only"]`.
 *
 * Workspace packages resolve through node_modules symlinks, so `to.path`
 * patterns match both `^@clavis/<name>` (unresolved or bare specifier) and
 * `^packages/<name>/` (resolved source path).
 */

/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: "no-circular",
      severity: "error",
      comment: "Circular dependencies make modules impossible to reason about in isolation.",
      from: {},
      to: { circular: true },
    },
    {
      name: "no-unresolvable",
      severity: "error",
      comment:
        "Every import must resolve. A package that is not declared as a dependency shows up here.",
      from: {},
      to: { couldNotResolve: true },
    },
    {
      name: "core-imports-no-workspace",
      severity: "error",
      comment:
        "packages/core must not import any @clavis/* package or any path outside packages/core.",
      from: { path: "^packages/core/" },
      to: {
        path: "^(@clavis/|packages/(?!core/)|apps/|tools/)",
      },
    },
    {
      name: "core-no-ui-or-storage-libs",
      severity: "error",
      comment: "packages/core is pure logic: no DOM framework, no IndexedDB wrapper.",
      from: { path: "^packages/core/" },
      to: { path: "(^|/)node_modules/(dexie|svelte)(/|$)|^(dexie|svelte)(/|$)" },
    },
    {
      name: "scoring-only-core-types",
      severity: "error",
      comment: "packages/scoring may only import @clavis/core, and only as types.",
      from: { path: "^packages/scoring/" },
      to: {
        path: "^(@clavis/(?!core(/|$))|packages/(?!scoring/|core/)|apps/|tools/)",
      },
    },
    {
      name: "scoring-core-types-only",
      severity: "error",
      comment: "packages/scoring may import @clavis/core via `import type` only.",
      from: { path: "^packages/scoring/" },
      to: { path: "^(@clavis/core(/|$)|packages/core/)", dependencyTypesNot: ["type-only"] },
    },
    {
      name: "audio-notation-core-types-only",
      severity: "error",
      comment:
        "packages/audio and packages/notation may import @clavis/core via `import type` only.",
      from: { path: "^packages/(audio|notation)/" },
      to: { path: "^(@clavis/core(/|$)|packages/core/)", dependencyTypesNot: ["type-only"] },
    },
    {
      name: "no-import-from-apps",
      severity: "error",
      comment: "Packages and tools never import from apps/.",
      from: { path: "^(packages|tools)/" },
      to: { path: "^apps/" },
    },
  ],
  options: {
    tsPreCompilationDeps: true,
    tsConfig: { fileName: "tsconfig.base.json" },
    doNotFollow: { path: "node_modules" },
    exclude: { path: "(^|/)(dist|coverage|\\.svelte-kit|\\.wrangler)/" },
    enhancedResolveOptions: {
      exportsFields: ["exports"],
      conditionNames: ["import", "require", "node", "default", "types"],
      mainFields: ["main", "types"],
    },
    skipAnalysisNotInRules: false,
  },
};
