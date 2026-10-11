import { describe, expect, it } from "vitest";
import { PitchWorkerCore } from "../mic/worker-core";
import type { WorkerOutbound } from "../mic/messages";
import { hzToMidi, midiToHz } from "./midi";
import { OCTAVE_CHECK, chooseOctave, goertzelAmplitude, harmonicSupport } from "./octave";
import { runPipelineOnPcm } from "./pipeline";
import { renderNotes } from "./synth";

const SR = 44100;
const RANGE = { minMidi: 36, maxMidi: 64 }; // C2..E4
const BOUNDS = { minHz: 60, maxHz: 1500 };

/**
 * A piano-like tone built from explicit partial amplitudes, generated at test time. `fundamental`
 * scales the 1st partial against a strong 2nd; partials 3..6 fall off like a real string.
 */
function tone(midi: number, fundamental: number, seconds = 0.5, sr = SR): Float32Array {
  const f0 = midiToHz(midi);
  const out = new Float32Array(Math.round(seconds * sr));
  const amps = [fundamental, 1, 0.7, 0.4, 0.25, 0.15];
  for (let i = 0; i < out.length; i++) {
    const t = i / sr;
    let v = 0;
    for (let h = 1; h <= amps.length; h++) {
      v += (amps[h - 1] ?? 0) * Math.sin(2 * Math.PI * f0 * h * t);
    }
    out[i] = 0.12 * v;
  }
  return out;
}

/** The weak-fundamental tone as a played note: 200 ms of silence, a fast attack, a decay, a release. */
function played(midi: number): Float32Array {
  const body = tone(midi, 0.1, 0.6);
  const out = new Float32Array(Math.round(0.2 * SR) + body.length + Math.round(0.3 * SR));
  const offset = Math.round(0.2 * SR);
  for (let i = 0; i < body.length; i++) {
    const t = i / SR;
    const release = Math.min(1, (body.length - 1 - i) / (0.02 * SR));
    out[offset + i] = (body[i] ?? 0) * Math.min(1, t / 0.005) * Math.exp(-t / 0.8) * release;
  }
  return out;
}

const frame = (x: Float32Array): Float32Array => x.subarray(8192, 8192 + 2048);
const midiOf = (hz: number): number => Math.round(hzToMidi(hz));

describe("goertzelAmplitude", () => {
  it("reads a unit sine as about 1 and an absent frequency as about 0", () => {
    const x = new Float32Array(2048);
    for (let i = 0; i < x.length; i++) x[i] = Math.sin((2 * Math.PI * 220 * i) / SR);
    expect(goertzelAmplitude(x, SR, 220)).toBeCloseTo(1, 1);
    expect(goertzelAmplitude(x, SR, 110)).toBeLessThan(0.03);
    expect(harmonicSupport(new Float32Array(2048), SR, 110)).toBe(0);
  });
});

