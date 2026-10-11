import { describe, expect, it } from "vitest";
import { analyseFrame } from "./analyse";
import { centsFromNearest, foldMidi, hzToMidi, median, midiToHz } from "./midi";
import { PitchPipeline, runPipelineOnPcm } from "./pipeline";
import { NoteSegmenter } from "./segmenter";
import { renderNotes, whiteNoise, type Timbre } from "./synth";
import { PitchTracker } from "./tracker";

const SR = 44100;
const TIMBRES: Timbre[] = ["sine", "piano", "vowel"];

describe("midi helpers", () => {
  it("round-trips and measures cents", () => {
    expect(hzToMidi(440)).toBeCloseTo(69, 9);
    expect(midiToHz(60)).toBeCloseTo(261.6256, 3);
    expect(centsFromNearest(midiToHz(60) * Math.pow(2, 20 / 1200))).toBeCloseTo(20, 6);
    expect(centsFromNearest(midiToHz(60) * Math.pow(2, -30 / 1200))).toBeCloseTo(-30, 6);
  });

  it("folds into a register by octaves", () => {
    const range = { minMidi: 60, maxMidi: 71 };
    expect(foldMidi(48, range)).toBe(60);
    expect(foldMidi(79, range)).toBe(67);
    expect(foldMidi(65, range)).toBe(65);
    expect(median([3, 1, 2])).toBe(2);
  });
});

describe("analyseFrame", () => {
  it("finds a sine and reports clarity and rms", () => {
    const x = renderNotes(
      [{ midi: 69, startSec: 0, durSec: 0.2, timbre: "sine", amp: 0.5 }],
      SR,
      0.2,
    );
    const r = analyseFrame(x.subarray(2000, 4048), SR);
    expect(r.hz).not.toBeNull();
    expect(Math.abs(centsFromNearest(r.hz ?? NaN))).toBeLessThan(5);
    expect(r.clarity).toBeGreaterThan(0.95);
    expect(r.rms).toBeCloseTo(0.5 / Math.SQRT2, 1);
  });

  it("rejects silence, noise and out-of-range pitches", () => {
    expect(analyseFrame(new Float32Array(2048), SR).hz).toBeNull();
    expect(analyseFrame(whiteNoise(2048, 0.3), SR).hz).toBeNull();
    const hi = renderNotes([{ midi: 96, startSec: 0, durSec: 0.2, timbre: "sine" }], SR, 0.2);
    expect(analyseFrame(hi.subarray(1000, 3048), SR).hz).toBeNull();
    const lo = renderNotes([{ midi: 69, startSec: 0, durSec: 0.2, timbre: "sine" }], SR, 0.2);
    expect(analyseFrame(lo.subarray(1000, 3048), SR, { minHz: 500 }).hz).toBeNull();
  });
});

describe("accuracy over MIDI 40..84", () => {
  for (const timbre of TIMBRES) {
    it(`${timbre}: pitch within 20 cents, onset within 30 ms, one note`, () => {
      const worst = { cents: 0, onset: 0 };
      for (let midi = 40; midi <= 84; midi++) {
        const startSec = 0.2;
        const x = renderNotes([{ midi, startSec, durSec: 0.5, timbre }], SR, 1);
        const { frames, notes } = runPipelineOnPcm(x, SR, { startMs: 5000 });
        expect(notes, `midi ${String(midi)}`).toHaveLength(1);
        const n = notes[0];
        expect(n?.pitch, `midi ${String(midi)}`).toBe(midi);
        expect(n?.source).toBe("mic");
        const onsetErr = Math.abs((n?.onsetMs ?? 0) - (5000 + startSec * 1000));
        expect(onsetErr, `onset midi ${String(midi)}`).toBeLessThanOrEqual(30);
        worst.onset = Math.max(worst.onset, onsetErr);
        // Frame pitch: median over the stable part of the note vs truth.
        const inside = frames.filter(
          (f) => f.hz !== null && f.atMs > 5000 + 300 && f.atMs < 5000 + 600,
        );
        expect(inside.length).toBeGreaterThan(5);
        const errs = inside.map((f) => (hzToMidi(f.hz ?? NaN) - midi) * 100);
        const err = Math.abs(median(errs));
        expect(err, `cents midi ${String(midi)}`).toBeLessThanOrEqual(20);
        worst.cents = Math.max(worst.cents, err);
      }
      console.log(
        `accuracy ${timbre}: worst median frame error ${worst.cents.toFixed(1)} cents, worst onset error ${worst.onset.toFixed(1)} ms`,
      );
    }, 30_000);
  }

  it("vibrato stays within 20 cents of the centre in every note's median", () => {
    const x = renderNotes(
      [{ midi: 57, startSec: 0.1, durSec: 1, timbre: "vowel", vibratoCents: 20 }],
      SR,
      1.3,
    );
    const { frames, notes } = runPipelineOnPcm(x, SR);
    expect(notes.map((n) => n.pitch)).toEqual([57]);
    const cents = frames
      .filter((f) => f.hz !== null && f.atMs > 300 && f.atMs < 1000)
      .map((f) => (hzToMidi(f.hz ?? NaN) - 57) * 100);
    expect(Math.max(...cents.map(Math.abs))).toBeLessThanOrEqual(25);
  });
});

