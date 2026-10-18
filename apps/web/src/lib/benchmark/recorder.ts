import { MAX_BENCHMARK_MS, baseContentType, isAllowedBlobType } from "@clavis/core";

/*
 * Benchmark capture (T6.5, R28) with `MediaRecorder`: Opus in WebM where supported, MP4 (Safari)
 * otherwise. Browser objects are injected so the logic tests without a microphone.
 */

/** Tried in order with `MediaRecorder.isTypeSupported`. */
export const RECORDER_TYPES = [
  "audio/webm;codecs=opus",
  "audio/webm",
  "audio/mp4;codecs=mp4a.40.2",
  "audio/mp4",
] as const;

/** The first supported recorder type, or undefined to let the browser choose. */
export function pickRecorderType(isTypeSupported: (type: string) => boolean): string | undefined {
  return RECORDER_TYPES.find((t) => {
    try {
      return isTypeSupported(t);
    } catch {
      return false;
    }
  });
}

/** Piano audio: no echo cancellation, noise suppression or gain control, which all damage music. */
export const MUSIC_CONSTRAINTS: MediaTrackConstraints = {
  echoCancellation: false,
  noiseSuppression: false,
  autoGainControl: false,
};

export interface Take {
  blob: Blob;
  /** Without codec parameters, one the blob store accepts. */
  contentType: string;
  durationMs: number;
}

export interface RecorderEnv {
  getUserMedia: (constraints: MediaStreamConstraints) => Promise<MediaStream>;
  MediaRecorder: {
    new (stream: MediaStream, options?: MediaRecorderOptions): MediaRecorder;
    isTypeSupported(type: string): boolean;
  };
  now: () => number;
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
}

export interface Recording {
  /** Stop and resolve with the take. Calling it again returns the same promise. */
  stop(): Promise<Take>;
  /** Stop and throw the take away (leaving the page, for example). */
  cancel(): void;
  /** Resolves with the take when recording ends, by `stop` or by reaching the time limit. */
  readonly done: Promise<Take>;
}

export function browserRecorderEnv(): RecorderEnv | undefined {
  if (
    typeof MediaRecorder === "undefined" ||
    !("mediaDevices" in navigator) ||
    typeof navigator.mediaDevices.getUserMedia !== "function"
  ) {
    return undefined;
  }
  return {
    getUserMedia: (c) => navigator.mediaDevices.getUserMedia(c),
    MediaRecorder,
    now: () => performance.now(),
    setTimeout: (fn, ms) => window.setTimeout(fn, ms),
    clearTimeout: (h) => {
      window.clearTimeout(h as number);
    },
  };
}

/**
 * Ask for the microphone and start recording. Recording stops by itself at `maxMs` (three minutes).
 * Rejects when the microphone is refused or the browser records in a type the server does not take.
 */
export async function startRecording(
  env: RecorderEnv,
  maxMs: number = MAX_BENCHMARK_MS,
): Promise<Recording> {
  const stream = await env.getUserMedia({ audio: MUSIC_CONSTRAINTS });
  const release = (): void => {
    for (const track of stream.getTracks()) track.stop();
  };
  let recorder: MediaRecorder;
  try {
    const mimeType = pickRecorderType((t) => env.MediaRecorder.isTypeSupported(t));
    recorder = new env.MediaRecorder(stream, mimeType === undefined ? {} : { mimeType });
  } catch (error) {
    release();
    throw error;
  }
  const chunks: Blob[] = [];
  let startedAt = env.now();
  let cancelled = false;
  recorder.addEventListener("dataavailable", (e) => {
    if (e.data.size > 0) chunks.push(e.data);
  });
  const done = new Promise<Take>((resolve, reject) => {
    recorder.addEventListener("stop", () => {
      env.clearTimeout(timer);
      release();
      if (cancelled) {
        reject(new Error("recording cancelled"));
        return;
      }
      const recorded = recorder.mimeType !== "" ? recorder.mimeType : (chunks[0]?.type ?? "");
      const contentType = baseContentType(recorded);
      if (!isAllowedBlobType(contentType)) {
        reject(new Error(`this browser records ${contentType || "an unknown type"}`));
        return;
      }
      const durationMs = Math.round(Math.min(maxMs, Math.max(1, env.now() - startedAt)));
      resolve({ blob: new Blob(chunks, { type: contentType }), contentType, durationMs });
    });
    recorder.addEventListener("error", () => {
      env.clearTimeout(timer);
      release();
      reject(new Error("recording failed"));
    });
  });
  // Keep an unhandled rejection from a cancel quiet; callers that await `done` still see it.
  done.catch(() => undefined);
  const timer = env.setTimeout(() => {
    if (recorder.state !== "inactive") recorder.stop();
  }, maxMs);
  // A timeslice keeps the take in chunks, so a long recording is not one huge buffer at the end.
  recorder.start(1000);
  startedAt = env.now();
  return {
    stop() {
      if (recorder.state !== "inactive") recorder.stop();
      return done;
    },
    cancel() {
      cancelled = true;
      if (recorder.state !== "inactive") recorder.stop();
      else release();
    },
    done,
  };
}
