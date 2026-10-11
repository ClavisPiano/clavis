import { median, toDb } from "./dsp";

export interface LogEntry {
  readonly time: string;
  readonly message: string;
}

export interface BleedResult {
  /** Peak input RMS over the silent window before playback. */
  readonly silencePeak: number;
  /** Peak input RMS while the cadence played. */
  readonly playbackPeak: number;
}

export interface ReportData {
  readonly generatedAt: string;
  readonly environment: Readonly<Record<string, string>>;
  readonly sessionType: { readonly requested: string; readonly current: string };
  readonly volumeNote: string;
  readonly micRequested: Readonly<Record<string, boolean>> | undefined;
  readonly micSettings: Readonly<Record<string, unknown>> | undefined;
  readonly bleed: BleedResult | undefined;
  /** One entry per run, null when no spike was detected. */
  readonly latencyRunsMs: readonly (number | null)[];
  readonly worklet: {
    readonly heartbeats: number;
    readonly lastContextTime: number | undefined;
    readonly gaps: readonly { readonly atMs: number; readonly gapMs: number }[];
  };
  readonly notes: string;
  readonly log: readonly LogEntry[];
}

function fmt(n: number, digits = 1): string {
  return n.toFixed(digits);
}

function table(rows: readonly (readonly [string, string])[]): string[] {
  return ["| Item | Value |", "| --- | --- |", ...rows.map(([k, v]) => `| ${k} | ${v} |`)];
}

function cell(v: unknown): string {
  return typeof v === "string" ? v : JSON.stringify(v);
}

/** Markdown block to paste under a run heading in docs/spikes/ios-audio.md. */
export function buildReport(d: ReportData): string {
  const out: string[] = [];
  out.push(`### Report ${d.generatedAt}`, "");
  out.push("**Environment**", "");
  out.push(...table(Object.entries(d.environment)), "");

  out.push("**Audio session and playback**", "");
  out.push(
    ...table([
      ["audioSession.type requested", d.sessionType.requested],
      ["audioSession.type current", d.sessionType.current],
      ["Volume note", d.volumeNote.trim() || "(none)"],
    ]),
    "",
  );

  out.push("**Microphone**", "");
  if (d.micRequested || d.micSettings) {
    out.push(
      ...table([
        ["Requested", d.micRequested ? cell(d.micRequested) : "(mic not started)"],
        ...Object.entries(d.micSettings ?? {}).map(([k, v]): readonly [string, string] => [
          `Applied ${k}`,
          cell(v),
        ]),
      ]),
      "",
    );
  } else {
    out.push("Mic not started.", "");
  }

  out.push("**Playback while mic open**", "");
  if (d.bleed) {
    const delta = toDb(d.bleed.playbackPeak) - toDb(d.bleed.silencePeak);
    out.push(
      ...table([
        ["Peak input, silence", `${fmt(toDb(d.bleed.silencePeak))} dBFS`],
        ["Peak input, during cadence", `${fmt(toDb(d.bleed.playbackPeak))} dBFS`],
        ["Difference", `${fmt(delta)} dB`],
      ]),
      "",
    );
  } else {
    out.push("Not run.", "");
  }

  out.push("**Latency probe (speaker to mic loopback, rough)**", "");
  if (d.latencyRunsMs.length === 0) {
    out.push("Not run.", "");
  } else {
    const found = d.latencyRunsMs.filter((v): v is number => v !== null);
    const med = median(found);
    out.push(
      ...table([
        ["Runs (ms)", d.latencyRunsMs.map((v) => (v === null ? "none" : fmt(v, 0))).join(", ")],
        ["Median (ms)", med === undefined ? "n/a" : fmt(med, 0)],
      ]),
      "",
    );
  }

  out.push("**AudioWorklet heartbeat**", "");
  out.push(
    ...table([
      ["Heartbeats", String(d.worklet.heartbeats)],
      [
        "Last context time (s)",
        d.worklet.lastContextTime === undefined ? "n/a" : fmt(d.worklet.lastContextTime, 2),
      ],
      [
        "Gaps over 1.5 s",
        d.worklet.gaps.length === 0
          ? "none"
          : d.worklet.gaps.map((g) => `${fmt(g.gapMs / 1000, 1)} s`).join(", "),
      ],
    ]),
    "",
  );

  if (d.notes.trim()) out.push("**Notes**", "", d.notes.trim(), "");

  out.push("**Event log**", "", "```");
  out.push(...(d.log.length === 0 ? ["(empty)"] : d.log.map((e) => `${e.time} ${e.message}`)));
  out.push("```", "");
  return out.join("\n");
}
