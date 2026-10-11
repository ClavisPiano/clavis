import {
  FakeInputAdapter,
  MicInputAdapter,
  TapInputAdapter,
  getAudioContextManager,
  type CaptureContext,
  type FakeClock,
  type InputAdapter,
} from "@clavis/audio";
import type { ExpectedResponse, NoteEvent, PitchFrame } from "@clavis/core";
import { createMicPitchSource } from "@clavis/audio/web";
import type { SessionMode } from "./session-mode";

export type InputKind = "mic" | "tap" | "fake";

const KINDS: readonly string[] = ["mic", "tap", "fake"];

export const INPUT_STORAGE_KEY = "clavisInput";

function asKind(value: string | null | undefined): InputKind | undefined {
  return value !== null && value !== undefined && KINDS.includes(value)
    ? (value as InputKind)
    : undefined;
}

/**
 * Pick the adapter kind. Precedence: `?input=` query, then `localStorage.clavisInput`, then the
 * session mode (instrument -> mic, away -> tap). Unknown values are ignored.
 */
export function resolveInputKind(
  mode: SessionMode,
  searchParams: { get(name: string): string | null },
  storedValue?: string | null,
): InputKind {
  return (
    asKind(searchParams.get("input")) ?? asKind(storedValue) ?? (mode === "away" ? "tap" : "mic")
  );
}

/** What Playwright (and T2.9 E2E) drive. Only exists when fake input was requested explicitly. */
export interface FakeInputHook {
  emitNote(midi: number, opts?: Partial<NoteEvent>): NoteEvent | undefined;
  emitFrame(frame?: Partial<PitchFrame>): PitchFrame | undefined;
  /** Current time on the fake adapter's clock (performance.now), for building `onsetMs`. */
  nowMs(): number;
}

/** What Playwright reads to answer a session item. Only present in fake mode. */
export interface SessionHook {
  phase: string;
  expected: ExpectedResponse | undefined;
  stimulusEndMs: number | undefined;
  phaseStartMs: number | undefined;
}

declare global {
  interface Window {
    __clavisFakeInput?: FakeInputHook;
    __clavisSession?: SessionHook;
  }
}

export interface InputHandle {
  kind: InputKind;
  adapter: InputAdapter;
  /** Set for "tap": the keyboard component feeds this. */
  tap?: TapInputAdapter;
}

export interface CreateInputDeps {
  /** Where to attach the fake hook. Defaults to `window`. */
  target?: { __clavisFakeInput?: FakeInputHook | undefined };
  /**
   * Clock for the fake adapter. The session runner passes the clock its stimulus times come from,
   * so `nowMs()` and `onsetMs` are comparable with `stimulusEndMs`. Default `performance.now`.
   */
  clock?: FakeClock;
}

/** Build the adapter for `kind` on the shared AudioContext. */
export function createInput(kind: InputKind, deps: CreateInputDeps = {}): InputHandle {
  const audio = getAudioContextManager();
  if (kind === "tap") {
    const tap = new TapInputAdapter({
      getContext: () => audio.getContext(),
    });
    return { kind, adapter: tap, tap };
  }
  if (kind === "fake") {
    const fake = new FakeInputAdapter({
      source: "mic",
      ...(deps.clock ? { clock: deps.clock } : {}),
    });
    // Only reached when the caller asked for fake input explicitly (see resolveInputKind).
    const target = deps.target ?? (typeof window === "undefined" ? undefined : window);
    if (target) {
      target.__clavisFakeInput = {
        emitNote: (midi, opts) => fake.emitNote({ ...opts, pitch: midi }),
        emitFrame: (frame) => fake.emitFrame(frame),
        nowMs: () => fake.nowMs(),
      };
    }
    return { kind, adapter: fake };
  }
  return {
    kind,
    adapter: new MicInputAdapter({
      source: createMicPitchSource(),
      getContext: async () => {
        await audio.unlock();
        return audio.getContext() as unknown as CaptureContext;
      },
    }),
  };
}

/** Remove the fake hook (page teardown). */
export function detachFakeInput(
  target: { __clavisFakeInput?: FakeInputHook | undefined } = window,
): void {
  delete target.__clavisFakeInput;
}