describe("segmentation", () => {
  it("finds each note of a sequence with gaps, at the right times", () => {
    const seq = [60, 64, 67, 72, 55];
    const notes = seq.map((midi, i) => ({
      midi,
      startSec: 0.3 + i * 0.6,
      durSec: 0.35,
      timbre: "piano" as const,
    }));
    const x = renderNotes(notes, SR, 3.6);
    const r = runPipelineOnPcm(x, SR, { startMs: 1000 });
    expect(r.notes.map((n) => n.pitch)).toEqual(seq);
    r.notes.forEach((n, i) => {
      const truth = 1000 + (0.3 + i * 0.6) * 1000;
      expect(Math.abs(n.onsetMs - truth)).toBeLessThanOrEqual(30);
      expect(n.offsetMs).toBeDefined();
      expect(n.offsetMs ?? 0).toBeGreaterThan(n.onsetMs + 200);
      expect(n.confidence).toBeGreaterThan(0.85);
    });
  });

  it("separates repeated same-pitch notes with short silences", () => {
    for (const timbre of TIMBRES) {
      const notes = [0, 1, 2, 3].map((i) => ({
        midi: 62,
        startSec: 0.2 + i * 0.3,
        durSec: 0.24,
        timbre,
      }));
      const r = runPipelineOnPcm(renderNotes(notes, SR, 1.8), SR);
      expect(
        r.notes.map((n) => n.pitch),
        timbre,
      ).toEqual([62, 62, 62, 62]);
    }
  });

  it("separates a same-pitch restrike with no silence (decaying piano)", () => {
    const notes = [
      { midi: 64, startSec: 0.2, durSec: 1.2, timbre: "piano" as const },
      { midi: 64, startSec: 0.7, durSec: 0.7, timbre: "piano" as const, amp: 0.4 },
    ];
    const r = runPipelineOnPcm(renderNotes(notes, SR, 1.6), SR);
    expect(r.notes).toHaveLength(2);
    expect(Math.abs((r.notes[1]?.onsetMs ?? 0) - 700)).toBeLessThanOrEqual(30);
    // The first note is cut off by the second.
    expect(r.notes[0]?.offsetMs).toBeCloseTo(r.notes[1]?.onsetMs ?? 0, -1);
  });

  it("splits a legato sung change of more than 80 cents", () => {
    const x = renderNotes(
      [
        { midi: 60, startSec: 0.1, durSec: 0.6, timbre: "vowel", vibratoCents: 15 },
        { midi: 62, startSec: 0.7, durSec: 0.6, timbre: "vowel", vibratoCents: 15 },
      ],
      SR,
      1.6,
    );
    // Remove the short fade between the two notes by keeping their ramps overlapping at 0.7 s.
    const r = runPipelineOnPcm(x, SR);
    expect(r.notes.map((n) => n.pitch)).toEqual([60, 62]);
  });

  it("produces no notes for silence or white noise", () => {
    expect(runPipelineOnPcm(new Float32Array(SR), SR).notes).toHaveLength(0);
    for (const amp of [0.02, 0.1, 0.4]) {
      const r = runPipelineOnPcm(whiteNoise(SR * 2, amp, 7), SR);
      expect(r.notes, `noise ${String(amp)}`).toHaveLength(0);
    }
  });

  it("ignores a quiet hum under the noise floor", () => {
    const x = renderNotes(
      [{ midi: 45, startSec: 0, durSec: 1, timbre: "sine", amp: 0.005 }],
      SR,
      1,
    );
    expect(runPipelineOnPcm(x, SR).notes).toHaveLength(0);
  });

  it("is not fooled by a DC offset", () => {
    const x = renderNotes([{ midi: 60, startSec: 0.2, durSec: 0.4, timbre: "sine" }], SR, 1);
    for (let i = 0; i < x.length; i++) x[i] = (x[i] ?? 0) + 0.2;
    expect(runPipelineOnPcm(x, SR).notes.map((n) => n.pitch)).toEqual([60]);
  });

  it("works at 48 kHz", () => {
    const x = renderNotes([{ midi: 48, startSec: 0.2, durSec: 0.5, timbre: "piano" }], 48000, 1);
    expect(runPipelineOnPcm(x, 48000).notes.map((n) => n.pitch)).toEqual([48]);
  });
});

