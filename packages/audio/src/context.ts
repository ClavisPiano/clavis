/**
 * Single shared AudioContext manager.
 *
 * Browsers (iOS Safari above all) start a context suspended, may put it in a non-standard
 * "interrupted" state when the page is backgrounded or a call arrives, and only allow resume()
 * from a user gesture. The manager creates the context lazily, exposes `unlock()` to call from a
 * gesture handler, and resumes on `visibilitychange` and `pageshow`.
 *
 * The context constructor and the document/window are injected so this runs in Node with fakes.
 */

/** Standard states plus the iOS-only "interrupted". */
export type ContextState = "suspended" | "running" | "closed" | "interrupted";
/** Manager state: the context state, or "uninitialized" before the context exists. */
export type ManagerState = ContextState | "uninitialized";

/** The slice of AudioContext this package uses. Real AudioContext instances satisfy it. */
export interface AudioContextLike {
  readonly currentTime: number;
  readonly state: string;
  resume(): Promise<void>;
  close(): Promise<void>;
  addEventListener(type: "statechange", listener: () => void): void;
  removeEventListener(type: "statechange", listener: () => void): void;
  /** Used by the iOS silent-buffer unlock. Optional so minimal fakes can omit them. */
  readonly destination?: unknown;
  createBuffer?(channels: number, length: number, sampleRate: number): unknown;
  createBufferSource?(): {
    buffer: unknown;
    connect(destination: unknown): unknown;
    start(when?: number): void;
  };
}

export interface EventTargetLike {
  addEventListener(type: string, listener: () => void): void;
  removeEventListener(type: string, listener: () => void): void;
}

export interface DocumentLike extends EventTargetLike {
  readonly visibilityState?: string;
}

export interface AudioContextManagerOptions {
  /** Creates the context. Defaults to `new AudioContext()` (or `webkitAudioContext`). */
  createContext?: () => AudioContextLike;
  /** Defaults to the global `document`, if any. */
  document?: DocumentLike | undefined;
  /** Defaults to the global `window`, if any. */
  window?: EventTargetLike | undefined;
  /**
   * Safari 17+ `navigator.audioSession`. `unlock()` sets `type = "playback"` so Web Audio plays
   * through the iPhone silent switch, or `"play-and-record"` once capture is needed: iOS refuses
   * `getUserMedia` under `playback`. Defaults to the global navigator's, if present.
   */
  audioSession?: { type: string } | undefined;
}

export type StateListener = (state: ManagerState) => void;

/** AudioContext, or the prefixed constructor on old Safari. */
function defaultCreateContext(): AudioContextLike {
  const g = globalThis as unknown as {
    AudioContext?: new () => AudioContextLike;
    webkitAudioContext?: new () => AudioContextLike;
  };
  const Ctor = g.AudioContext ?? g.webkitAudioContext;
  if (!Ctor) throw new Error("Web Audio is not available in this environment");
  return new Ctor();
}

export class AudioContextManager {
  readonly #createContext: () => AudioContextLike;
  readonly #document: DocumentLike | undefined;
  readonly #window: EventTargetLike | undefined;
  readonly #audioSession: { type: string } | undefined;
  readonly #listeners = new Set<StateListener>();
  #context: AudioContextLike | undefined;
  #lastState: ManagerState = "uninitialized";
  #disposers: (() => void)[] = [];
  #capture = false;

  constructor(options: AudioContextManagerOptions = {}) {
    this.#createContext = options.createContext ?? defaultCreateContext;
    const g = globalThis as unknown as {
      document?: DocumentLike;
      window?: EventTargetLike;
      navigator?: { audioSession?: { type: string } };
    };
    this.#document = "document" in options ? options.document : g.document;
    this.#window = "window" in options ? options.window : g.window;
    this.#audioSession =
      "audioSession" in options ? options.audioSession : g.navigator?.audioSession;
  }

