import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import worker from "../index";
import { signSession } from "../auth/session";
import type { Env } from "../env";
import { ORIGIN, SECRET, fakeD1, makeEnv } from "../test-support";
import { isAcceptableEndpoint } from "./endpoint";
import { isCalendarDay } from "./handlers";
import { MAX_SUBSCRIPTIONS_PER_USER } from "./repo";

const NOW = Date.UTC(2026, 9, 12, 0, 0, 0);

interface Row {
  endpoint: string;
  user_id: string;
  time_local: string;
  weekdays: number;
  tz_offset_min: number;
  habit: string;
  last_sent_day: string | null;
  last_practised_day: string | null;
}

function setup() {
  const sqlite = new DatabaseSync(":memory:");
  const { env } = makeEnv({ DB: fakeD1(sqlite), now: () => NOW, VAPID_PUBLIC_KEY: "PUBKEY" });
  for (const id of ["u1", "u2"]) {
    sqlite.prepare("INSERT INTO users (id, created_at) VALUES (?, 0)").run(id);
  }
  const rows = () =>
    sqlite.prepare("SELECT * FROM push_subscriptions ORDER BY endpoint").all() as unknown as Row[];
  return { env, rows, sqlite };
}

const cookieFor = async (userId: string): Promise<string> =>
  `__Host-clavis_session=${await signSession({ sub: userId, exp: NOW / 1000 + 3600 }, SECRET)}`;

interface Opts {
  user?: string | null;
  origin?: string | null;
  contentType?: string | null;
}

