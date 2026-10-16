import { SyncAuthError, SyncRejectedError, type SyncResult } from "@clavis/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SYNC_INTERVAL_MS, createSyncController } from "./controller";
import { createFetchTransport } from "./transport";

const ok = (extra: Partial<SyncResult> = {}): SyncResult => ({
  outcome: "ok",
  pushed: 0,
  pulledNew: 0,
  skipped: 0,
  ...extra,
});

function setup(initial: () => Promise<SyncResult> | SyncResult) {
  const doc = new EventTarget();
  const win = new EventTarget();
  const env = { visible: true, online: true };
  let impl = initial;
  let calls = 0;
  let inFlight = 0;
  let maxInFlight = 0;
  const run = async (): Promise<SyncResult> => {
    calls++;
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    try {
      return await impl();
    } finally {
      inFlight--;
    }
  };
  const controller = createSyncController({
    run,
    now: () => Date.now(),
    isVisible: () => env.visible,
    isOnline: () => env.online,
    doc,
    win,
  });
  return {
    controller,
    doc,
    win,
    env,
    setImpl: (f: () => Promise<SyncResult> | SyncResult) => {
      impl = f;
    },
    calls: () => calls,
    maxInFlight: () => maxInFlight,
  };
}

describe("sync controller", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("is single-flight: triggers during a run collapse into one follow-up", async () => {
    let release: (() => void) | undefined;
    const t = setup(
      () =>
        new Promise<SyncResult>((resolve) => {
          release = () => {
            resolve(ok());
          };
        }),
    );
    const p1 = t.controller.trigger("sessionEnd");
    void t.controller.trigger("visible");
    void t.controller.trigger("online");
    expect(t.controller.state.status).toBe("syncing");
    expect(t.calls()).toBe(1);
    release?.();
    await vi.advanceTimersByTimeAsync(0);
    expect(t.calls()).toBe(2); // exactly one follow-up
    release?.();
    await p1;
    expect(t.calls()).toBe(2);
    expect(t.maxInFlight()).toBe(1);
    expect(t.controller.state).toEqual({ status: "idle", lastSyncedAt: 1_000_000 });
  });

  it("runs every 5 minutes while visible and online, and skips otherwise", async () => {
    const t = setup(() => ok());
    const stop = t.controller.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(t.calls()).toBe(1); // start
    await vi.advanceTimersByTimeAsync(SYNC_INTERVAL_MS);
    expect(t.calls()).toBe(2);
    t.env.visible = false;
    await vi.advanceTimersByTimeAsync(SYNC_INTERVAL_MS);
    expect(t.calls()).toBe(2);
    t.env.visible = true;
    t.env.online = false;
    await vi.advanceTimersByTimeAsync(SYNC_INTERVAL_MS);
    expect(t.calls()).toBe(2);
    stop();
    t.env.online = true;
    await vi.advanceTimersByTimeAsync(SYNC_INTERVAL_MS * 2);
    expect(t.calls()).toBe(2);
  });

  it("syncs on visibilitychange to visible and on online", async () => {
    const t = setup(() => ok());
    const stop = t.controller.start();
    await vi.advanceTimersByTimeAsync(0);
    t.env.visible = false;
    t.doc.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(0);
    expect(t.calls()).toBe(1);
    t.env.visible = true;
    t.doc.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(0);
    expect(t.calls()).toBe(2);
    t.win.dispatchEvent(new Event("online"));
    await vi.advanceTimersByTimeAsync(0);
    expect(t.calls()).toBe(3);
    stop();
  });

  it("backs off while signed out: timer is quiet, explicit triggers retry", async () => {
    const t = setup(() => ok({ outcome: "signedOut" }));
    const stop = t.controller.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(t.controller.state.status).toBe("signedOut");
    expect(t.calls()).toBe(1);
    await vi.advanceTimersByTimeAsync(SYNC_INTERVAL_MS * 4);
    expect(t.calls()).toBe(1);
    await t.controller.trigger("sessionEnd");
    expect(t.calls()).toBe(2);
    t.setImpl(() => ok());
    t.win.dispatchEvent(new Event("online"));
    await vi.advanceTimersByTimeAsync(0);
    expect(t.controller.state.status).toBe("idle");
    await vi.advanceTimersByTimeAsync(SYNC_INTERVAL_MS);
    expect(t.calls()).toBe(4); // signed in again: timer resumes
    stop();
  });

  it("reports offline and error, keeps lastSyncedAt, and notifies on pulled events", async () => {
    const t = setup(() => ok({ pulledNew: 2 }));
    const pulled = vi.fn();
    t.controller.onPulled(pulled);
    await t.controller.trigger("start");
    expect(pulled).toHaveBeenCalledTimes(1);
    t.setImpl(() => ok({ outcome: "offline", detail: "down" }));
    await t.controller.trigger("start");
    expect(t.controller.state).toEqual({
      status: "offline",
      lastSyncedAt: 1_000_000,
      detail: "down",
    });
    t.setImpl(() => Promise.reject(new Error("boom")));
    await t.controller.trigger("start");
    expect(t.controller.state.status).toBe("error");
    expect(pulled).toHaveBeenCalledTimes(1);
  });
});

describe("fetch transport", () => {
  const json = (body: unknown, status = 200): Response =>
    new Response(JSON.stringify(body), { status });

  it("sends credentials and validates responses", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const t = createFetchTransport((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : "";
      calls.push({ url, init: init ?? {} });
      return Promise.resolve(
        url.includes("push")
          ? json({ accepted: 1, duplicates: 0, lastSeq: 1 })
          : json({ events: [], lastSeq: 4, hasMore: false }),
      );
    });
    expect(await t.push({ events: [] })).toEqual({ accepted: 1, duplicates: 0, lastSeq: 1 });
    expect(await t.pull({ after: 4, limit: 10 })).toEqual({
      events: [],
      lastSeq: 4,
      hasMore: false,
    });
    expect(calls.map((c) => c.url)).toEqual(["/api/sync/push", "/api/sync/pull?after=4&limit=10"]);
    expect(calls.every((c) => c.init.credentials === "include")).toBe(true);
    expect(calls[0]?.init.headers).toEqual({ "content-type": "application/json" });
  });

  it("maps statuses to typed errors", async () => {
    const withStatus = (status: number) =>
      createFetchTransport(() => Promise.resolve(json({}, status)));
    await expect(withStatus(401).pull({ after: 0 })).rejects.toBeInstanceOf(SyncAuthError);
    await expect(withStatus(400).push({ events: [] })).rejects.toBeInstanceOf(SyncRejectedError);
    await expect(withStatus(503).pull({ after: 0 })).rejects.not.toBeInstanceOf(SyncRejectedError);
    for (const retryable of [408, 429]) {
      await expect(withStatus(retryable).push({ events: [] })).rejects.not.toBeInstanceOf(
        SyncRejectedError,
      );
    }
    await expect(
      createFetchTransport(() => Promise.resolve(json({ nope: 1 }))).pull({ after: 0 }),
    ).rejects.toThrow("unexpected pull response");
    await expect(
      createFetchTransport(() => Promise.reject(new TypeError("offline"))).pull({ after: 0 }),
    ).rejects.toThrow("offline");
  });
});
