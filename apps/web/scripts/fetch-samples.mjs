// Downloads the piano sample subset into apps/web/static/samples/piano/.
//
// Source: Splendid Grand Piano (Akai Steinway samples, public domain), as converted and hosted
// for smplr at SOURCE below. Re-runnable: files that already exist are skipped. Pass --force to
// download again.
//
// Behind a proxy: run with NODE_USE_ENV_PROXY=1 so Node's fetch honours HTTPS_PROXY.
//
// KEEP IN SYNC with packages/audio/src/smplr-piano.ts (PIANO_SAMPLE_NOTES, PIANO_VELOCITY_RANGE).
import { Buffer } from "node:buffer";
import console from "node:console";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import process from "node:process";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const SOURCE = "https://smpldsnds.github.io/sfzinstruments-splendid-grand-piano/samples";
const FORMAT = "m4a";
/**
 * Sample names kept per velocity layer: PP (velocity 41-67), MP (68-84) and MF (85-100). The
 * source spells layer names with inconsistent case, so the names are listed verbatim. The notes
 * are MIDI 35, 41, 45, 48, 55, 59, 62, 65, 69, 72, 76, 79, 83, 86, 89, 96.
 */
const SAMPLE_NAMES = {
  PP: [
    "PP B0",
    "PP F1",
    "PP A1",
    "PP C2",
    "PP G2",
    "PP B2",
    "PP D3",
    "PP F3",
    "PP A3",
    "PP C4",
    "PP E4",
    "PP G4",
    "PP B4",
    "PP D5",
    "PP F5",
    "PP C6",
  ],
  MP: [
    "Mp B0",
    "Mp F1",
    "Mp A1",
    "Mp C2",
    "Mp G2",
    "Mp B2",
    "Mp D3",
    "Mp F3",
    "Mp A3",
    "Mp C4",
    "Mp E4",
    "Mp G4",
    "Mp B4",
    "Mp D5",
    "Mp F5",
    "Mp C6",
  ],
  MF: [
    "Mf B0",
    "MF F1",
    "MF A1",
    "MF C2",
    "MF G2",
    "MF B2",
    "MF D3",
    "MF F3",
    "MF A3",
    "MF C4",
    "Mf E4",
    "Mf G4",
    "Mf B4",
    "Mf D5",
    "Mf F5",
    "Mf C6",
  ],
};
const LAYERS = Object.keys(SAMPLE_NAMES);
const NOTES = [35, 41, 45, 48, 55, 59, 62, 65, 69, 72, 76, 79, 83, 86, 89, 96];

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, "..", "static", "samples", "piano");
const force = process.argv.includes("--force");

async function sizeIfPresent(path) {
  try {
    return (await stat(path)).size;
  } catch {
    return 0;
  }
}

async function download(name) {
  const file = join(outDir, `${name}.${FORMAT}`);
  const existing = force ? 0 : await sizeIfPresent(file);
  if (existing > 0) return { name, bytes: existing };
  const url = `${SOURCE}/${encodeURIComponent(name)}.${FORMAT}`;
  let lastError;
  for (const delayMs of [0, 2000, 4000, 8000]) {
    if (delayMs) await sleep(delayMs);
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
      const buf = Buffer.from(await res.arrayBuffer());
      await writeFile(file, buf);
      return { name, bytes: buf.length };
    } catch (e) {
      lastError = e;
    }
  }
  throw lastError;
}

await mkdir(outDir, { recursive: true });
const names = Object.values(SAMPLE_NAMES).flat();
const results = [];
for (let i = 0; i < names.length; i += 6) {
  results.push(...(await Promise.all(names.slice(i, i + 6).map(download))));
}
const total = results.reduce((s, r) => s + r.bytes, 0);
await writeFile(
  join(outDir, "manifest.json"),
  JSON.stringify(
    {
      source: SOURCE,
      licence: "Public domain (Akai Splendid Grand Piano)",
      format: FORMAT,
      layers: LAYERS,
      notes: NOTES,
      files: results.length,
      totalBytes: total,
    },
    null,
    2,
  ) + "\n",
);
console.log(`${results.length} files, ${(total / 1e6).toFixed(2)} MB in ${outDir}`);
