import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import worker from "../index";
import { d1Sql } from "../auth/sql";
import { toBase64Url } from "../auth/session";
import { fakeD1, makeEnv } from "../test-support";
import { weekdaysToMask } from "./due";
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
        endpoint: `https://push.example.com/${name}`,
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
  const state = (): Record<string, string | null> => {
    const rows = sqlite
      .prepare("SELECT endpoint, last_sent_day FROM push_subscriptions")
      .all() as unknown as { endpoint: string; last_sent_day: string | null }[];
    const out: Record<string, string | null> = {};
    for (const r of rows) out[r.endpoint.split("/").pop() ?? ""] = r.last_sent_day;
    return out;
  };
  return { env, sqlite, add, state };
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
      "https://push.example.com/due-also",
      "https://push.example.com/due-sydney",
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
    expect(http.urls).toEqual(["https://push.example.com/a"]);
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
    expect(retry.urls).toEqual(["https://push.example.com/flaky"]);
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
    expect(bodies.get("https://push.example.com/habit")).toBe(
      len("After my morning coffee") + overhead,
    );
    expect(bodies.get("https://push.example.com/plain")).toBe(len(CUE_DEFAULT_BODY) + overhead);
  });

  it("caps sends per run to stay inside the subrequest limit", async () => {
    const { env, add } = await setup();
    for (let i = 0; i < MAX_SENDS_PER_RUN + 5; i++) await add(`s${String(i)}`);
    const http = fakeFetch();
    const result = await runPracticeCues(env, { nowMs: NOW, fetch: http.fn });
    expect(result).toMatchObject({ due: MAX_SENDS_PER_RUN + 5, sent: MAX_SENDS_PER_RUN });
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
    expect(urls).toEqual(["https://push.example.com/a"]);
    expect(state()).toEqual({ a: "2026-10-12" });
  });
});
