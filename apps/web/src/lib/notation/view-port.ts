import { tick } from "svelte";
import type { ScoreSpec } from "@clavis/core";
import type { NotationRenderer } from "@clavis/notation";
import type { NotationMark, NotationPort } from "./port";

/** What `NotationView` draws: the SVG markup and the highlighted notes. */
export interface NotationViewState {
  svg: string;
  marks: readonly NotationMark[];
  /** The score on screen, so the view can describe it to a screen reader (T8.2). */
  score?: ScoreSpec;
}

/** A `NotationPort` that also publishes what to draw, for `NotationView` to subscribe to. */
export interface NotationViewPort extends NotationPort {
  /** Calls `listener` now and on every change. Returns the unsubscribe function. */
  subscribe(listener: (state: NotationViewState) => void): () => void;
}

export interface NotationViewPortOptions {
  /** Width to lay the score out at. The SVG is scaled to its container afterwards. */
  widthPx?: number;
  /** Frames to wait after the SVG is in the DOM (R17 latency reference). Default 2. */
  frames?: number;
  /** Do not wait longer than this for animation frames (hidden tabs do not run them). */
  frameTimeoutMs?: number;
}

const EMPTY: NotationViewState = { svg: "", marks: [] };

function nextFrame(timeoutMs: number): Promise<void> {
  return new Promise<void>((resolve) => {
    let done = false;
    const finish = (): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(finish, timeoutMs);
    requestAnimationFrame(finish);
  });
}

/**
 * The session's `NotationPort` over a `NotationRenderer`. `show` resolves once the SVG is in the
 * DOM (Svelte has flushed the view) and two animation frames have fired, so the browser has had a
 * chance to paint it: the learner can see the score when the promise resolves (R17). A `show` or
 * `hide` that arrives while an earlier `show` is still rendering supersedes it.
 */
export function createNotationViewPort(
  renderer: NotationRenderer,
  options: NotationViewPortOptions = {},
): NotationViewPort {
  const widthPx = options.widthPx ?? 600;
  const frames = options.frames ?? 2;
  const frameTimeoutMs = options.frameTimeoutMs ?? 250;
  const listeners = new Set<(state: NotationViewState) => void>();
  let state = EMPTY;
  let generation = 0;

  function set(next: NotationViewState): void {
    state = next;
    for (const l of [...listeners]) l(state);
  }

  return {
    subscribe(listener) {
      listeners.add(listener);
      listener(state);
      return () => {
        listeners.delete(listener);
      };
    },
    preload: () => renderer.preload(),
    async show(score: ScoreSpec) {
      const mine = ++generation;
      const { svg } = await renderer.render(score, { widthPx });
      if (mine !== generation) return;
      set({ svg, marks: [], score });
      await tick();
      for (let i = 0; i < frames; i++) await nextFrame(frameTimeoutMs);
    },
    highlight(marks) {
      set({ ...state, marks: [...marks] });
    },
    hide() {
      generation++;
      set(EMPTY);
    },
  };
}