async function call(env: Env, method: string, path: string, body?: unknown, opts: Opts = {}) {
  const headers: Record<string, string> = {};
  if (opts.contentType !== null) headers["content-type"] = opts.contentType ?? "application/json";
  if (opts.origin !== null) headers.origin = opts.origin ?? ORIGIN;
  const user = opts.user === undefined ? "u1" : opts.user;
  if (user !== null) headers.cookie = await cookieFor(user);
  return worker.fetch(
    new Request(`${ORIGIN}${path}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    env,
  );
}

// 65 byte and 16 byte base64url values (shape only; storage does not decrypt anything).
const P256DH = "B" + "A".repeat(86);
const AUTH = "A".repeat(22);

const subscribeBody = (endpoint = "https://fcm.googleapis.com/fcm/send/a", over: object = {}) => ({
  subscription: { endpoint, keys: { p256dh: P256DH, auth: AUTH } },
  cue: { time: "08:00", weekdays: [1, 2, 3], habit: "  After my morning coffee " },
  tzOffsetMin: 600,
  ...over,
});

describe("GET /api/push/key", () => {
  it("serves the public key without a session", async () => {
    const { env } = setup();
    const res = await call(env, "GET", "/api/push/key", undefined, {
      user: null,
      contentType: null,
      origin: null,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ publicKey: "PUBKEY" });
  });

  it("is 503 when keys are not configured", async () => {
    const { env } = setup();
    const res = await call({ ...env, VAPID_PUBLIC_KEY: "" }, "GET", "/api/push/key");
    expect(res.status).toBe(503);
  });
});

describe("PUT /api/push/subscription", () => {
  it("stores the subscription for the session user", async () => {
    const { env, rows } = setup();
    const res = await call(env, "PUT", "/api/push/subscription", subscribeBody());
    expect(res.status).toBe(200);
    expect(rows()).toMatchObject([
      {
        endpoint: "https://fcm.googleapis.com/fcm/send/a",
        user_id: "u1",
        time_local: "08:00",
        weekdays: 0b0001110,
        tz_offset_min: 600,
        habit: "After my morning coffee",
        last_sent_day: null,
      },
    ]);
  });

  it("upserts: a second PUT updates the same row and keeps the sent day", async () => {
    const { env, rows, sqlite } = setup();
    await call(env, "PUT", "/api/push/subscription", subscribeBody());
    sqlite.exec("UPDATE push_subscriptions SET last_sent_day = '2026-10-11'");
    await call(
      env,
      "PUT",
      "/api/push/subscription",
      subscribeBody("https://fcm.googleapis.com/fcm/send/a", {
        cue: { time: "19:30", weekdays: [0], habit: "" },
        tzOffsetMin: -300,
      }),
    );
    expect(rows()).toMatchObject([
      {
        time_local: "19:30",
        weekdays: 1,
        tz_offset_min: -300,
        habit: "",
        last_sent_day: "2026-10-11",
      },
    ]);
  });

  it("lets a different user take over a device endpoint and resets its history", async () => {
    const { env, rows, sqlite } = setup();
    await call(env, "PUT", "/api/push/subscription", subscribeBody());
    sqlite.exec("UPDATE push_subscriptions SET last_sent_day = '2026-10-11'");
    await call(env, "PUT", "/api/push/subscription", subscribeBody(), { user: "u2" });
    expect(rows()).toMatchObject([{ user_id: "u2", last_sent_day: null }]);
  });

  it.each([
    ["time out of range", { cue: { time: "25:00", weekdays: [1], habit: "" } }],
    ["no weekdays", { cue: { time: "08:00", weekdays: [], habit: "" } }],
    ["duplicate weekdays", { cue: { time: "08:00", weekdays: [1, 1], habit: "" } }],
    ["weekday 7", { cue: { time: "08:00", weekdays: [7], habit: "" } }],
    ["habit too long", { cue: { time: "08:00", weekdays: [1], habit: "x".repeat(61) } }],
    ["offset out of range", { tzOffsetMin: 900 }],
    ["fractional offset", { tzOffsetMin: 1.5 }],
    [
      "bad key length",
      {
        subscription: {
          endpoint: "https://fcm.googleapis.com/fcm/send/a",
          keys: { p256dh: "AAAA", auth: AUTH },
        },
      },
    ],
    [
      "http endpoint",
      {
        subscription: {
          endpoint: "http://push.example.com/a",
          keys: { p256dh: P256DH, auth: AUTH },
        },
      },
    ],
  ])("rejects %s", async (_name, over) => {
    const { env, rows } = setup();
    const res = await call(env, "PUT", "/api/push/subscription", subscribeBody(undefined, over));
    expect(res.status).toBe(400);
    expect(rows()).toHaveLength(0);
  });

  it("requires a session, JSON and the exact Origin", async () => {
    const { env, rows } = setup();
    const put = (opts: Opts) => call(env, "PUT", "/api/push/subscription", subscribeBody(), opts);
    expect((await put({ user: null })).status).toBe(401);
    expect((await put({ origin: "https://evil.example" })).status).toBe(403);
    expect((await put({ origin: null })).status).toBe(403);
    expect((await put({ contentType: "text/plain" })).status).toBe(415);
    expect(rows()).toHaveLength(0);
  });

  it("rejects other methods", async () => {
    const { env } = setup();
    expect((await call(env, "GET", "/api/push/subscription")).status).toBe(405);
  });
});

describe("DELETE /api/push/subscription", () => {
  it("removes the user's own endpoint", async () => {
    const { env, rows } = setup();
    await call(env, "PUT", "/api/push/subscription", subscribeBody());
    const res = await call(env, "DELETE", "/api/push/subscription", {
      endpoint: "https://fcm.googleapis.com/fcm/send/a",
    });
    expect(res.status).toBe(200);
    expect(rows()).toHaveLength(0);
  });

  it("cannot delete another user's endpoint, and answers the same", async () => {
    const { env, rows } = setup();
    await call(env, "PUT", "/api/push/subscription", subscribeBody());
    const res = await call(
      env,
      "DELETE",
      "/api/push/subscription",
      { endpoint: "https://fcm.googleapis.com/fcm/send/a" },
      { user: "u2" },
    );
    expect(res.status).toBe(200);
    expect(rows()).toHaveLength(1);
  });

  it("requires a session", async () => {
    const { env } = setup();
    const res = await call(
      env,
      "DELETE",
      "/api/push/subscription",
      { endpoint: "x" },
      { user: null },
    );
    expect(res.status).toBe(401);
  });
});

describe("per-user subscription cap", () => {
  const endpoint = (i: number) =>
    `https://fcm.googleapis.com/fcm/send/d${String(i).padStart(2, "0")}`;

  it("replaces the user's oldest device when a new one goes over the cap", async () => {
    const { env, rows } = setup();
    for (let i = 0; i < MAX_SUBSCRIPTIONS_PER_USER; i++) {
      env.now = () => NOW + i;
      expect(
        (await call(env, "PUT", "/api/push/subscription", subscribeBody(endpoint(i)))).status,
      ).toBe(200);
    }
    await call(
      env,
      "PUT",
      "/api/push/subscription",
      subscribeBody("https://fcm.googleapis.com/fcm/send/x"),
      {
        user: "u2",
      },
    );
    env.now = () => NOW + 100;
    const res = await call(env, "PUT", "/api/push/subscription", subscribeBody(endpoint(99)));
    expect(res.status).toBe(200);
    const mine = rows()
      .filter((r) => r.user_id === "u1")
      .map((r) => r.endpoint);
    expect(mine).toHaveLength(MAX_SUBSCRIPTIONS_PER_USER);
    expect(mine).not.toContain(endpoint(0));
    expect(mine).toContain(endpoint(99));
    // Other users are untouched.
    expect(rows().filter((r) => r.user_id === "u2")).toHaveLength(1);
  });

  it("re-saving an existing device at the cap keeps every device", async () => {
    const { env, rows } = setup();
    for (let i = 0; i < MAX_SUBSCRIPTIONS_PER_USER; i++) {
      env.now = () => NOW + i;
      await call(env, "PUT", "/api/push/subscription", subscribeBody(endpoint(i)));
    }
    env.now = () => NOW + 100;
    await call(env, "PUT", "/api/push/subscription", subscribeBody(endpoint(0)));
    expect(rows().map((r) => r.endpoint)).toEqual(
      Array.from({ length: MAX_SUBSCRIPTIONS_PER_USER }, (_, i) => endpoint(i)),
    );
  });
});

describe("POST /api/push/practised", () => {
  it("records the day on all of the user's devices only", async () => {
    const { env, rows } = setup();
    await call(
      env,
      "PUT",
      "/api/push/subscription",
      subscribeBody("https://fcm.googleapis.com/fcm/send/a"),
    );
    await call(
      env,
      "PUT",
      "/api/push/subscription",
      subscribeBody("https://fcm.googleapis.com/fcm/send/b"),
    );
    await call(
      env,
      "PUT",
      "/api/push/subscription",
      subscribeBody("https://fcm.googleapis.com/fcm/send/c"),
      {
        user: "u2",
      },
    );
    const res = await call(env, "POST", "/api/push/practised", { day: "2026-10-12" });
    expect(res.status).toBe(200);
    expect(rows().map((r) => [r.user_id, r.last_practised_day])).toEqual([
      ["u1", "2026-10-12"],
      ["u1", "2026-10-12"],
      ["u2", null],
    ]);
  });

  it("never moves the practised day backwards", async () => {
    const { env, rows } = setup();
    await call(env, "PUT", "/api/push/subscription", subscribeBody());
    await call(env, "POST", "/api/push/practised", { day: "2026-10-12" });
    await call(env, "POST", "/api/push/practised", { day: "2026-10-11" });
    expect(rows()[0]?.last_practised_day).toBe("2026-10-12");
  });

  it.each([["not a day"], ["2026-13-45"], ["2020-01-01"], ["2030-01-01"]])(
    "rejects %s",
    async (day) => {
      const { env } = setup();
      expect((await call(env, "POST", "/api/push/practised", { day })).status).toBe(400);
    },
  );

  it("requires a session", async () => {
    const { env } = setup();
    const res = await call(
      env,
      "POST",
      "/api/push/practised",
      { day: "2026-10-12" },
      { user: null },
    );
    expect(res.status).toBe(401);
  });
});

describe("isCalendarDay", () => {
  it.each([
    ["2026-10-12", true],
    ["2024-02-29", true],
    ["2026-02-29", false],
    ["2026-02-31", false],
    ["2026-04-31", false],
    ["2026-13-01", false],
    ["2026-1-01", false],
  ])("%s", (day, ok) => {
    expect(isCalendarDay(day)).toBe(ok);
  });
});

describe("subscribe logging", () => {
  it("logs the host, never the endpoint path, when the allowlist refuses an endpoint", async () => {
    const { env } = setup();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const res = await call(
      env,
      "PUT",
      "/api/push/subscription",
      subscribeBody("https://push.newbrowser.example/secret-token"),
    );
    expect(res.status).toBe(400);
    expect(warn).toHaveBeenCalledOnce();
    const message = String(warn.mock.calls[0]?.[0]);
    expect(message).toContain("push.newbrowser.example");
    expect(message).not.toContain("secret-token");
    warn.mockRestore();
  });

  it("does not log other invalid bodies", async () => {
    const { env } = setup();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await call(
      env,
      "PUT",
      "/api/push/subscription",
      subscribeBody(undefined, { tzOffsetMin: 9999 }),
    );
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe("isAcceptableEndpoint", () => {
  it.each([
    ["https://fcm.googleapis.com/fcm/send/abc", true],
    ["https://web.push.apple.com/QAbc", true],
    ["https://updates.push.services.mozilla.com/wpush/v2/abc", true],
    ["https://wns2-par02p.notify.windows.com/w/?token=abc", true],
    ["https://FCM.GoogleAPIs.com/fcm/send/abc", true],
    ["https://push.example.com/x", false],
    ["https://fcm.googleapis.com.evil.example/x", false],
    ["https://evilfcm.googleapis.com/x", false],
    ["https://googleapis.com/x", false],
    ["https://apple.com/x", false],
    ["https://fcm.googleapis.com:8443/x", false],
    ["http://fcm.googleapis.com/x", false],
    ["https://localhost/x", false],
    ["https://127.0.0.1/x", false],
    ["https://[::1]/x", false],
    ["https://intranet/x", false],
    ["https://push.example.com:8443/x", false],
    ["https://user:pw@push.example.com/x", false],
    ["https://router.local/x", false],
    ["not a url", false],
  ])("%s", (url, ok) => {
    expect(isAcceptableEndpoint(url)).toBe(ok);
  });
});
