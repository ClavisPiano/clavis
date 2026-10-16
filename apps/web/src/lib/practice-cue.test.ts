import { describe, expect, it, vi } from "vitest";
import { learnerDay } from "@clavis/core";
import { parseCuePayload, FALLBACK_CUE } from "./pwa/cue-payload";
import type { InstallEnv } from "./pwa/ios";
import {
  CUE_META_KEY,
  CUE_REPORTED_META_KEY,
  DEFAULT_CUE,
  cueError,
  cueSupport,
  disableCue,
  enableCue,
  parseCueSettings,
  practisedDay,
  reportPractisedIfNeeded,
  syncCue,
  type CueDeps,
  type CueSettings,
  type PushSubscriptionLike,
} from "./practice-cue";

const cue = (over: Partial<CueSettings> = {}): CueSettings => ({
  ...DEFAULT_CUE,
  enabled: true,
  time: "07:30",
  weekdays: [1, 2, 3, 4, 5],
  habit: "After my morning coffee",
  ...over,
});

describe("parseCueSettings", () => {
  it("falls back to defaults for missing or malformed values", () => {
    for (const raw of [undefined, null, 5, "x", [], {}]) {
      expect(parseCueSettings(raw)).toEqual(DEFAULT_CUE);
    }
  });

  it("round trips valid settings", () => {
    expect(parseCueSettings(cue())).toEqual(cue());
  });

  it("repairs individual bad fields", () => {
    const parsed = parseCueSettings({
      enabled: "yes",
      time: "25:99",
      weekdays: [5, 1, 1, 9, -1, 2.5, "3"],
      habit: `  ${"x".repeat(100)}  `,
    });
    expect(parsed.enabled).toBe(false);
    expect(parsed.time).toBe(DEFAULT_CUE.time);
    expect(parsed.weekdays).toEqual([1, 5]);
    expect(parsed.habit).toHaveLength(60);
  });
});

describe("cueError", () => {
  it("accepts valid settings and explains the first problem otherwise", () => {
    expect(cueError(cue())).toBeUndefined();
    expect(cueError(cue({ time: "" }))).toMatch(/time/);
    expect(cueError(cue({ weekdays: [] }))).toMatch(/day/);
    expect(cueError(cue({ habit: "x".repeat(61) }))).toMatch(/60/);
  });
});

const install = (over: Partial<InstallEnv>): InstallEnv => ({
  userAgent:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1",
  platform: "iPhone",
  maxTouchPoints: 5,
  navigatorStandalone: false,
  displayModeStandalone: false,
  ...over,
});
const desktop = install({
  userAgent: "Mozilla/5.0 (X11; Linux x86_64) Chrome/124.0 Safari/537.36",
  platform: "Linux x86_64",
  maxTouchPoints: 0,
  navigatorStandalone: undefined,
});

describe("cueSupport", () => {
  const apis = { hasServiceWorker: true, hasPushManager: true, hasNotification: true };
  it.each([
    ["desktop with push", { ...apis, install: desktop }, "ok"],
    [
      "desktop without PushManager",
      { ...apis, hasPushManager: false, install: desktop },
      "unsupported",
    ],
    // A Safari tab on iOS has no PushManager: explain installing, do not say unsupported.
    [
      "iOS Safari tab",
      { ...apis, hasPushManager: false, hasNotification: false, install: install({}) },
      "needs-install",
    ],
    [
      "iOS installed (navigator.standalone)",
      { ...apis, install: install({ navigatorStandalone: true }) },
      "ok",
    ],
    [
      "iOS installed (display-mode)",
      { ...apis, install: install({ displayModeStandalone: true }) },
      "ok",
    ],
    [
      "iOS installed but no push",
      { ...apis, hasPushManager: false, install: install({ displayModeStandalone: true }) },
      "unsupported",
    ],
  ] as const)("%s", (_name, env, expected) => {
    expect(cueSupport(env)).toBe(expected);
  });
});

