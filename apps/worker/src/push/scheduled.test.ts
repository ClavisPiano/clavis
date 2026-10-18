import { DatabaseSync } from "node:sqlite";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import worker from "../index";
import { d1Sql } from "../auth/sql";
import { toBase64Url } from "../auth/session";
import { fakeD1, makeEnv } from "../test-support";
import { CUE_WINDOW_MIN, cueUtcMinute, isDue, weekdaysToMask } from "./due";
import { ecKeyPair } from "./test-keys";
import { createPushRepo, type NewPushSubscription } from "./repo";
import { CUE_DEFAULT_BODY, CUE_TITLE, MAX_SENDS_PER_RUN, runPracticeCues } from "./scheduled";

// Monday 2026-10-12 08:05 in Sydney (+600) is Sunday 22:05 UTC.
const NOW = Date.UTC(2026, 9, 11, 22, 5, 0);

async function keyMaterial() {
  const ecdh = await ecKeyPair("ECDH");
  return {
    p256dh: toBase64Url(ecdh.publicRaw),
    auth: toBase64Url(crypto.getRandomValues(new Uint8Array(16))),
  };
}

async function setup() {
  const sqlite = new DatabaseSync(":memory:");
  const vapid = await ecKeyPair("ECDSA");
  const { env } = makeEnv({
    DB: fakeD1(sqlite),
    now: () => NOW,
    VAPID_PUBLIC_KEY: toBase64Url(vapid.publicRaw),
    VAPID_PRIVATE_KEY: vapid.privateJwk.d ?? "",
    VAPID_SUBJECT: "mailto:ops@clavis.example",
  });
  sqlite.prepare("INSERT INTO users (id, created_at) VALUES ('u1', 0)").run();
  const repo = createPushRepo(d1Sql(env.DB));
  const add = async (name: string, over: Partial<NewPushSubscription> = {}) => {
    await repo.upsert(
      {
        endpoint: `https://fcm.googleapis.com/fcm/send/${name}`,
        userId: "u1",
        ...(await keyMaterial()),
        timeLocal: "08:00",
        weekdays: weekdaysToMask([1]),
        tzOffsetMin: 600,
        habit: "After my morning coffee",
        ...over,
      },
      0,
    );
  };
  // One user per device, for tests with more devices than one user may hold.
  let users = 0;
  const addForUser = async (name: string, over: Partial<NewPushSubscription> = {}) => {
    const userId = `user${String(users++)}`;
    sqlite.prepare("INSERT INTO users (id, created_at) VALUES (?, 0)").run(userId);
    await add(name, { userId, ...over });
  };
  const state = (): Record<string, string | null> => {
    const rows = sqlite
      .prepare("SELECT endpoint, last_sent_day FROM push_subscriptions")
      .all() as unknown as { endpoint: string; last_sent_day: string | null }[];
    const out: Record<string, string | null> = {};
    for (const r of rows) out[r.endpoint.split("/").pop() ?? ""] = r.last_sent_day;
    return out;
  };
  return { env, sqlite, add, addForUser, state };
}

function fakeFetch(statusFor: (url: string) => number = () => 201) {
  const urls: string[] = [];
  const fn = ((url: string) => {
    urls.push(url);
    return Promise.resolve(new Response(null, { status: statusFor(url) }));
  }) as unknown as typeof fetch;
  return { fn, urls };
}