  /** The shared context, created on first call. Idempotent. */
  getContext(): AudioContextLike {
    if (this.#context) return this.#context;
    const ctx = this.#createContext();
    this.#context = ctx;
    this.#lastState = this.state;
    const onState = (): void => {
      this.#emit();
    };
    ctx.addEventListener("statechange", onState);
    this.#disposers.push(() => {
      ctx.removeEventListener("statechange", onState);
    });
    const onWake = (): void => {
      if (this.#document?.visibilityState === "hidden") return;
      this.#resumeQuietly();
    };
    for (const [target, type] of [
      [this.#document, "visibilitychange"],
      [this.#window, "pageshow"],
    ] as const) {
      if (!target) continue;
      target.addEventListener(type, onWake);
      this.#disposers.push(() => {
        target.removeEventListener(type, onWake);
      });
    }
    return ctx;
  }

  /** Context time in seconds, or 0 before the context exists. */
  get currentTime(): number {
    return this.#context?.currentTime ?? 0;
  }

  get state(): ManagerState {
    return this.#context ? (this.#context.state as ContextState) : "uninitialized";
  }

  /**
   * Call synchronously from a user gesture handler (tap, click). Creates the context if needed,
   * resumes it, and plays a one-sample silent buffer, which iOS still needs on some versions to
   * start output. Safe to call repeatedly. Resolves with the resulting state.
   *
   * Pass `capture: true` before opening the microphone. It is sticky for the manager's lifetime:
   * switching the iOS audio session category back and forth interrupts a running context.
   */
  unlock(options: { capture?: boolean } = {}): Promise<ManagerState> {
    if (options.capture) this.#capture = true;
    if (this.#audioSession) {
      const type = this.#capture ? "play-and-record" : "playback";
      try {
        if (this.#audioSession.type !== type) this.#audioSession.type = type;
      } catch {
        // Unsupported value: ignore, Web Audio still works with the silent switch off.
      }
    }
    const ctx = this.getContext();
    // Both calls happen synchronously inside the gesture; only the awaiting is deferred.
    const resumed = ctx.resume();
    this.#playSilentBuffer(ctx);
    const settle = (): ManagerState => {
      this.#emit();
      return this.state;
    };
    return resumed.then(settle, settle);
  }

  /** Called whenever the state changes. Returns an unsubscribe function. */
  subscribe(listener: StateListener): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  /** Closes the context and removes all event listeners. A later getContext() makes a new one. */
  async dispose(): Promise<void> {
    for (const d of this.#disposers) d();
    this.#disposers = [];
    const ctx = this.#context;
    this.#context = undefined;
    if (ctx && ctx.state !== "closed") {
      try {
        await ctx.close();
      } catch {
        // Already closed.
      }
    }
    this.#lastState = "uninitialized";
    for (const l of this.#listeners) l("uninitialized");
  }

  #resumeQuietly(): void {
    const ctx = this.#context;
    if (!ctx || ctx.state === "running" || ctx.state === "closed") return;
    // Outside a user gesture iOS may reject; the next unlock() call will recover.
    const settle = (): void => {
      this.#emit();
    };
    ctx.resume().then(settle, settle);
  }

  #playSilentBuffer(ctx: AudioContextLike): void {
    try {
      if (!ctx.createBuffer || !ctx.createBufferSource) return;
      const src = ctx.createBufferSource();
      src.buffer = ctx.createBuffer(1, 1, 22050);
      src.connect(ctx.destination);
      src.start(0);
    } catch {
      // Best effort only.
    }
  }

  #emit(): void {
    const s = this.state;
    if (s === this.#lastState) return;
    this.#lastState = s;
    for (const l of this.#listeners) l(s);
  }
}

let shared: AudioContextManager | undefined;
/** The app-wide manager. Created on first use with the browser defaults. */
export function getAudioContextManager(): AudioContextManager {
  shared ??= new AudioContextManager();
  return shared;
}