// A mocked PushManager and fetch.
function fakePush(opts: { permission?: NotificationPermission; subscribed?: boolean } = {}) {
  let permission: NotificationPermission = opts.permission ?? "default";
  const unsubscribe = vi.fn(() => Promise.resolve(true));
  const subscription: PushSubscriptionLike = {
    endpoint: "https://push.example.com/abc",
    toJSON: () => ({
      endpoint: "https://push.example.com/abc",
      keys: { p256dh: "P256DH", auth: "AUTH" },
    }),
    unsubscribe,
  };
  let current: PushSubscriptionLike | null = opts.subscribed ? subscription : null;
  const subscribe = vi.fn(
    (options: { userVisibleOnly: boolean; applicationServerKey: Uint8Array }) => {
      expect(options.userVisibleOnly).toBe(true);
      current = subscription;
      return Promise.resolve(subscription);
    },
  );
  const getSubscription = vi.fn(() => Promise.resolve(current));
  const requestPermission = vi.fn(() => {
    permission = "granted";
    return Promise.resolve(permission);
  });
  const requests: { url: string; method: string; body: unknown }[] = [];
  const respond = { status: 200, keyStatus: 200 };
  const fetchFn = vi.fn((url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    requests.push({ url, method, body: init?.body ? JSON.parse(init.body as string) : undefined });
    if (url === "/api/push/key") {
      return Promise.resolve(
        respond.keyStatus === 200
          ? Response.json({ publicKey: "AQID" }) // bytes 1, 2, 3
          : new Response(null, { status: respond.keyStatus }),
      );
    }
    return Promise.resolve(new Response("{}", { status: respond.status }));
  }) as unknown as typeof fetch;
  const deps: CueDeps = {
    fetch: fetchFn,
    getRegistration: () => Promise.resolve({ pushManager: { getSubscription, subscribe } }),
    permission: () => permission,
    requestPermission,
    tzOffsetMin: () => 600,
  };
  return { deps, subscribe, getSubscription, requestPermission, requests, respond, unsubscribe };
}

describe("enableCue", () => {
  it("asks permission, subscribes with the VAPID key and uploads settings with the offset", async () => {
    const push = fakePush();
    const result = await enableCue(push.deps, cue());
    expect(result).toEqual({ status: "ok" });
    expect(push.requestPermission).toHaveBeenCalledOnce();
    expect(push.subscribe).toHaveBeenCalledOnce();
    const options = push.subscribe.mock.calls[0]?.[0];
    expect(options?.userVisibleOnly).toBe(true);
    expect([...(options?.applicationServerKey ?? [])]).toEqual([1, 2, 3]);
    expect(push.requests.at(-1)).toEqual({
      url: "/api/push/subscription",
      method: "PUT",
      body: {
        subscription: {
          endpoint: "https://push.example.com/abc",
          keys: { p256dh: "P256DH", auth: "AUTH" },
        },
        cue: { time: "07:30", weekdays: [1, 2, 3, 4, 5], habit: "After my morning coffee" },
        tzOffsetMin: 600,
      },
    });
  });

  it("does not prompt again when permission is already granted, and reuses a subscription", async () => {
    const push = fakePush({ permission: "granted", subscribed: true });
    expect(await enableCue(push.deps, cue())).toEqual({ status: "ok" });
    expect(push.requestPermission).not.toHaveBeenCalled();
    expect(push.subscribe).not.toHaveBeenCalled();
    expect(push.requests.map((r) => r.url)).toEqual(["/api/push/subscription"]);
  });

  it("reports blocked and does nothing else when permission is denied", async () => {
    const push = fakePush({ permission: "denied" });
    expect(await enableCue(push.deps, cue())).toEqual({ status: "blocked" });
    expect(push.requestPermission).not.toHaveBeenCalled();
    expect(push.subscribe).not.toHaveBeenCalled();
    expect(push.requests).toEqual([]);
  });

  it("reports blocked when the person dismisses the prompt with a no", async () => {
    const push = fakePush();
    push.deps.requestPermission = () => Promise.resolve("denied");
    expect(await enableCue(push.deps, cue())).toEqual({ status: "blocked" });
    expect(push.subscribe).not.toHaveBeenCalled();
  });

  it("asks to sign in when the server answers 401", async () => {
    const push = fakePush();
    push.respond.status = 401;
    expect(await enableCue(push.deps, cue())).toEqual({ status: "signin-required" });
  });

  it("is unavailable when the server has no VAPID key", async () => {
    const push = fakePush();
    push.respond.keyStatus = 503;
    expect(await enableCue(push.deps, cue())).toEqual({ status: "unavailable" });
    expect(push.subscribe).not.toHaveBeenCalled();
  });

  it("returns an error instead of throwing when subscribing fails", async () => {
    const push = fakePush();
    push.subscribe.mockRejectedValueOnce(new Error("push service unreachable"));
    expect(await enableCue(push.deps, cue())).toEqual({
      status: "error",
      message: "push service unreachable",
    });
  });
});

