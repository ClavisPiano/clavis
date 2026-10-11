// Prints the size of the notation (Verovio) build output and fails when it grew more than 10%
// over the committed baseline. Run after `pnpm --filter @clavis/web build`.
//
//   node scripts/notation-size.mjs            compare with notation-size-baseline.json
//   node scripts/notation-size.mjs --update   rewrite the baseline from the current build
//
// The notation files are the build outputs whose name contains "verovio" (the worker chunk, which
// inlines the WASM as base64) plus any .wasm file. Sizes are measured on the files as emitted:
// raw bytes, gzip level 9 and brotli quality 11 (Node zlib). The decision threshold in
// docs/spikes/notation.md is on brotli.
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { brotliCompressSync, constants, gzipSync } from "node:zlib";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const buildDir = join(root, "build");
const baselinePath = join(root, "notation-size-baseline.json");
const TOLERANCE = 0.1;
const KINDS = ["raw", "gzip", "brotli"];

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

function measure() {
  let files;
  try {
    files = walk(buildDir);
  } catch {
    console.error(`No build output at ${buildDir}. Run "pnpm --filter @clavis/web build" first.`);
    process.exit(2);
  }
  const hits = files.filter(
    (f) => /verovio/i.test(f.split("/").pop() ?? "") || f.endsWith(".wasm"),
  );
  if (hits.length === 0) {
    console.error("No notation files found in the build output.");
    process.exit(2);
  }
  const out = { files: {}, total: { raw: 0, gzip: 0, brotli: 0 } };
  for (const file of hits.sort()) {
    const data = readFileSync(file);
    const entry = {
      raw: data.length,
      gzip: gzipSync(data, { level: 9 }).length,
      brotli: brotliCompressSync(data, {
        params: {
          [constants.BROTLI_PARAM_QUALITY]: 11,
          [constants.BROTLI_PARAM_SIZE_HINT]: data.length,
        },
      }).length,
    };
    // Strip the content hash so the key is stable across builds.
    const key = relative(buildDir, file).replace(/-[A-Za-z0-9_-]{8}\.(js|wasm)$/, ".$1");
    out.files[key] = entry;
    for (const k of KINDS) out.total[k] += entry[k];
  }
  return out;
}

const mb = (n) => `${(n / 1048576).toFixed(2)} MB`;
const current = measure();

console.log("Notation build output (raw / gzip / brotli):");
for (const [name, e] of Object.entries(current.files)) {
  console.log(`  ${name}: ${mb(e.raw)} / ${mb(e.gzip)} / ${mb(e.brotli)}`);
}
const t = current.total;
console.log(`  total: ${mb(t.raw)} / ${mb(t.gzip)} / ${mb(t.brotli)}`);
console.log(JSON.stringify(t));

if (process.argv.includes("--update")) {
  writeFileSync(baselinePath, `${JSON.stringify(current, null, 2)}\n`);
  console.log(`Wrote ${relative(process.cwd(), baselinePath)}`);
  process.exit(0);
}

let baseline;
try {
  baseline = JSON.parse(readFileSync(baselinePath, "utf8"));
} catch {
  console.error("Missing notation-size-baseline.json. Run with --update to create it.");
  process.exit(2);
}

let failed = false;
for (const k of KINDS) {
  const limit = baseline.total[k] * (1 + TOLERANCE);
  if (t[k] > limit) {
    console.error(
      `FAIL: notation ${k} total ${t[k]} bytes exceeds baseline ${baseline.total[k]} by more than ${TOLERANCE * 100}%`,
    );
    failed = true;
  }
}
if (failed) {
  console.error("If the growth is intended, run: node scripts/notation-size.mjs --update");
  process.exit(1);
}
console.log("OK: within 10% of the baseline.");