describe("runPracticeCues", () => {
  it("sends exactly the due cues and marks them sent for their learner day", async () => {
    const { env, add, state, sqlite } = await setup();
    await add("due-sydney");
    await add("due-also", { weekdays: weekdaysToMask([0, 1]) });
    await add("new-york", { tzOffsetMin: -300 }); // 17:05 Sunday there
    await add("wrong-weekday", { weekdays: weekdaysToMask([2, 3]) });
    await add("later", { timeLocal: "09:00" });
    await add("sent-today");
    await add("practised-today");
    sqlite.exec(
      "UPDATE push_subscriptions SET last_sent_day = '2026-10-12' WHERE endpoint LIKE '%/sent-today'",
    );
    sqlite.exec(
      "UPDATE push_subscriptions SET last_practised_day = '2026-10-12' WHERE endpoint LIKE '%/practised-today'",
    );
    const http = fakeFetch();
    const first = await runPracticeCues(env, { nowMs: NOW, fetch: http.fn });
    expect(first).toMatchObject({ due: 2, sent: 2, pruned: 0, failed: 0 });
    expect(http.urls.sort()).toEqual([
      "https://fcm.googleapis.com/fcm/send/due-also",
      "https://fcm.googleapis.com/fcm/send/due-sydney",
    ]);
    expect(state()).toEqual({
      "due-sydney": "2026-10-12",
      "due-also": "2026-10-12",
      "new-york": null,
      "wrong-weekday": null,
      later: null,
      "sent-today": "2026-10-12",
      "practised-today": null,
    });
  });

  it("does not resend on the next tick, nor to cues already sent or practised", async () => {
    const { env, add, sqlite } = await setup();
    await add("a");
    await add("sent", {});
    await add("practised");
    sqlite.exec(
      "UPDATE push_subscriptions SET last_sent_day = '2026-10-12' WHERE endpoint LIKE '%/sent'",
    );
    sqlite.exec(
      "UPDATE push_subscriptions SET last_practised_day = '2026-10-12' WHERE endpoint LIKE '%/practised'",
    );
    const http = fakeFetch();
    await runPracticeCues(env, { nowMs: NOW, fetch: http.fn });
    expect(http.urls).toEqual(["https://fcm.googleapis.com/fcm/send/a"]);
    await runPracticeCues(env, { nowMs: NOW + 15 * 60_000, fetch: http.fn });
    await runPracticeCues(env, { nowMs: NOW, fetch: http.fn });
    expect(http.urls).toHaveLength(1);
  });

  it("prunes endpoints answering 404 or 410 and keeps failures for the next tick", async () => {
    const { env, add, state } = await setup();
    await add("ok");
    await add("gone410");
    await add("gone404");
    await add("flaky");
    const http = fakeFetch((url) =>
      url.endsWith("gone410")
        ? 410
        : url.endsWith("gone404")
          ? 404
          : url.endsWith("flaky")
            ? 503
            : 201,
    );
    const result = await runPracticeCues(env, { nowMs: NOW, fetch: http.fn });
    expect(result).toMatchObject({ due: 4, sent: 1, pruned: 2, failed: 1 });
    expect(state()).toEqual({ ok: "2026-10-12", flaky: null });
    // The flaky one is retried on the next tick, the sent one is not.
    const retry = fakeFetch();
    await runPracticeCues(env, { nowMs: NOW + 15 * 60_000 - 6 * 60_000, fetch: retry.fn });
    expect(retry.urls).toEqual(["https://fcm.googleapis.com/fcm/send/flaky"]);
  });

  it("sends the notification payload with the habit phrase, or a default", async () => {
    const { env, add } = await setup();
    await add("habit");
    await add("plain", { habit: "" });
    const bodies = new Map<string, number>();
    const http = ((url: string, init: RequestInit) => {
      bodies.set(url, (init.body as Uint8Array).length);
      return Promise.resolve(new Response(null, { status: 201 }));
    }) as unknown as typeof fetch;
    await runPracticeCues(env, { nowMs: NOW, fetch: http });
    expect(bodies.size).toBe(2);
    // Ciphertext length is plaintext + 21 header + 65 key + 16 tag + 1 delimiter.
    const len = (text: string) =>
      new TextEncoder().encode(JSON.stringify({ title: CUE_TITLE, body: text, url: "/" })).length;
    const overhead = 21 + 65 + 16 + 1;
    expect(bodies.get("https://fcm.googleapis.com/fcm/send/habit")).toBe(
      len("After my morning coffee") + overhead,
    );
    expect(bodies.get("https://fcm.googleapis.com/fcm/send/plain")).toBe(
      len(CUE_DEFAULT_BODY) + overhead,
    );
  });

  it("caps sends per run to stay inside the subrequest limit", async () => {
    const { env, addForUser } = await setup();
    for (let i = 0; i < MAX_SENDS_PER_RUN + 5; i++) await addForUser(`s${String(i)}`);
    const http = fakeFetch();
    const result = await runPracticeCues(env, { nowMs: NOW, fetch: http.fn });
    expect(result).toMatchObject({ due: MAX_SENDS_PER_RUN + 5, sent: MAX_SENDS_PER_RUN });
  });

  it("reports cues left over by the cap, and those whose window closes before the next run", async () => {
    const { env, addForUser } = await setup();
    for (let i = 0; i < MAX_SENDS_PER_RUN + 5; i++) await addForUser(`s${String(i)}`);
    const first = await runPracticeCues(env, { nowMs: NOW, fetch: fakeFetch().fn });
    // 5 minutes after the cue: the next run (15 minutes later) is still inside the window.
    expect(first).toMatchObject({ deferred: 5, dropped: 0 });
    const { env: env2, addForUser: add2 } = await setup();
    for (let i = 0; i < MAX_SENDS_PER_RUN + 5; i++) await add2(`t${String(i)}`);
    // 20 minutes after the cue: the next run would be past the 30 minute window.
    const late = await runPracticeCues(env2, { nowMs: NOW + 15 * 60_000, fetch: fakeFetch().fn });
    expect(late).toMatchObject({ due: MAX_SENDS_PER_RUN + 5, deferred: 5, dropped: 5 });
  });

  it("sends cues left over by the cap on the next run, before newly due ones, and only once", async () => {
    const { env, addForUser, state } = await setup();
    for (let i = 0; i < MAX_SENDS_PER_RUN + 5; i++) await addForUser(`early${String(i)}`);
    // Due from 08:15 local, so they compete with the leftovers on the next run.
    for (let i = 0; i < MAX_SENDS_PER_RUN; i++) {
      await addForUser(`late${String(i)}`, { timeLocal: "08:15" });
    }
    await runPracticeCues(env, { nowMs: NOW, fetch: fakeFetch().fn });
    const next = fakeFetch();
    const result = await runPracticeCues(env, { nowMs: NOW + 15 * 60_000, fetch: next.fn });
    expect(result.sent).toBe(MAX_SENDS_PER_RUN);
    const early = Object.entries(state()).filter(([name]) => name.startsWith("early"));
    expect(early.every(([, day]) => day === "2026-10-12")).toBe(true);
    // Every early cue went out exactly once across the two runs.
    const third = fakeFetch();
    await runPracticeCues(env, { nowMs: NOW + 15 * 60_000, fetch: third.fn });
    expect(third.urls.some((u) => u.includes("/early"))).toBe(false);
    expect(next.urls.filter((u) => u.includes("/early"))).toHaveLength(5);
  });

  it("prunes stored endpoints outside the push service allowlist without sending to them", async () => {
    const { env, add, sqlite, state } = await setup();
    await add("ok");
    sqlite
      .prepare(
        `INSERT INTO push_subscriptions
           (endpoint, user_id, p256dh, auth, time_local, weekdays, tz_offset_min, habit, created_at)
         SELECT 'https://attacker.example/hook', user_id, p256dh, auth, time_local, weekdays,
                tz_offset_min, habit, created_at FROM push_subscriptions`,
      )
      .run();
    const http = fakeFetch();
    const result = await runPracticeCues(env, { nowMs: NOW, fetch: http.fn });
    expect(http.urls).toEqual(["https://fcm.googleapis.com/fcm/send/ok"]);
    expect(result).toMatchObject({ sent: 1, pruned: 1 });
    expect(state()).toEqual({ ok: "2026-10-12" });
  });

  it("does nothing without VAPID keys", async () => {
    const { env, add } = await setup();
    await add("a");
    const http = fakeFetch();
    const result = await runPracticeCues(
      { ...env, VAPID_PRIVATE_KEY: "" },
      { nowMs: NOW, fetch: http.fn },
    );
    expect(result.due).toBe(0);
    expect(http.urls).toHaveLength(0);
  });
});