describe("syncCue", () => {
  it("re-sends the settings for the existing subscription", async () => {
    const push = fakePush({ permission: "granted", subscribed: true });
    expect(await syncCue(push.deps, cue({ time: "21:00" }))).toEqual({ status: "ok" });
    expect(push.requests[0]?.method).toBe("PUT");
    expect((push.requests[0]?.body as { cue: { time: string } }).cue.time).toBe("21:00");
    expect(push.subscribe).not.toHaveBeenCalled();
  });

  it("does nothing without permission or a subscription", async () => {
    const denied = fakePush({ permission: "denied", subscribed: true });
    expect(await syncCue(denied.deps, cue())).toEqual({ status: "blocked" });
    const none = fakePush({ permission: "granted" });
    expect(await syncCue(none.deps, cue())).toEqual({ status: "unavailable" });
    expect(denied.requests).toEqual([]);
    expect(none.requests).toEqual([]);
  });
});

describe("disableCue", () => {
  it("deletes the endpoint on the server and unsubscribes locally", async () => {
    const push = fakePush({ permission: "granted", subscribed: true });
    expect(await disableCue(push.deps)).toEqual({ status: "ok" });
    expect(push.requests).toEqual([
      {
        url: "/api/push/subscription",
        method: "DELETE",
        body: { endpoint: "https://push.example.com/abc" },
      },
    ]);
    expect(push.unsubscribe).toHaveBeenCalledOnce();
  });

  it("still unsubscribes locally when the server cannot be reached", async () => {
    const push = fakePush({ permission: "granted", subscribed: true });
    push.deps.fetch = () => Promise.reject(new Error("offline"));
    expect(await disableCue(push.deps)).toEqual({ status: "ok" });
    expect(push.unsubscribe).toHaveBeenCalledOnce();
  });

  it("is a no-op without a subscription", async () => {
    const push = fakePush({ permission: "granted" });
    expect(await disableCue(push.deps)).toEqual({ status: "ok" });
    expect(push.requests).toEqual([]);
  });
});

describe("settings persistence", () => {
  it("survives a store round trip through parseCueSettings", () => {
    const meta = new Map<string, unknown>();
    // Meta storage is structured clone: nothing but plain data may be stored.
    meta.set(CUE_META_KEY, structuredClone(cue({ weekdays: [0, 6], time: "18:45" })));
    expect(parseCueSettings(meta.get(CUE_META_KEY))).toEqual(
      cue({ weekdays: [0, 6], time: "18:45" }),
    );
  });
});

// Monday 2026-10-12 08:30 in Sydney.
const NOW = Date.UTC(2026, 9, 11, 22, 30, 0);
const TZ = 600;

function reportHarness(opts: { meta?: Record<string, unknown>; status?: number } = {}) {
  const meta = new Map<string, unknown>(Object.entries(opts.meta ?? {}));
  const calls: { url: string; body: unknown }[] = [];
  const deps = {
    fetch: ((url: string, init: RequestInit) => {
      calls.push({ url, body: JSON.parse(init.body as string) });
      return Promise.resolve(new Response("{}", { status: opts.status ?? 200 }));
    }) as unknown as typeof fetch,
    getMeta: (k: string) => Promise.resolve(meta.get(k)),
    setMeta: (k: string, v: unknown) => {
      meta.set(k, v);
      return Promise.resolve();
    },
    tzOffsetMin: () => TZ,
  };
  return { deps, meta, calls };
}

const practisedState = (sec: number, day = learnerDay(NOW, TZ)) =>
  ({
    daily: { [day]: { practiceSec: sec } },
  }) as unknown as Parameters<typeof reportPractisedIfNeeded>[1];

