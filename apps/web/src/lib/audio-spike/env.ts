/** Browser environment probe for the /dev/audio spike. Reads globals, so it is not unit tested. */

interface AudioSessionLike {
  type: string;
}

type SessionNavigator = Navigator & { audioSession?: AudioSessionLike; standalone?: boolean };

export const SESSION_TYPES = ["auto", "playback", "play-and-record", "ambient"] as const;
export type SessionType = (typeof SESSION_TYPES)[number];

export function getAudioSession(): AudioSessionLike | undefined {
  return (navigator as SessionNavigator).audioSession;
}

export function currentSessionType(): string {
  return getAudioSession()?.type ?? "unsupported";
}

/** Returns an error message, or undefined on success. */
export function applySessionType(type: SessionType): string | undefined {
  const session = getAudioSession();
  if (!session) return "navigator.audioSession is not available";
  try {
    session.type = type;
    return undefined;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

export function isStandalone(): boolean {
  const nav = navigator as SessionNavigator;
  return nav.standalone === true || matchMedia("(display-mode: standalone)").matches;
}

function secs(v: number | undefined): string {
  return v === undefined ? "n/a" : `${(v * 1000).toFixed(1)} ms`;
}

export function collectEnvironment(ctx: AudioContext | undefined): Record<string, string> {
  return {
    "User agent": navigator.userAgent,
    "Standalone (installed PWA)": isStandalone() ? "yes" : "no",
    Viewport: `${String(innerWidth)}x${String(innerHeight)} @${String(devicePixelRatio)}x`,
    "AudioContext state": ctx?.state ?? "not created",
    sampleRate: ctx ? `${String(ctx.sampleRate)} Hz` : "n/a",
    baseLatency: ctx ? secs(ctx.baseLatency) : "n/a",
    outputLatency: ctx ? secs((ctx as { outputLatency?: number }).outputLatency) : "n/a",
    "navigator.audioSession": getAudioSession() ? `yes (type ${currentSessionType()})` : "no",
    AudioWorklet: typeof AudioWorkletNode === "function" ? "yes" : "no",
    getUserMedia:
      "mediaDevices" in navigator && typeof navigator.mediaDevices.getUserMedia === "function"
        ? "yes"
        : "no",
  };
}
