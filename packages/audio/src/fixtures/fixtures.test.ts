import { describe, expect, it } from "vitest";
import { renderNotes } from "../pitch/synth";
import { runWavBytes, runWavFile } from "./runner";
import { readWav, writeWav } from "./wav";

const SR = 44100;
const seq = [60, 64, 67];
const mono = renderNotes(
  seq.map((midi, i) => ({ midi, startSec: 0.2 + i * 0.6, durSec: 0.4, timbre: "piano" as const })),
  SR,
  2.2,
);

describe("readWav", () => {
  it("round-trips 16-bit PCM mono", () => {
    const wav = readWav(writeWav(mono, SR));
    expect(wav.sampleRate).toBe(SR);
    expect(wav.channels).toBe(1);
    expect(wav.samples).toHaveLength(mono.length);
    expect(wav.samples[10000]).toBeCloseTo(mono[10000] ?? 0, 3);
  });

  it("reads 32-bit float exactly", () => {
    const wav = readWav(writeWav(mono, SR, { encoding: "float32" }));
    expect(wav.samples[10000]).toBe(mono[10000]);
  });

  it("averages stereo channels", () => {
    const inter = new Float32Array(6);
    inter.set([0.5, -0.5, 0.25, 0.75, 1, 0]);
    const wav = readWav(writeWav(inter, 8000, { channels: 2, encoding: "float32" }));
    expect(wav.channels).toBe(2);
    expect(Array.from(wav.samples)).toEqual([0, 0.5, 0.5]);
  });

  it("rejects other encodings and non-WAV data", () => {
    expect(() => readWav(new Uint8Array(100))).toThrow(/RIFF/);
    const bad = writeWav(mono.subarray(0, 100), SR);
    new DataView(bad.buffer).setUint16(34, 24, true);
    expect(() => readWav(bad)).toThrow(/Unsupported/);
  });
});

describe("runWavBytes", () => {
  it("finds the notes of a synthesised stereo float WAV", () => {
    const stereo = new Float32Array(mono.length * 2);
    mono.forEach((v, i) => {
      stereo[2 * i] = v;
      stereo[2 * i + 1] = v;
    });
    const r = runWavBytes(writeWav(stereo, SR, { channels: 2, encoding: "float32" }));
    expect(r.notes.map((n) => n.pitch)).toEqual(seq);
    expect(r.sampleRate).toBe(SR);
    expect(r.durationMs).toBeCloseTo(2200, 0);
    expect(r.frames.length).toBeGreaterThan(100);
  });

  it("runs via an injected file reader on 16-bit PCM", async () => {
    const bytes = writeWav(mono, SR);
    const r = await runWavFile("x.wav", () => Promise.resolve(bytes));
    expect(r.notes.map((n) => n.pitch)).toEqual(seq);
  });
});