describe("worker scheduled handler", () => {
  it("runs the cue job at the scheduled time", async () => {
    const { env, add, state } = await setup();
    await add("a");
    const real = globalThis.fetch;
    const urls: string[] = [];
    globalThis.fetch = ((url: string) => {
      urls.push(url);
      return Promise.resolve(new Response(null, { status: 201 }));
    }) as unknown as typeof fetch;
    const pending: Promise<unknown>[] = [];
    try {
      worker.scheduled({ scheduledTime: NOW, cron: "*/15 * * * *" } as ScheduledController, env, {
        waitUntil: (p: Promise<unknown>) => void pending.push(p),
      } as unknown as ExecutionContext);
      await Promise.all(pending);
    } finally {
      globalThis.fetch = real;
    }
    expect(urls).toEqual(["https://fcm.googleapis.com/fcm/send/a"]);
    expect(state()).toEqual({ a: "2026-10-12" });
  });
});

describe("cueUtcMinute", () => {
  it.each([
    ["08:00", 600, 1320], // Sydney 08:00 is 22:00 UTC the day before
    ["08:00", -300, 780], // New York 08:00 is 13:00 UTC
    ["00:30", 600, 870], // wraps below midnight
    ["23:30", -300, 270], // wraps above midnight
    ["12:00", 0, 720],
  ])("%s at offset %i is UTC minute %i", (time, offset, expected) => {
    expect(cueUtcMinute(time, offset)).toBe(expected);
  });

  it("is null for a malformed time", () => {
    expect(cueUtcMinute("8am", 0)).toBeNull();
    expect(cueUtcMinute("24:00", 0)).toBeNull();
  });
});

