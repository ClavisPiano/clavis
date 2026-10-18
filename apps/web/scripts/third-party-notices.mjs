// Builds src/lib/about/third-party-notices.txt, the licence texts shown on the About screen, from
// src/lib/about/third-party.json and the packages installed in node_modules.
//
//   node scripts/third-party-notices.mjs           rewrite the notices file
//   node scripts/third-party-notices.mjs --check   fail if the committed file is out of date
//
// For each npm package it checks the installed version matches the data file, then copies the
// package's own LICENSE and NOTICE files. Packages that ship no licence file use a committed text
// from scripts/licence-texts (`fallback`). Entries with `extraTexts` (the LGPL and the GPL it
// builds on, for Verovio) get those texts appended once at the end, as LGPL-3.0 section 4 requires.
// Run it after changing a dependency or third-party.json, and commit the result.
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const store = join(root, "..", "..", "node_modules", ".pnpm");
const dataPath = join(root, "src/lib/about/third-party.json");
const outPath = join(root, "src/lib/about/third-party-notices.txt");
const textsDir = join(root, "scripts/licence-texts");
const LICENCE_FILE = /^(licen[cs]e|notice)(\.md|\.txt)?$/i;

function installedDir(name, version) {
  // pnpm appends peer-dependency suffixes (`pkg@1.0.0_peer@2.0.0`) to the store directory name.
  const prefix = `${name.replace("/", "+")}@${version}`;
  const entry = readdirSync(store).find((d) => d === prefix || d.startsWith(`${prefix}_`));
  const dir = join(store, entry ?? prefix, "node_modules", name);
  if (!existsSync(join(dir, "package.json"))) {
    throw new Error(
      `${name}@${version} is not installed (third-party.json may be out of date, or run pnpm install)`,
    );
  }
  return dir;
}

function readText(path) {
  return readFileSync(path, "utf8").replace(/\r\n/g, "\n").trimEnd();
}

function packageTexts(entry, pkg) {
  const dir = installedDir(pkg.name, pkg.version);
  const found = readdirSync(dir)
    .filter((f) => LICENCE_FILE.test(f))
    .sort();
  if (found.length > 0) return found.map((f) => readText(join(dir, f)));
  const fallback = entry.fallback;
  if (fallback?.text) return [fallback.text];
  if (fallback?.file) return [readText(join(textsDir, fallback.file))];
  if (fallback?.mit) {
    return [readText(join(textsDir, "mit-template.txt")).replace("{{COPYRIGHT}}", fallback.mit)];
  }
  throw new Error(`${pkg.name}@${pkg.version} ships no licence file and has no fallback`);
}

export function buildNotices() {
  const entries = JSON.parse(readFileSync(dataPath, "utf8"));
  const parts = [
    "Third-party notices for Clavis",
    "",
    "Clavis includes the components below. Each keeps its own licence. The licence texts follow",
    "each component, as supplied with the package or by its project.",
  ];
  const extras = new Map();
  for (const entry of entries) {
    for (const pkg of entry.packages) {
      parts.push("", "=".repeat(78), `${pkg.name} ${pkg.version}, ${entry.license}`);
      if (entry.homepage) parts.push(entry.homepage);
      parts.push("=".repeat(78), "");
      parts.push(packageTexts(entry, pkg).join("\n\n"));
    }
    for (const file of entry.extraTexts ?? []) extras.set(file, readText(join(textsDir, file)));
  }
  for (const [file, text] of extras) {
    parts.push(
      "",
      "=".repeat(78),
      `Licence text: ${file.replace(/\.txt$/, "")}`,
      "=".repeat(78),
      "",
    );
    parts.push(text);
  }
  return `${parts.join("\n")}\n`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const next = buildNotices();
  if (process.argv.includes("--check")) {
    const current = existsSync(outPath) ? readFileSync(outPath, "utf8") : "";
    if (current !== next) {
      console.error(
        "third-party-notices.txt is out of date. Run: pnpm --filter @clavis/web notices",
      );
      process.exit(1);
    }
    console.log("third-party-notices.txt is up to date");
  } else {
    writeFileSync(outPath, next);
    console.log(`wrote ${outPath} (${next.length} bytes)`);
  }
}
