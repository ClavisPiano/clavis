import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  CLAVIS_LICENCES,
  THIRD_PARTY,
  THIRD_PARTY_ASSETS,
  THIRD_PARTY_LIBRARIES,
  displayVersion,
  isLgpl,
  loadNotices,
} from "./about";

const webRoot = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const repoRoot = join(webRoot, "../..");

/** Production dependencies of the workspaces whose code is bundled into the web app. */
const SHIPPED_MANIFESTS = [
  "apps/web",
  "packages/audio",
  "packages/core",
  "packages/notation",
  "packages/store",
];

function shippedDependencies(): Map<string, Set<string>> {
  const deps = new Map<string, Set<string>>();
  for (const dir of SHIPPED_MANIFESTS) {
    const pkg = JSON.parse(readFileSync(join(repoRoot, dir, "package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
    };
    for (const [name, version] of Object.entries(pkg.dependencies ?? {})) {
      if (name.startsWith("@clavis/")) continue;
      deps.set(name, (deps.get(name) ?? new Set()).add(version));
    }
  }
  return deps;
}

describe("third-party data", () => {
  it("has unique ids and a source link for every library", () => {
    const ids = THIRD_PARTY.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const lib of THIRD_PARTY_LIBRARIES) {
      expect(lib.source, lib.id).not.toBeNull();
      expect(lib.packages.length, lib.id).toBeGreaterThan(0);
    }
    expect(THIRD_PARTY_ASSETS.map((e) => e.id)).toEqual(["splendid-grand-piano", "piece-library"]);
  });

  it("lists every shipped production dependency at its pinned version", () => {
    const listed = new Map(THIRD_PARTY.flatMap((e) => e.packages.map((p) => [p.name, p.version])));
    for (const [name, versions] of shippedDependencies()) {
      expect(listed.has(name), `${name} is missing from third-party.json`).toBe(true);
      expect([...versions], name).toEqual([listed.get(name)]);
    }
  });

  it("flags the LGPL component, links its source at the pinned version and ships both texts", () => {
    const lgpl = THIRD_PARTY_LIBRARIES.filter(isLgpl);
    expect(lgpl.map((e) => e.id)).toEqual(["verovio"]);
    const [verovio] = lgpl;
    expect(verovio?.packages.map((p) => p.version)).toEqual(["6.3.0"]);
    expect(verovio?.source).toBe("https://github.com/rism-digital/verovio/tree/version-6.3.0");
    expect(verovio?.extraTexts).toEqual(["lgpl-3.0.txt", "gpl-3.0.txt"]);
  });

  it("shows a version for single-package entries only", () => {
    const versionOf = (id: string) => {
      const entry = THIRD_PARTY.find((e) => e.id === id);
      if (entry === undefined) throw new Error(`no entry ${id}`);
      return displayVersion(entry);
    };
    expect(versionOf("zod")).toBe("4.6.5");
    expect(versionOf("tonal")).toBeUndefined();
    expect(versionOf("piece-library")).toBeUndefined();
  });
});

describe("Clavis licences", () => {
  it("names the code and content licences with links into the repository", () => {
    expect(CLAVIS_LICENCES.map((l) => l.name)).toEqual([
      "PolyForm Noncommercial License 1.0.0",
      "CC BY-NC 4.0",
    ]);
    for (const l of CLAVIS_LICENCES) {
      expect(l.fileUrl).toMatch(/^https:\/\/github\.com\/ClavisPiano\/clavis\/blob\/main\/LICENSE/);
    }
  });
});

describe("licence texts", () => {
  it("contains a section for every package, the Apache NOTICE and both GNU texts", async () => {
    const text = await loadNotices();
    for (const { name, version, license } of THIRD_PARTY.flatMap((e) =>
      e.packages.map((p) => ({ ...p, license: e.license })),
    )) {
      expect(text, name).toContain(`${name} ${version}, ${license}`);
    }
    expect(text).toContain("GNU LESSER GENERAL PUBLIC LICENSE");
    expect(text).toContain("GNU GENERAL PUBLIC LICENSE");
    expect(text).toContain("Apache License");
    expect(text).toContain("Copyright Fedor Indutny, 2017.");
    expect(text).not.toContain("{{COPYRIGHT}}");
  });

  it("is up to date with node_modules (regenerate with: pnpm --filter @clavis/web notices)", () => {
    const out = execFileSync("node", ["scripts/third-party-notices.mjs", "--check"], {
      cwd: webRoot,
      encoding: "utf8",
    });
    expect(out).toContain("up to date");
  });
});