describe("listNearDue", () => {
  it("returns only rows near their cue time, and fixes rows stored without a UTC minute", async () => {
    const { env, add, sqlite } = await setup();
    await add("now"); // Sydney 08:00 is due at NOW
    await add("hours-later", { timeLocal: "14:00" });
    await add("new-york", { tzOffsetMin: -300 }); // 17:05 there: past the window
    sqlite
      .prepare(
        `INSERT INTO push_subscriptions
           (endpoint, user_id, p256dh, auth, time_local, weekdays, tz_offset_min, habit, created_at)
         SELECT 'https://fcm.googleapis.com/fcm/send/legacy', user_id, p256dh, auth, '08:00', weekdays,
                600, habit, created_at FROM push_subscriptions WHERE endpoint LIKE '%/now'`,
      )
      .run();
    const repo = createPushRepo(d1Sql(env.DB));
    const names = (await repo.listNearDue(NOW)).map((r) => r.endpoint.split("/").pop()).sort();
    expect(names).toEqual(["legacy", "now"]);
    const stored = sqlite
      .prepare("SELECT cue_utc_min FROM push_subscriptions WHERE endpoint LIKE '%/legacy'")
      .all() as unknown as { cue_utc_min: number | null }[];
    expect(stored[0]?.cue_utc_min).toBe(1320);
  });

  it("never misses a cue that isDue accepts (property)", async () => {
    const { env, sqlite } = await setup();
    const repo = createPushRepo(d1Sql(env.DB));
    let n = 0;
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 0, max: 23 }),
        fc.integer({ min: 0, max: 59 }),
        fc.integer({ min: -720, max: 840 }),
        fc.integer({ min: 0, max: 7 * 1440 }),
        async (hh, mm, tz, minutesIntoWeek) => {
          const time = `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
          const endpoint = `https://fcm.googleapis.com/fcm/send/p${String(n++)}`;
          const row = {
            endpoint,
            userId: "u1",
            p256dh: "x",
            auth: "y",
            timeLocal: time,
            weekdays: 127,
            tzOffsetMin: tz,
            habit: "",
            lastSentDay: null,
            lastPractisedDay: null,
          };
          sqlite
            .prepare(
              `INSERT INTO push_subscriptions
                 (endpoint, user_id, p256dh, auth, time_local, weekdays, tz_offset_min, habit,
                  created_at, cue_utc_min)
               VALUES (?, 'u1', 'x', 'y', ?, 127, ?, '', 0, ?)`,
            )
            .run(endpoint, time, tz, cueUtcMinute(time, tz));
          const now = Date.UTC(2026, 9, 11) + minutesIntoWeek * 60_000;
          const near = (await repo.listNearDue(now)).some((r) => r.endpoint === endpoint);
          if (isDue(row, now)) expect(near).toBe(true);
          sqlite.prepare("DELETE FROM push_subscriptions WHERE endpoint = ?").run(endpoint);
        },
      ),
      { numRuns: 200 },
    );
    expect(CUE_WINDOW_MIN).toBe(30);
  });
});