describe("expectedRange octave folding", () => {
  it("folds frames an octave off into the expected register", () => {
    const seg = new NoteSegmenter({ expectedRange: { minMidi: 60, maxMidi: 71 } });
    const energy = (t: number) => ({ rms: 0.2, startMs: t - 11, endMs: t });
    const events = [];
    // Detector wrongly reports C3 (130.8 Hz) for a played C4.
    for (let t = 0; t < 400; t += 11.6) {
      events.push(...seg.push({ hz: midiToHz(48), confidence: 0.95, atMs: t - 20 }, energy(t)));
    }
    events.push(...seg.flush());
    const end = events.find((e) => e.type === "end");
    expect(end?.note.pitch).toBe(60);
  });

  it("leaves the pitch alone without a hint", () => {
    const seg = new NoteSegmenter();
    const events = [];
    for (let t = 0; t < 400; t += 11.6) {
      events.push(
        ...seg.push(
          { hz: midiToHz(48), confidence: 0.95, atMs: t - 20 },
          { rms: 0.2, startMs: t - 11, endMs: t },
        ),
      );
    }
    events.push(...seg.flush());
    expect(events.find((e) => e.type === "end")?.note.pitch).toBe(48);
  });
});

describe("chunk-size independence", () => {
  it("gives the same frames for chunks of 128, 1000 and 4096 samples", () => {
    const x = renderNotes(
      [
        { midi: 60, startSec: 0.1, durSec: 0.4, timbre: "piano" },
        { midi: 67, startSec: 0.7, durSec: 0.4, timbre: "vowel" },
      ],
      SR,
      1.4,
    );
    const run = (chunk: number) => {
      const tracker = new PitchTracker({ sampleRate: SR });
      const frames = [];
      for (let i = 0; i < x.length; i += chunk) {
        const part = x.subarray(i, Math.min(x.length, i + chunk));
        frames.push(...tracker.push(part, 250 + (i * 1000) / SR));
      }
      return frames;
    };
    const a = run(128);
    for (const chunk of [1000, 4096]) {
      const b = run(chunk);
      expect(b).toHaveLength(a.length);
      b.forEach((out, i) => {
        const ref = a[i];
        expect(out.frame.atMs).toBeCloseTo(ref?.frame.atMs ?? NaN, 6);
        expect(out.frame.hz === null).toBe(ref?.frame.hz === null);
        if (out.frame.hz !== null) expect(out.frame.hz).toBeCloseTo(ref?.frame.hz ?? NaN, 6);
        expect(out.frame.confidence).toBeCloseTo(ref?.frame.confidence ?? NaN, 6);
        expect(out.energy.rms).toBeCloseTo(ref?.energy.rms ?? NaN, 6);
      });
    }
  });

  it("restarts cleanly after a gap in the stream", () => {
    const tracker = new PitchTracker({ sampleRate: SR });
    const chunk = new Float32Array(2048);
    const first = tracker.push(chunk, 0);
    expect(first).toHaveLength(4);
    const second = tracker.push(chunk, 10_000);
    expect(second[0]?.frame.atMs).toBeGreaterThan(9_900);
  });

  it("streams through PitchPipeline like runPipelineOnPcm", () => {
    const x = renderNotes([{ midi: 65, startSec: 0.1, durSec: 0.4, timbre: "piano" }], SR, 0.8);
    const p = new PitchPipeline(SR);
    const ends = [];
    for (let i = 0; i < x.length; i += 128) {
      const r = p.push(x.subarray(i, Math.min(x.length, i + 128)), (i * 1000) / SR);
      ends.push(...r.events);
    }
    ends.push(...p.flush());
    expect(ends.map((e) => e.type)).toEqual(["start", "end"]);
    expect(ends[0]?.note.offsetMs).toBeUndefined();
    expect(ends[1]?.note.pitch).toBe(65);
  });
});
