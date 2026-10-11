import { describe, expect, it } from "vitest";
import {
  AudioContextManager,
  type AudioContextLike,
  type DocumentLike,
  type EventTargetLike,
  type ManagerState,
} from "./context";

class FakeContext implements AudioContextLike {
  currentTime = 0;
  state = "suspended";
  resumeCalls = 0;
  closeCalls = 0;
  sourcesStarted = 0;
  /** What state a successful resume() moves to. */
  resumeTo = "running";
  rejectResume = false;
  readonly destination = {};
  readonly #listeners = new Set<() => void>();

  resume(): Promise<void> {
    this.resumeCalls++;
    if (this.rejectResume) return Promise.reject(new Error("not allowed"));
    this.setState(this.resumeTo);
    return Promise.resolve();
  }
  close(): Promise<void> {
    this.closeCalls++;
    this.setState("closed");
    return Promise.resolve();
  }
  addEventListener(_t: "statechange", l: () => void): void {
    this.#listeners.add(l);
  }
  removeEventListener(_t: "statechange", l: () => void): void {
    this.#listeners.delete(l);
  }
  createBuffer(): unknown {
    return {};
  }
  createBufferSource() {
    return {
      buffer: null as unknown,
      connect: () => undefined,
      start: () => {
        this.sourcesStarted++;
      },
    };
  }
  setState(s: string): void {
    this.state = s;
    for (const l of this.#listeners) l();
  }
  get listenerCount(): number {
    return this.#listeners.size;
  }
}

class FakeTarget implements EventTargetLike, DocumentLike {
  visibilityState = "visible";
  readonly #l = new Map<string, Set<() => void>>();
  addEventListener(type: string, l: () => void): void {
    const set = this.#l.get(type) ?? new Set();
    set.add(l);
    this.#l.set(type, set);
  }
  removeEventListener(type: string, l: () => void): void {
    this.#l.get(type)?.delete(l);
  }
  fire(type: string): void {
    for (const l of this.#l.get(type) ?? []) l();
  }
  count(type: string): number {
    return this.#l.get(type)?.size ?? 0;
  }
}

function setup() {
  const contexts: FakeContext[] = [];
  const doc = new FakeTarget();
  const win = new FakeTarget();
  const audioSession = { type: "auto" };
  const mgr = new AudioContextManager({
    createContext: () => {
      const c = new FakeContext();
      contexts.push(c);
      return c;
    },
    document: doc,
    window: win,
    audioSession,
  });
  return { mgr, contexts, doc, win, audioSession };
}

function first<T>(xs: readonly T[]): T {
  const x = xs[0];
  if (x === undefined) throw new Error("expected at least one element");
  return x;
}

const flush = () => new Promise<void>((r) => setTimeout(r, 0));

describe("AudioContextManager", () => {
  it("creates the context lazily and only once", () => {
    const { mgr, contexts } = setup();
    expect(contexts).toHaveLength(0);
    expect(mgr.state).toBe("uninitialized");
    expect(mgr.currentTime).toBe(0);
    const a = mgr.getContext();
    const b = mgr.getContext();
    expect(a).toBe(b);
    expect(contexts).toHaveLength(1);
    expect(mgr.state).toBe("suspended");
  });

  it("exposes currentTime from the context", () => {
    const { mgr, contexts } = setup();
    mgr.getContext();
    first(contexts).currentTime = 12.5;
    expect(mgr.currentTime).toBe(12.5);
  });

  it("unlock() resumes, plays the silent buffer and sets the playback audio session", async () => {
    const { mgr, contexts, audioSession } = setup();
    const state = await mgr.unlock();
    expect(state).toBe("running");
    expect(contexts).toHaveLength(1);
    expect(first(contexts).resumeCalls).toBe(1);
    expect(first(contexts).sourcesStarted).toBe(1);
    expect(audioSession.type).toBe("playback");
  });

  it("unlock({ capture: true }) switches the session to play-and-record and keeps it", async () => {
    const { mgr, audioSession } = setup();
    await mgr.unlock();
    expect(audioSession.type).toBe("playback");
    await mgr.unlock({ capture: true });
    expect(audioSession.type).toBe("play-and-record");
    // A later plain unlock (for example a stimulus replay tap) must not drop capture.
    await mgr.unlock();
    expect(audioSession.type).toBe("play-and-record");
  });

  it("unlock() is idempotent and reuses the context", async () => {
    const { mgr, contexts } = setup();
    await mgr.unlock();
    await mgr.unlock();
    expect(contexts).toHaveLength(1);
    expect(mgr.state).toBe("running");
  });

  it("unlock() resolves with the current state when resume is rejected", async () => {
    const { mgr, contexts } = setup();
    mgr.getContext();
    first(contexts).rejectResume = true;
    await expect(mgr.unlock()).resolves.toBe("suspended");
  });

  it("notifies subscribers on state changes and stops after unsubscribe", async () => {
    const { mgr, contexts } = setup();
    const seen: ManagerState[] = [];
    const off = mgr.subscribe((s) => seen.push(s));
    await mgr.unlock();
    first(contexts).setState("interrupted");
    off();
    first(contexts).setState("running");
    expect(seen).toEqual(["running", "interrupted"]);
  });

  it("resumes an interrupted context when the page becomes visible", async () => {
    const { mgr, contexts, doc } = setup();
    await mgr.unlock();
    const ctx = first(contexts);
    ctx.setState("interrupted");
    expect(mgr.state).toBe("interrupted");
    ctx.resumeCalls = 0;
    doc.fire("visibilitychange");
    await flush();
    expect(ctx.resumeCalls).toBe(1);
    expect(mgr.state).toBe("running");
  });

  it("resumes on pageshow", async () => {
    const { mgr, contexts, win } = setup();
    await mgr.unlock();
    first(contexts).setState("suspended");
    win.fire("pageshow");
    await flush();
    expect(mgr.state).toBe("running");
  });

  it("does not resume while hidden, when running, or before the context exists", async () => {
    const { mgr, contexts, doc } = setup();
    doc.fire("visibilitychange"); // no listeners yet, nothing created
    expect(contexts).toHaveLength(0);
    await mgr.unlock();
    const ctx = first(contexts);
    ctx.resumeCalls = 0;
    doc.fire("visibilitychange"); // already running
    expect(ctx.resumeCalls).toBe(0);
    ctx.setState("interrupted");
    doc.visibilityState = "hidden";
    doc.fire("visibilitychange");
    expect(ctx.resumeCalls).toBe(0);
  });

  it("swallows a rejected background resume", async () => {
    const { mgr, contexts, doc } = setup();
    await mgr.unlock();
    first(contexts).setState("interrupted");
    first(contexts).rejectResume = true;
    doc.fire("visibilitychange");
    await flush();
    expect(mgr.state).toBe("interrupted");
  });

  it("registers its page listeners once and removes them on dispose", async () => {
    const { mgr, contexts, doc, win } = setup();
    mgr.getContext();
    mgr.getContext();
    expect(doc.count("visibilitychange")).toBe(1);
    expect(win.count("pageshow")).toBe(1);
    const ctx = first(contexts);
    await mgr.dispose();
    expect(doc.count("visibilitychange")).toBe(0);
    expect(win.count("pageshow")).toBe(0);
    expect(ctx.listenerCount).toBe(0);
    expect(ctx.closeCalls).toBe(1);
    expect(mgr.state).toBe("uninitialized");
    mgr.getContext();
    expect(contexts).toHaveLength(2);
  });
});
