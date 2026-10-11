import { describe, expect, it } from "vitest";
import { buildReport, type ReportData } from "./report";

const base: ReportData = {
  generatedAt: "2026-01-01T00:00:00Z",
  environment: { "User agent": "UA", sampleRate: "48000 Hz" },
  sessionType: { requested: "play-and-record", current: "play-and-record" },
  volumeNote: "",
  micRequested: undefined,
  micSettings: undefined,
  bleed: undefined,
  latencyRunsMs: [],
  worklet: { heartbeats: 0, lastContextTime: undefined, gaps: [] },
  notes: "",
  log: [],
};

describe("buildReport", () => {
  it("renders an empty run without throwing", () => {
    const md = buildReport(base);
    expect(md).toContain("### Report 2026-01-01T00:00:00Z");
    expect(md).toContain("| sampleRate | 48000 Hz |");
    expect(md).toContain("Mic not started.");
    expect(md).toContain("(empty)");
    expect(md).not.toContain("**Notes**");
  });

  it("renders measurements", () => {
    const md = buildReport({
      ...base,
      volumeNote: "quieter",
      micRequested: { echoCancellation: false },
      micSettings: { echoCancellation: true, sampleRate: 48000 },
      bleed: { silencePeak: 0.01, playbackPeak: 0.1 },
      latencyRunsMs: [100, 120, null, 110, 130],
      worklet: { heartbeats: 42, lastContextTime: 41.5, gaps: [{ atMs: 5000, gapMs: 8000 }] },
      notes: "hello",
      log: [{ time: "10:00:00.000", message: "visibilitychange hidden" }],
    });
    expect(md).toContain("| Volume note | quieter |");
    expect(md).toContain("| Applied echoCancellation | true |");
    expect(md).toContain("| Difference | 20.0 dB |");
    expect(md).toContain("| Runs (ms) | 100, 120, none, 110, 130 |");
    expect(md).toContain("| Median (ms) | 115 |");
    expect(md).toContain("| Heartbeats | 42 |");
    expect(md).toContain("8.0 s");
    expect(md).toContain("10:00:00.000 visibilitychange hidden");
  });
});
