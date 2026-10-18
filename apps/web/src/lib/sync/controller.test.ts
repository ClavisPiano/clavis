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

  it("makes no request without the signed-in hint, and clears the hint on a 401", async () => {
    let signedIn = false;
    let cleared = 0;
    let calls = 0;
    let outcome: SyncResult["outcome"] = "ok";
    const controller = createSyncController({
      run: () => {
        calls++;
        return Promise.resolve(ok({ outcome }));
      },
      now: () => Date.now(),
      isVisible: () => true,
      isOnline: () => true,
      doc: new EventTarget(),
      win: new EventTarget(),
      isSignedIn: () => signedIn,
      onSignedOut: () => {
        cleared++;
        signedIn = false;
      },
    });
    await controller.trigger("start");
    await controller.trigger("online");
    expect(calls).toBe(0);
    expect(controller.state.status).toBe("signedOut");

    signedIn = true;
    outcome = "signedOut";
    await controller.trigger("visible");
    expect(calls).toBe(1);
    expect(cleared).toBe(1);
    await controller.trigger("sessionEnd");
    expect(calls).toBe(1);
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

  it("a manual trigger runs even while signed out", async () => {
    const t = setup(() => ({ outcome: "signedOut", pushed: 0, pulledNew: 0, skipped: 0 }));
    await t.controller.trigger("start");
    await t.controller.trigger("manual");
    expect(t.calls()).toBe(2);
  });

  it("notifySignedOut shows signedOut, keeps lastSyncedAt and silences the timer", async () => {
    const t = setup(() => ok());
    const stop = t.controller.start();
    await vi.advanceTimersByTimeAsync(0);
    t.controller.notifySignedOut();
    expect(t.controller.state).toEqual({ status: "signedOut", lastSyncedAt: 1_000_000 });
    await vi.advanceTimersByTimeAsync(SYNC_INTERVAL_MS * 2);
    expect(t.calls()).toBe(1);
    stop();
  });

  it("a sign out during an in-flight run is not undone when that run finishes ok", async () => {
    let finish: (r: SyncResult) => void = () => undefined;
    const t = setup(
      () =>
        new Promise<SyncResult>((resolve) => {
          finish = resolve;
        }),
    );
    const run = t.controller.trigger("manual");
    t.controller.notifySignedOut();
    finish(ok({ pushed: 1 }));
    await run;
    expect(t.controller.state.status).toBe("signedOut");
    // Timer syncs stay off: the stale ok run did not clear signedOut.
    t.setImpl(() => ok());
    await t.controller.trigger("timer");
    expect(t.calls()).toBe(1);
  });

  it("a sign in during an in-flight 401 run still ends signed in", async () => {
    let finish: (r: SyncResult) => void = () => undefined;
    const t = setup(
      () =>
        new Promise<SyncResult>((resolve) => {
          finish = resolve;
        }),
    );
    const run = t.controller.trigger("start");
    const signIn = t.controller.notifySignedIn();
    t.setImpl(() => ok());
    finish({ outcome: "signedOut", pushed: 0, pulledNew: 0, skipped: 0 });
    await run;
    await signIn;
    expect(t.controller.state.status).toBe("idle");
    expect(t.calls()).toBe(2);
  });

  it("notifySignedIn clears signedOut and syncs immediately", async () => {
    const t = setup(() => ({ outcome: "signedOut", pushed: 0, pulledNew: 0, skipped: 0 }));
    await t.controller.trigger("start");
    expect(t.controller.state.status).toBe("signedOut");
    t.setImpl(() => ok({ pushed: 3 }));
    await t.controller.notifySignedIn();
    expect(t.calls()).toBe(2);
    expect(t.controller.state).toEqual({ status: "idle", lastSyncedAt: 1_000_000 });
    // Timer syncs run again because signedOut was cleared.
    const stop = t.controller.start();
    await vi.advanceTimersByTimeAsync(SYNC_INTERVAL_MS);
    expect(t.calls()).toBe(4);
    stop();
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

  it("reports each response's Date header, even for an error status", async () => {
    const seen: (string | null)[] = [];
    const date = "Sun, 18 Oct 2026 10:00:00 GMT";
    const t = createFetchTransport(
      () =>
        Promise.resolve(
          new Response(JSON.stringify({ events: [], lastSeq: 0, hasMore: false }), {
            headers: { date },
          }),
        ),
      "/api/sync",
      (d) => seen.push(d),
    );
    await t.pull({ after: 0 });
    const failing = createFetchTransport(
      () => Promise.resolve(new Response("{}", { status: 503, headers: { date } })),
      "/api/sync",
      (d) => seen.push(d),
    );
    await expect(failing.pull({ after: 0 })).rejects.toThrow();
    expect(seen).toEqual([date, date]);
  });

  it("carries the count of events too large to push into the state, and drops it when none remain", async () => {
    const t = setup(() => ok({ oversized: 2 }));
    await t.controller.trigger("manual");
    expect(t.controller.state).toMatchObject({ status: "idle", oversized: 2 });
    t.setImpl(() => ok());
    await t.controller.trigger("manual");
    expect(t.controller.state.oversized).toBeUndefined();
    t.setImpl(() => ok({ outcome: "error", detail: "rejected", oversized: 1 }));
    await t.controller.trigger("manual");
    expect(t.controller.state).toMatchObject({ status: "error", oversized: 1 });
  });

  it("a throwing Date callback does not fail the sync request", async () => {
    const t = createFetchTransport(
      () => Promise.resolve(json({ events: [], lastSeq: 0, hasMore: false })),
      "/api/sync",
      () => {
        throw new Error("storage exploded");
      },
    );
    await expect(t.pull({ after: 0 })).resolves.toEqual({ events: [], lastSeq: 0, hasMore: false });
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

describe("afterSync hook", () => {
  const make = (result: SyncResult, afterSync: () => Promise<unknown>) =>
    createSyncController({
      run: () => Promise.resolve(result),
      afterSync,
      now: () => 1,
      isVisible: () => true,
      isOnline: () => true,
      doc: new EventTarget(),
      win: new EventTarget(),
    });

  it("runs after a successful sync without making the sync wait for it", async () => {
    const never = new Promise<void>(() => undefined);
    const after = vi.fn(() => never);
    const c = make(ok(), after);
    await c.trigger("sessionEnd"); // resolves although the hook never does
    await Promise.resolve();
    expect(after).toHaveBeenCalledTimes(1);
    expect(c.state.status).toBe("idle");
  });

  it("does not run when signed out or on error, and swallows hook failures", async () => {
    const after = vi.fn(() => Promise.resolve());
    for (const outcome of ["signedOut", "error", "offline"] as const) {
      await make(ok({ outcome }), after).trigger("start");
    }
    await Promise.resolve();
    expect(after).not.toHaveBeenCalled();
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const failing = make(ok(), () => Promise.reject(new Error("boom")));
    await failing.trigger("start");
    await new Promise((r) => setTimeout(r, 0));
    expect(failing.state.status).toBe("idle");
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});
