// Node types are pulled in for this test file only (production code is typechecked with `types: []`).
/// <reference types="node" />
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_ONSET_TOLERANCE_MS,
  compareToBaseline,
  formatReport,
  roundReport,
  runAccuracy,
  type BaselineFile,
} from "./accuracy";
import { parseManifest } from "./manifest";

/**
 * Regression test over the real corpus in `fixtures/audio`. Compares against `baseline.json`.
 * Run `pnpm --filter @clavis/audio accuracy:update` to rewrite the baseline and REPORT.md.
 */

const dir = fileURLToPath(new URL("../../../../fixtures/audio/", import.meta.url));
const update = process.env.ACCURACY_UPDATE === "1";

const manifestPath = dir + "manifest.json";
const baselinePath = dir + "baseline.json";

/** Git LFS pointer files are small text files starting with this line. */
function isLfsPointer(bytes: Uint8Array): boolean {
  const head = new TextDecoder().decode(bytes.subarray(0, 40));
  return head.startsWith("version https://git-lfs.github.com/spec");
}

describe("fixture accuracy regression", () => {
  it("matches the committed baseline", async (ctx) => {
    const manifest = parseManifest(JSON.parse(readFileSync(manifestPath, "utf8")));

    const pointers = manifest.filter((e) => isLfsPointer(readFileSync(dir + e.file)));
    if (pointers.length > 0) {
      ctx.skip(
        `Skipping: ${String(pointers.length)} fixture file(s) are Git LFS pointers, not audio ` +
          `(first: ${pointers[0]?.file ?? ""}). Run "git lfs install && git lfs pull" to fetch them.`,
      );
      return;
    }

    const report = roundReport(await runAccuracy(manifest, (p) => readFile(p), { baseDir: dir }));

    if (update) {
      const baseline: BaselineFile = {
        version: 1,
        onsetToleranceMs: DEFAULT_ONSET_TOLERANCE_MS,
        report,
      };
      writeFileSync(baselinePath, JSON.stringify(baseline, null, 2) + "\n");
      const md = formatReport(manifest, report);
      writeFileSync(dir + "REPORT.md", md);
      process.stderr.write(`\n${md}\n`);
      return;
    }

    expect(
      existsSync(baselinePath),
      "fixtures/audio/baseline.json is missing; run accuracy:update",
    ).toBe(true);
    const baseline = JSON.parse(readFileSync(baselinePath, "utf8")) as BaselineFile;
    expect(compareToBaseline(report, baseline.report)).toEqual([]);
  });
});
