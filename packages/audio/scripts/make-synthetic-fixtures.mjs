/* global Buffer, console */
// Generates the synthetic seed fixtures under fixtures/audio/synthetic and merges their ground
// truth into fixtures/audio/manifest.json (entries whose id starts with "synthetic-").
// Plain Node ESM, no dependencies. Deterministic: rerunning produces identical bytes.
//
//   pnpm --filter @clavis/audio fixtures:synthetic
//
// Real recordings are added to the manifest by hand and are never touched by this script.

import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SR = 22050;
const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "fixtures", "audio");
const TWO_PI = 2 * Math.PI;
const hz = (midi) => 440 * Math.pow(2, (midi - 69) / 12);

let seed = 12345;
function noise() {
  // xorshift32 in [-1, 1]
  seed ^= seed << 13;
  seed >>>= 0;
  seed ^= seed >>> 17;
  seed ^= seed << 5;
  seed >>>= 0;
  return (seed / 0xffffffff - 0.5) * 2;
}

/** Sung-like vowel: harmonic stack with a formant bump, vibrato, slow attack and release. */
function vowel(out, midi, startSec, durSec, vibratoCents) {
  const start = Math.round(startSec * SR);
  const len = Math.round(durSec * SR);
  const f0 = hz(midi);
  let phase = 0;
  for (let i = 0; i < len; i++) {
    const t = i / SR;
    // Vibrato ramps in over the first 150 ms, as in real singing.
    const depth = vibratoCents * Math.min(1, t / 0.15);
    phase += (TWO_PI * f0 * Math.pow(2, (depth * Math.sin(TWO_PI * 5.5 * t)) / 1200)) / SR;
    let s = 0;
    for (let h = 1; h <= 12; h++) {
      if (f0 * h > SR / 2.2) break;
      s += (1 / h + (Math.abs(h * f0 - 800) < 250 ? 0.25 : 0)) * Math.sin(h * phase);
    }
    const a = Math.min(1, i / (0.03 * SR));
    const r = Math.min(1, (len - 1 - i) / (0.05 * SR));
    out[start + i] += 0.16 * s * Math.max(0, Math.min(a, r));
  }
}

/** Piano-like note: decaying partials with slight stretch, fast attack, weak fundamental when low. */
function piano(out, midi, startSec, durSec) {
  const start = Math.round(startSec * SR);
  const len = Math.round(durSec * SR);
  const f0 = hz(midi);
  for (let i = 0; i < len; i++) {
    const t = i / SR;
    let s = 0;
    for (let h = 1; h <= 8; h++) {
      const f = f0 * h * Math.sqrt(1 + 0.0004 * h * h);
      if (f > SR / 2.2) break;
      const weight = (h === 1 && midi < 48 ? 0.5 : 1) / Math.pow(h, 1.1);
      s += weight * Math.sin(TWO_PI * f * t) * Math.exp(-t * (0.6 + 0.5 * h));
    }
    const env = Math.min(1, t / 0.004) * Math.min(1, (len - 1 - i) / (0.02 * SR));
    out[start + i] += 0.3 * s * env;
  }
}

function encodeWav(samples) {
  const buf = Buffer.alloc(44 + samples.length * 2);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + samples.length * 2, 4);
  buf.write("WAVEfmt ", 8);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(SR, 24);
  buf.writeUInt32LE(SR * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36);
  buf.writeUInt32LE(samples.length * 2, 40);
  samples.forEach((v, i) =>
    buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, v)) * 32767), 44 + i * 2),
  );
  return buf;
}

/** Build one fixture from a list of [midi, startSec, durSec] and a voice renderer. */
function build(id, kind, instrument, notes, totalSec, render, extra = {}) {
  const out = new Float32Array(Math.round(totalSec * SR));
  for (const [midi, start, dur] of notes) render(out, midi, start, dur);
  for (let i = 0; i < out.length; i++) out[i] += 0.0015 * noise(); // about -56 dBFS room noise
  const file = `synthetic/${id}.wav`;
  mkdirSync(join(root, "synthetic"), { recursive: true });
  writeFileSync(join(root, file), encodeWav(out));
  return {
    id: `synthetic-${id}`,
    file,
    kind,
    instrument,
    device: "synthetic",
    sampleRate: SR,
    notes: notes.map(([midi, start, dur]) => ({
      midi,
      onsetMs: Math.round(start * 1000),
      offsetMs: Math.round((start + dur) * 1000),
    })),
    ...extra,
    tags: ["synthetic", ...(extra.tags ?? [])],
  };
}

const entries = [
  // G major degrees 1, 3, 5, 7 (a male register and a female register), 25 cent vibrato.
  build(
    "sung-g-low",
    "sung-degree",
    "voice",
    [
      [43, 0.3, 0.55],
      [47, 1.1, 0.55],
      [50, 1.9, 0.55],
      [54, 2.7, 0.55],
    ],
    3.5,
    (o, m, s, d) => vowel(o, m, s, d, 25),
    { expectedRange: { low: 41, high: 56 }, tags: ["vibrato"] },
  ),
  build(
    "sung-c-high",
    "sung-degree",
    "voice",
    [
      [60, 0.3, 0.55],
      [64, 1.1, 0.55],
      [67, 1.9, 0.55],
      [71, 2.7, 0.55],
    ],
    3.5,
    (o, m, s, d) => vowel(o, m, s, d, 35),
    { expectedRange: { low: 58, high: 73 }, tags: ["vibrato"] },
  ),
  // Single notes spread across the range, no register hint (octave errors are measured).
  build(
    "piano-singles",
    "piano-single",
    "acoustic-piano",
    [
      [33, 0.2, 0.5],
      [45, 0.9, 0.5],
      [57, 1.6, 0.5],
      [69, 2.3, 0.5],
      [81, 3.0, 0.5],
      [93, 3.7, 0.5],
    ],
    4.4,
    piano,
  ),
  // Twinkle-style fragment with repeated notes.
  build(
    "piano-melody",
    "piano-sequence",
    "acoustic-piano",
    [
      [60, 0.2, 0.4],
      [60, 0.8, 0.4],
      [67, 1.4, 0.4],
      [67, 2.0, 0.4],
      [69, 2.6, 0.4],
      [69, 3.2, 0.4],
      [67, 3.8, 0.7],
    ],
    4.8,
    piano,
    { expectedRange: { low: 55, high: 76 } },
  ),
];

const manifestPath = join(root, "manifest.json");
const existing = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, "utf8")) : [];
const kept = existing.filter((e) => !e.id.startsWith("synthetic-"));
writeFileSync(manifestPath, JSON.stringify([...entries, ...kept], null, 2) + "\n");
console.log(
  `Wrote ${String(entries.length)} synthetic fixtures; manifest has ${String(entries.length + kept.length)} entries.`,
);