describe("practisedDay", () => {
  it("counts a day from one minute of practice", () => {
    expect(practisedDay(practisedState(59), NOW, TZ)).toBeUndefined();
    expect(practisedDay(practisedState(60), NOW, TZ)).toBe("2026-10-12");
    expect(practisedDay(practisedState(600, "2026-10-11"), NOW, TZ)).toBeUndefined();
  });
});

describe("reportPractisedIfNeeded (skip today's cue once practised)", () => {
  const enabled = { [CUE_META_KEY]: cue() };

  it("reports the learner day once practised, and remembers it", async () => {
    const h = reportHarness({ meta: enabled });
    expect(await reportPractisedIfNeeded(h.deps, practisedState(120), NOW)).toBe("reported");
    expect(h.calls).toEqual([{ url: "/api/push/practised", body: { day: "2026-10-12" } }]);
    expect(h.meta.get(CUE_REPORTED_META_KEY)).toBe("2026-10-12");
    expect(await reportPractisedIfNeeded(h.deps, practisedState(300), NOW)).toBe("skipped");
    expect(h.calls).toHaveLength(1);
  });

  it("reports again on the next learner day", async () => {
    const h = reportHarness({ meta: { ...enabled, [CUE_REPORTED_META_KEY]: "2026-10-11" } });
    expect(await reportPractisedIfNeeded(h.deps, practisedState(120), NOW)).toBe("reported");
  });

  it("does not report before a minute of practice or when the cue is off", async () => {
    const early = reportHarness({ meta: enabled });
    expect(await reportPractisedIfNeeded(early.deps, practisedState(30), NOW)).toBe("skipped");
    const off = reportHarness({ meta: { [CUE_META_KEY]: cue({ enabled: false }) } });
    expect(await reportPractisedIfNeeded(off.deps, practisedState(300), NOW)).toBe("skipped");
    const unset = reportHarness();
    expect(await reportPractisedIfNeeded(unset.deps, practisedState(300), NOW)).toBe("skipped");
    expect([...early.calls, ...off.calls, ...unset.calls]).toEqual([]);
  });

  it("retries later after a network or server failure", async () => {
    const down = reportHarness({ meta: enabled, status: 500 });
    expect(await reportPractisedIfNeeded(down.deps, practisedState(120), NOW)).toBe("failed");
    expect(down.meta.has(CUE_REPORTED_META_KEY)).toBe(false);
    down.deps.fetch = () => Promise.reject(new Error("offline"));
    expect(await reportPractisedIfNeeded(down.deps, practisedState(120), NOW)).toBe("failed");
  });

  it("stops retrying today when signed out (401)", async () => {
    const h = reportHarness({ meta: enabled, status: 401 });
    expect(await reportPractisedIfNeeded(h.deps, practisedState(120), NOW)).toBe("skipped");
    expect(h.meta.get(CUE_REPORTED_META_KEY)).toBe("2026-10-12");
  });

  it("uses the 04:00 rollover: 01:00 local still belongs to the previous day", async () => {
    const lateNight = Date.UTC(2026, 9, 11, 15, 0, 0); // 01:00 Monday in Sydney
    const h = reportHarness({ meta: enabled });
    const state = practisedState(120, "2026-10-11");
    expect(await reportPractisedIfNeeded(h.deps, state, lateNight)).toBe("reported");
    expect(h.calls[0]?.body).toEqual({ day: "2026-10-11" });
  });
});

describe("parseCuePayload", () => {
  const data = (value: unknown) => ({ json: () => value });
  it("reads the Worker payload", () => {
    expect(
      parseCuePayload(data({ title: "Time to practise", body: "After my coffee", url: "/" })),
    ).toEqual({ title: "Time to practise", body: "After my coffee", url: "/" });
  });

  it("falls back for missing, malformed or hostile payloads", () => {
    expect(parseCuePayload(null)).toEqual(FALLBACK_CUE);
    expect(
      parseCuePayload({
        json: () => {
          throw new Error("not json");
        },
      }),
    ).toEqual(FALLBACK_CUE);
    expect(parseCuePayload(data("text"))).toEqual(FALLBACK_CUE);
    expect(parseCuePayload(data({ title: 1, body: "", url: "https://evil.example" }))).toEqual(
      FALLBACK_CUE,
    );
    expect(parseCuePayload(data({ url: "//evil.example" })).url).toBe("/");
  });
});
