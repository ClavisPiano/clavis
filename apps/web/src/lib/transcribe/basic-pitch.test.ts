// @vitest-environment node
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { toNoteEvents } from "@clavis/audio";
import * as tf from "@tensorflow/tfjs";
import { describe, expect, it } from "vitest";
import { renderNotes } from "../../../../../packages/audio/src/pitch/synth";
import { transcribeSamples } from "./basic-pitch";

/* The real Basic Pitch model on a synthetic two-chord take (T8.19). Synthetic harmonic tones are
   not piano: this proves the plumbing (resampling, windowing, thresholds, clock) and catches a
   model or library change, not real-world accuracy. Real accuracy is what the review in R31 is
   for. Runs on the pure-JS CPU backend, so it takes several seconds. */

const dir = new URL("../../../static/models/basic-pitch/", import.meta.url);

async function loadModel(): Promise<tf.GraphModel> {
  const json = JSON.parse(readFileSync(new URL("model.json", dir), "utf8")) as {
    format: string;
    generatedBy: string;
    convertedBy: string;
    modelTopology: object;
    weightsManifest: { weights: tf.io.WeightsManifestEntry[] }[];
  };
  const bin = readFileSync(new URL("group1-shard1of1.bin", dir));
  const weightData = bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.byteLength);
  return tf.loadGraphModel({
    load: () =>
      Promise.resolve({
        modelTopology: json.modelTopology,
        weightSpecs: json.weightsManifest.flatMap((m) => m.weights),
        weightData,
        format: json.format,
        generatedBy: json.generatedBy,
        convertedBy: json.convertedBy,
      }),
  });
}

const SR = 44100;
const CHORDS = [
  { at: 0.3, midi: [48, 52, 55] },
  { at: 2.0, midi: [53, 57, 60] },
];

describe("Basic Pitch on a synthetic take", () => {
  it("finds both chords, in tune and in time, with ghosts below the amplitude cut", async () => {
    const model = await loadModel();
    const take = renderNotes(
      CHORDS.flatMap((c) =>
        c.midi.map((midi) => ({ midi, startSec: c.at, durSec: 1.2, timbre: "piano" as const })),
      ),
      SR,
      3.6,
    );
    const heard = toNoteEvents(await transcribeSamples(model, take, SR), { startMs: 10_000 });

    for (const chord of CHORDS) {
      for (const midi of chord.midi) {
        const found = heard.find(
          (n) => n.pitch === midi && Math.abs(n.onsetMs - (10_000 + chord.at * 1000)) < 80,
        );
        expect(found, `note ${String(midi)} at ${String(chord.at)} s`).toBeDefined();
      }
    }
    // Overtone ghosts may survive, but not in the playing register.
    const expected = new Set(CHORDS.flatMap((c) => c.midi));
    const strays = heard.filter((n) => !expected.has(n.pitch) && n.pitch < 66);
    expect(strays).toEqual([]);
  }, 120_000);

  it("hears nothing in silence", async () => {
    const model = await loadModel();
    expect(await transcribeSamples(model, new Float32Array(SR * 2), SR)).toEqual([]);
  }, 120_000);

  it("returns nothing for a take too short to analyse", async () => {
    const model = await loadModel();
    expect(await transcribeSamples(model, new Float32Array(100), SR)).toEqual([]);
  });
});

describe("the shipped model files", () => {
  it("are the ones in the installed @spotify/basic-pitch package", () => {
    const require = createRequire(import.meta.url);
    const pkgDir = require
      .resolve("@spotify/basic-pitch/package.json")
      .replace(/package\.json$/, "");
    for (const name of ["model.json", "group1-shard1of1.bin"]) {
      const shipped = readFileSync(new URL(name, dir));
      const packaged = readFileSync(`${pkgDir}model/${name}`);
      expect(shipped.equals(packaged), name).toBe(true);
    }
  });
});