describe("chooseOctave", () => {
  const bass = Array.from({ length: 12 }, (_, i) => 36 + i); // C2..B2

  it.each(bass)("weak fundamental, MIDI %i: the MPM octave-high read is corrected", (midi) => {
    const hz = chooseOctave(frame(tone(midi, 0.1)), SR, midiToHz(midi + 12), {
      range: RANGE,
      ...BOUNDS,
    });
    expect(midiOf(hz)).toBe(midi);
  });

  it("corrects weak-fundamental notes up through E4 when the range allows the lower octave", () => {
    for (let midi = 36; midi <= 52; midi++) {
      const hz = chooseOctave(frame(tone(midi, 0.1)), SR, midiToHz(midi + 12), {
        range: RANGE,
        ...BOUNDS,
      });
      expect(midiOf(hz), `midi ${String(midi)}`).toBe(midi);
    }
  });

  it("leaves a tone with a strong fundamental alone, C2..E4 with the range set", () => {
    for (let midi = 36; midi <= 64; midi++) {
      const hz = midiToHz(midi);
      expect(chooseOctave(frame(tone(midi, 1.5)), SR, hz, { range: RANGE, ...BOUNDS })).toBe(hz);
    }
  });

  it("does not move normal sine, piano and vowel tones, with or without a range", () => {
    for (const timbre of ["sine", "piano", "vowel"] as const) {
      for (let midi = 36; midi <= 84; midi++) {
        const x = renderNotes([{ midi, startSec: 0, durSec: 0.5, timbre }], SR, 0.6);
        const hz = midiToHz(midi);
        const label = `${timbre} ${String(midi)}`;
        if (midi <= 64) {
          expect(chooseOctave(frame(x), SR, hz, { range: RANGE, ...BOUNDS }), label).toBe(hz);
        }
        expect(chooseOctave(frame(x), SR, hz, BOUNDS), `${label} no range`).toBe(hz);
      }
    }
  }, 30_000);

  it("repairs a subharmonic read when only the upper octave is supported", () => {
    const hz = chooseOctave(frame(tone(55, 1)), SR, midiToHz(43), { range: RANGE, ...BOUNDS });
    expect(midiOf(hz)).toBe(55);
  });

  it("ignores candidates outside the expected range", () => {
    const mpm = midiToHz(48);
    const range = { minMidi: 45, maxMidi: 64 };
    expect(chooseOctave(frame(tone(36, 0.1)), SR, mpm, { range, ...BOUNDS })).toBe(mpm);
  });

  it("without a range, only checks estimates below the low threshold", () => {
    const x = frame(tone(43, 0.1));
    const high = midiToHz(55);
    expect(high).toBeGreaterThan(OCTAVE_CHECK.LOW_HZ);
    expect(chooseOctave(x, SR, high, BOUNDS)).toBe(high);
    // A2 is checked, but its lower octave (55 Hz) is below minHz, so it stays.
    const a2 = midiToHz(45);
    expect(chooseOctave(frame(tone(45, 0.1)), SR, a2, BOUNDS)).toBe(a2);
  });

  it("works at 48 kHz", () => {
    for (let midi = 36; midi <= 47; midi++) {
      const x = tone(midi, 0.1, 0.5, 48000);
      const hz = chooseOctave(frame(x), 48000, midiToHz(midi + 12), { range: RANGE, ...BOUNDS });
      expect(midiOf(hz), `midi ${String(midi)}`).toBe(midi);
    }
  });
});

describe("octave check in the pipeline", () => {
  it("reports the right octave for weak-fundamental notes C2..E4 end to end", () => {
    for (let midi = 36; midi <= 64; midi++) {
      const { notes } = runPipelineOnPcm(played(midi), SR, {
        segmenter: { expectedRange: RANGE },
      });
      // The energy segmenter can split the lowest notes in two (hop RMS ripples at 65 Hz); what
      // this test pins is the octave of every note it reports.
      expect(notes.length, `midi ${String(midi)}`).toBeGreaterThan(0);
      expect(
        notes.map((n) => n.pitch),
        `midi ${String(midi)}`,
      ).toEqual(notes.map(() => midi));
    }
  }, 30_000);
});

describe("range set through the worker core", () => {
  const pitches = (range: { minMidi: number; maxMidi: number } | null): number[] => {
    const x = played(36);
    const out: WorkerOutbound[] = [];
    const core = new PitchWorkerCore((m) => out.push(m));
    // Set before any audio arrives: it must apply when the pipeline is created.
    core.setExpectedRange(range);
    for (let i = 0; i < x.length; i += 2048) {
      core.handleChunk({
        type: "chunk",
        samples: x.slice(i, i + 2048),
        startFrame: i,
        sampleRate: SR,
      });
    }
    core.stop();
    return out.flatMap((m) => (m.type === "note" && m.phase === "start" ? [m.note.pitch] : []));
  };

  it("applies a range set before the first chunk, and accepts null", () => {
    expect(pitches(RANGE)[0]).toBe(36);
    expect(pitches(null).length).toBeGreaterThan(0);
  });
});
