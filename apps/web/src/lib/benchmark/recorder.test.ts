import { describe, expect, it } from "vitest";
import { pickRecorderType, startRecording, type RecorderEnv } from "./recorder";

describe("pickRecorderType", () => {
  it.each<[string, string[], string | undefined]>([
    [
      "Chromium and Firefox: Opus in WebM",
      ["audio/webm;codecs=opus", "audio/webm"],
      "audio/webm;codecs=opus",
    ],
    ["WebM without a codec list", ["audio/webm"], "audio/webm"],
    ["Safari: MP4", ["audio/mp4", "audio/mp4;codecs=mp4a.40.2"], "audio/mp4;codecs=mp4a.40.2"],
    ["only plain MP4", ["audio/mp4"], "audio/mp4"],
    ["nothing known: browser default", ["audio/x-other"], undefined],
  ])("%s", (_name, supported, expected) => {
    expect(pickRecorderType((t) => supported.includes(t))).toBe(expected);
  });

  it("treats a throwing check as unsupported", () => {
    expect(
      pickRecorderType((t) => {
        if (t.startsWith("audio/webm")) throw new Error("nope");
        return true;
      }),
    ).toBe("audio/mp4;codecs=mp4a.40.2");
  });
});

/** A scripted MediaRecorder: `stop` emits one chunk, then `stop`. */
function fakeEnv(opts: { mimeType?: string; supported?: string[] } = {}) {
  let clock = 0;
  const timers: { fn: () => void; ms: number }[] = [];
  const stopped: boolean[] = [];
  const track = {
    stop: () => {
      stopped.push(true);
    },
  };
  const stream = { getTracks: () => [track] } as unknown as MediaStream;
  let lastOptions: MediaRecorderOptions | undefined;

  class FakeRecorder extends EventTarget {
    state: RecordingState = "inactive";
    mimeType: string;
    constructor(_s: MediaStream, options?: MediaRecorderOptions) {
      super();
      lastOptions = options;
      this.mimeType = opts.mimeType ?? options?.mimeType ?? "";
    }
    static isTypeSupported(t: string): boolean {
      return (opts.supported ?? ["audio/webm;codecs=opus"]).includes(t);
    }
    start(): void {
      this.state = "recording";
    }
    stop(): void {
      this.state = "inactive";
      const data = new Blob([new Uint8Array(10)], { type: this.mimeType });
      this.dispatchEvent(Object.assign(new Event("dataavailable"), { data }));
      this.dispatchEvent(new Event("stop"));
    }
  }

  const env: RecorderEnv = {
    getUserMedia: () => Promise.resolve(stream),
    MediaRecorder: FakeRecorder as unknown as RecorderEnv["MediaRecorder"],
    now: () => clock,
    setTimeout: (fn, ms) => {
      timers.push({ fn, ms });
      return timers.length;
    },
    clearTimeout: () => undefined,
  };
  return {
    env,
    advance: (ms: number) => {
      clock += ms;
    },
    timers,
    stopped,
    options: () => lastOptions,
  };
}

describe("startRecording", () => {
  it("records Opus WebM and reports the base type and duration", async () => {
    const f = fakeEnv();
    const rec = await startRecording(f.env);
    expect(f.options()).toEqual({ mimeType: "audio/webm;codecs=opus" });
    f.advance(4200);
    const take = await rec.stop();
    expect(take).toMatchObject({ contentType: "audio/webm", durationMs: 4200 });
    expect(take.blob.size).toBe(10);
    expect(f.stopped).toEqual([true]);
  });

  it("stops by itself at the limit", async () => {
    const f = fakeEnv({ supported: ["audio/mp4"] });
    const rec = await startRecording(f.env, 180_000);
    expect(f.timers[0]?.ms).toBe(180_000);
    f.advance(180_050);
    f.timers[0]?.fn();
    const take = await rec.done;
    expect(take).toMatchObject({ contentType: "audio/mp4", durationMs: 180_000 });
  });

  it("rejects a type the server does not accept", async () => {
    const f = fakeEnv({ supported: [], mimeType: "audio/x-unknown" });
    const rec = await startRecording(f.env);
    await expect(rec.stop()).rejects.toThrow("audio/x-unknown");
  });

  it("cancel releases the microphone and discards the take", async () => {
    const f = fakeEnv();
    const rec = await startRecording(f.env);
    rec.cancel();
    await expect(rec.done).rejects.toThrow("cancelled");
    expect(f.stopped).toEqual([true]);
  });
});
