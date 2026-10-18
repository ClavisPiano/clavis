import { describe, expect, it } from "vitest";
import worker from "../index";
import type { Env } from "../env";
import { ORIGIN, RP_ID, fakeLimiter, makeEnv } from "../test-support";
import {
  CHALLENGE_TTL_MS,
  RATE_LIMIT_RETRY_AFTER_S,
  RECOVERY_CODE_COUNT,
  SESSION_TTL_SECONDS,
} from "./handlers";
import { SoftwareAuthenticator } from "./software-authenticator";

interface Opts {
  origin?: string | null;
  contentType?: string | null;
  cookie?: string;
  ip?: string;
}

const post = (env: Env, path: string, body: unknown, opts: Opts = {}) => {
  const headers: Record<string, string> = {};
  if (opts.contentType !== null) headers["content-type"] = opts.contentType ?? "application/json";
  if (opts.origin !== null) headers.origin = opts.origin ?? ORIGIN;
  if (opts.cookie) headers.cookie = opts.cookie;
  if (opts.ip) headers["cf-connecting-ip"] = opts.ip;
  return worker.fetch(
    new Request(`${ORIGIN}${path}`, { method: "POST", headers, body: JSON.stringify(body) }),
    env,
  );
};

const get = (env: Env, path: string, cookie?: string) =>
  worker.fetch(new Request(`${ORIGIN}${path}`, { headers: cookie ? { cookie } : {} }), env);

interface Issued {
  challengeId: string;
  options: { challenge: string } & Record<string, unknown>;
}

const cookieOf = (res: Response): string => {
  const header = res.headers.get("set-cookie") ?? "";
  return header.split(";")[0] ?? "";
};

function setup(start = Date.now()) {
  const clock = { t: start };
  const { env } = makeEnv({ now: () => clock.t });
  return { env, clock, device: new SoftwareAuthenticator(RP_ID, ORIGIN) };
}

async function register(env: Env, device: SoftwareAuthenticator) {
  const optRes = await post(env, "/api/auth/register/options", {});
  expect(optRes.status).toBe(200);
  const issued = await optRes.json<Issued>();
  const response = await device.register({ challenge: issued.options.challenge });
  const res = await post(env, "/api/auth/register/verify", {
    challengeId: issued.challengeId,
    response,
  });
  return { res, issued, response };
}

async function login(env: Env, device: SoftwareAuthenticator, counter?: number) {
  const issued = await (await post(env, "/api/auth/login/options", {})).json<Issued>();
  const response = await device.assert(
    { challenge: issued.options.challenge },
    counter === undefined ? {} : { counter },
  );
  return post(env, "/api/auth/login/verify", { challengeId: issued.challengeId, response });
}

describe("register", () => {
  it("issues options for a new anonymous user", async () => {
    const { env } = setup();
    const res = await post(env, "/api/auth/register/options", {});
    expect(res.status).toBe(200);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    const { challengeId, options } = await res.json<
      Issued & {
        options: {
          rp: { id: string; name: string };
          authenticatorSelection: { residentKey: string; userVerification: string };
        };
      }
    >();
    expect(challengeId).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(options.rp).toEqual({ id: RP_ID, name: "Clavis" });
    expect(options.authenticatorSelection).toMatchObject({
      residentKey: "required",
      userVerification: "preferred",
    });
  });

  it("verifies, sets the session cookie and returns ten recovery codes once", async () => {
    const { env, device } = setup();
    const { res } = await register(env, device);
    expect(res.status).toBe(200);
    const body = await res.json<{ userId: string; recoveryCodes: string[] }>();
    expect(body.userId).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(body.recoveryCodes).toHaveLength(RECOVERY_CODE_COUNT);
    expect(new Set(body.recoveryCodes).size).toBe(RECOVERY_CODE_COUNT);
    for (const code of body.recoveryCodes) expect(code).toMatch(/^([A-Z2-9]{4}-){3}[A-Z2-9]{4}$/);
    const setCookie = res.headers.get("set-cookie") ?? "";
    expect(setCookie).toMatch(/^__Host-clavis_session=[^;]+;/);
    for (const attr of ["HttpOnly", "Secure", "SameSite=Lax", "Path=/"]) {
      expect(setCookie).toContain(attr);
    }
    expect(setCookie).toContain(`Max-Age=${String(SESSION_TTL_SECONDS)}`);
    expect(SESSION_TTL_SECONDS).toBe(30 * 24 * 3600);
  });

  it("rejects a replayed challenge", async () => {
    const { env, device } = setup();
    const { issued, response } = await register(env, device);
    const again = await post(env, "/api/auth/register/verify", {
      challengeId: issued.challengeId,
      response,
    });
    expect(again.status).toBe(400);
    expect(await again.json()).toEqual({ error: "invalid_challenge" });
  });

  it("consumes the challenge even when verification fails", async () => {
    const { env, device } = setup();
    const issued = await (await post(env, "/api/auth/register/options", {})).json<Issued>();
    const bad = await device.register(
      { challenge: issued.options.challenge },
      { challenge: "AAAA" },
    );
    const first = await post(env, "/api/auth/register/verify", {
      challengeId: issued.challengeId,
      response: bad,
    });
    expect(first.status).toBe(400);
    expect(await first.json()).toEqual({ error: "verification_failed" });
    const good = await device.register({ challenge: issued.options.challenge });
    const second = await post(env, "/api/auth/register/verify", {
      challengeId: issued.challengeId,
      response: good,
    });
    expect(await second.json()).toEqual({ error: "invalid_challenge" });
  });

  it("rejects an expired challenge", async () => {
    const { env, clock, device } = setup();
    const issued = await (await post(env, "/api/auth/register/options", {})).json<Issued>();
    const response = await device.register({ challenge: issued.options.challenge });
    clock.t += CHALLENGE_TTL_MS + 1;
    const res = await post(env, "/api/auth/register/verify", {
      challengeId: issued.challengeId,
      response,
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_challenge" });
  });

  it("accepts a challenge just inside the expiry window", async () => {
    const { env, clock, device } = setup();
    const issued = await (await post(env, "/api/auth/register/options", {})).json<Issued>();
    const response = await device.register({ challenge: issued.options.challenge });
    clock.t += CHALLENGE_TTL_MS - 1;
    const res = await post(env, "/api/auth/register/verify", {
      challengeId: issued.challengeId,
      response,
    });
    expect(res.status).toBe(200);
  });

  it("rejects an assertion origin that does not match", async () => {
    const { env } = setup();
    const evil = new SoftwareAuthenticator(RP_ID, "https://evil.example");
    const { res } = await register(env, evil);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "verification_failed" });
  });

  it("rejects an unknown challenge id and a challenge of the wrong kind", async () => {
    const { env, device } = setup();
    const unknown = await post(env, "/api/auth/register/verify", {
      challengeId: "nope",
      response: await device.register({ challenge: "AAAA" }),
    });
    expect(await unknown.json()).toEqual({ error: "invalid_challenge" });
    const login = await (await post(env, "/api/auth/login/options", {})).json<Issued>();
    const wrongKind = await post(env, "/api/auth/register/verify", {
      challengeId: login.challengeId,
      response: await device.register({ challenge: login.options.challenge }),
    });
    expect(await wrongKind.json()).toEqual({ error: "invalid_challenge" });
  });

  it("rejects malformed bodies", async () => {
    const { env } = setup();
    const res = await post(env, "/api/auth/register/verify", { challengeId: 5 });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_request" });
  });
});

describe("csrf and routing", () => {
  it("rejects a wrong or missing Origin header", async () => {
    const { env } = setup();
    for (const origin of ["https://evil.example", null]) {
      const res = await post(env, "/api/auth/register/options", {}, { origin });
      expect(res.status).toBe(403);
    }
  });

  it("requires a JSON content type", async () => {
    const { env } = setup();
    for (const contentType of ["text/plain", "application/x-www-form-urlencoded", null]) {
      const res = await post(env, "/api/auth/register/options", {}, { contentType });
      expect(res.status).toBe(415);
    }
    const ok = await post(
      env,
      "/api/auth/register/options",
      {},
      { contentType: "application/json; charset=utf-8" },
    );
    expect(ok.status).toBe(200);
  });

  it("uses the right methods and 404s unknown auth paths", async () => {
    const { env } = setup();
    const getPost = await get(env, "/api/auth/login/options");
    expect(getPost.status).toBe(405);
    expect(getPost.headers.get("allow")).toBe("POST");
    const postMe = await post(env, "/api/me", {});
    expect(postMe.status).toBe(405);
    const missing = await post(env, "/api/auth/nope", {});
    expect(missing.status).toBe(404);
  });
});

describe("login", () => {
  it("registers then logs in, and the cookie works on /api/sync/pull", async () => {
    const { env, device } = setup();
    const reg = await register(env, device);
    const { userId } = await reg.res.json<{ userId: string }>();

    const res = await login(env, device);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ userId });
    const cookie = cookieOf(res);
    expect(cookie).toMatch(/^__Host-clavis_session=.+/);

    const pull = await get(env, "/api/sync/pull?after=0", cookie);
    expect(pull.status).toBe(200);
    expect(await pull.json()).toMatchObject({ events: [], hasMore: false });
    expect((await get(env, "/api/sync/pull?after=0")).status).toBe(401);
  });

  it("rejects a replayed login challenge", async () => {
    const { env, device } = setup();
    await register(env, device);
    const issued = await (await post(env, "/api/auth/login/options", {})).json<Issued>();
    const response = await device.assert({ challenge: issued.options.challenge });
    const body = { challengeId: issued.challengeId, response };
    expect((await post(env, "/api/auth/login/verify", body)).status).toBe(200);
    const replay = await post(env, "/api/auth/login/verify", body);
    expect(replay.status).toBe(400);
  });

  it("rejects an expired login challenge", async () => {
    const { env, clock, device } = setup();
    await register(env, device);
    const issued = await (await post(env, "/api/auth/login/options", {})).json<Issued>();
    const response = await device.assert({ challenge: issued.options.challenge });
    clock.t += CHALLENGE_TTL_MS + 1;
    const res = await post(env, "/api/auth/login/verify", {
      challengeId: issued.challengeId,
      response,
    });
    expect(res.status).toBe(400);
  });

  it("rejects a counter regression (cloned authenticator)", async () => {
    const { env, device } = setup();
    await register(env, device);
    expect((await login(env, device, 5)).status).toBe(200);
    const regressed = await login(env, device, 3);
    expect(regressed.status).toBe(401);
    expect(regressed.headers.get("set-cookie")).toBeNull();
    const same = await login(env, device, 5);
    expect(same.status).toBe(401);
    expect((await login(env, device, 6)).status).toBe(200);
  });

  it("rejects an unknown credential and a bad signature", async () => {
    const { env, device } = setup();
    await register(env, device);
    const stranger = new SoftwareAuthenticator(RP_ID, ORIGIN);
    expect((await login(env, stranger)).status).toBe(401);

    // Same credential id, different key.
    const impostor = new SoftwareAuthenticator(RP_ID, ORIGIN);
    Object.defineProperty(impostor, "credentialId", { value: device.credentialId });
    expect((await login(env, impostor)).status).toBe(401);
  });

  it("rejects a login whose clientData origin is wrong", async () => {
    const { env, device } = setup();
    await register(env, device);
    const issued = await (await post(env, "/api/auth/login/options", {})).json<Issued>();
    const response = await device.assert(
      { challenge: issued.options.challenge },
      { origin: "https://evil.example" },
    );
    const res = await post(env, "/api/auth/login/verify", {
      challengeId: issued.challengeId,
      response,
    });
    expect(res.status).toBe(401);
  });
});

describe("session, me and logout", () => {
  it("/api/me needs a valid session and has the documented shape", async () => {
    const { env, device } = setup();
    expect((await get(env, "/api/me")).status).toBe(401);
    expect((await get(env, "/api/me", "__Host-clavis_session=garbage")).status).toBe(401);
    const reg = await register(env, device);
    const { userId } = await reg.res.json<{ userId: string }>();
    const res = await get(env, "/api/me", cookieOf(reg.res));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ userId, passkeys: 1, recoveryCodesLeft: 10 });
  });

  it("sessions expire after 30 days", async () => {
    const { env, clock, device } = setup();
    const reg = await register(env, device);
    const cookie = cookieOf(reg.res);
    clock.t += (SESSION_TTL_SECONDS - 10) * 1000;
    expect((await get(env, "/api/me", cookie)).status).toBe(200);
    clock.t += 20 * 1000;
    expect((await get(env, "/api/me", cookie)).status).toBe(401);
  });

  it("logout clears the cookie", async () => {
    const { env, device } = setup();
    const reg = await register(env, device);
    const res = await post(env, "/api/auth/logout", {}, { cookie: cookieOf(reg.res) });
    expect(res.status).toBe(200);
    const setCookie = res.headers.get("set-cookie") ?? "";
    expect(setCookie).toMatch(/^__Host-clavis_session=;/);
    // The pre-prefix cookie is cleared too, so a user is not left holding a stale one.
    expect(setCookie).toContain("clavis_session=;");
    expect(setCookie).toContain("Max-Age=0");
    expect(setCookie).toContain("HttpOnly");
  });
});

describe("recovery codes", () => {
  it("works once, then fails", async () => {
    const { env, device } = setup();
    const reg = await register(env, device);
    const { userId, recoveryCodes } = await reg.res.json<{
      userId: string;
      recoveryCodes: string[];
    }>();
    const code = recoveryCodes[0] ?? "";

    const ok = await post(env, "/api/auth/recovery", {
      code: code.toLowerCase().replaceAll("-", " "),
    });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ userId, recoveryCodesLeft: 9 });
    const cookie = cookieOf(ok);
    expect((await get(env, "/api/me", cookie)).status).toBe(200);

    const again = await post(env, "/api/auth/recovery", { code });
    expect(again.status).toBe(401);
    expect(again.headers.get("set-cookie")).toBeNull();
    const me = await (await get(env, "/api/me", cookie)).json<{ recoveryCodesLeft: number }>();
    expect(me.recoveryCodesLeft).toBe(9);
  });

  it("rejects unknown codes", async () => {
    const { env } = setup();
    const res = await post(env, "/api/auth/recovery", { code: "AAAA-AAAA-AAAA-AAAA" });
    expect(res.status).toBe(401);
  });
});

describe("add passkey", () => {
  it("requires a session", async () => {
    const { env, device } = setup();
    await register(env, device);
    expect((await post(env, "/api/auth/passkeys/options", {})).status).toBe(401);
    const second = new SoftwareAuthenticator(RP_ID, ORIGIN);
    const response = await second.register({ challenge: "AAAA" });
    const res = await post(env, "/api/auth/passkeys/verify", { challengeId: "x", response });
    expect(res.status).toBe(401);
  });

  it("adds a second passkey to the same user, which can then log in", async () => {
    const { env, device } = setup();
    const reg = await register(env, device);
    const { userId } = await reg.res.json<{ userId: string }>();
    const cookie = cookieOf(reg.res);

    const issued = await (
      await post(env, "/api/auth/passkeys/options", {}, { cookie })
    ).json<Issued & { options: { excludeCredentials: { id: string }[] } }>();
    expect(issued.options.excludeCredentials.map((c) => c.id)).toEqual([device.id]);

    const second = new SoftwareAuthenticator(RP_ID, ORIGIN);
    const response = await second.register({ challenge: issued.options.challenge });
    const res = await post(
      env,
      "/api/auth/passkeys/verify",
      { challengeId: issued.challengeId, response },
      { cookie },
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ userId, passkeys: 2 });

    const me = await get(env, "/api/me", cookie);
    expect(await me.json()).toMatchObject({ userId, passkeys: 2 });

    const viaSecond = await login(env, second);
    expect(viaSecond.status).toBe(200);
    expect(await viaSecond.json()).toEqual({ userId });
  });

  it("does not accept another user's add challenge or a register challenge", async () => {
    const { env, device } = setup();
    const reg = await register(env, device);
    const cookie = cookieOf(reg.res);
    const other = await register(env, new SoftwareAuthenticator(RP_ID, ORIGIN));
    const otherCookie = cookieOf(other.res);

    const issued = await (
      await post(env, "/api/auth/passkeys/options", {}, { cookie })
    ).json<Issued>();
    const third = new SoftwareAuthenticator(RP_ID, ORIGIN);
    const response = await third.register({ challenge: issued.options.challenge });
    const res = await post(
      env,
      "/api/auth/passkeys/verify",
      { challengeId: issued.challengeId, response },
      { cookie: otherCookie },
    );
    expect(res.status).toBe(400);
  });
});

describe("rate limiting", () => {
  it("limits recovery per client IP and answers 429 with retry-after", async () => {
    const { env } = setup();
    env.AUTH_RECOVERY_LIMITER = fakeLimiter(5);
    const attempt = (ip: string) =>
      post(env, "/api/auth/recovery", { code: "AAAA-AAAA-AAAA-AAAA" }, { ip });
    for (let i = 0; i < 5; i++) expect((await attempt("203.0.113.7")).status).toBe(401);
    const limited = await attempt("203.0.113.7");
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe(String(RATE_LIMIT_RETRY_AFTER_S));
    expect(await limited.json()).toEqual({ error: "rate_limited" });
    // Another client is unaffected.
    expect((await attempt("198.51.100.2")).status).toBe(401);
  });

  it("register and login share the general limiter, and recovery has its own", async () => {
    const { env } = setup();
    const general = fakeLimiter(2);
    const recovery = fakeLimiter();
    env.AUTH_LIMITER = general;
    env.AUTH_RECOVERY_LIMITER = recovery;
    const ip = "203.0.113.9";
    expect((await post(env, "/api/auth/register/options", {}, { ip })).status).toBe(200);
    expect((await post(env, "/api/auth/login/options", {}, { ip })).status).toBe(200);
    expect((await post(env, "/api/auth/login/verify", {}, { ip })).status).toBe(429);
    expect(general.keys).toEqual([ip, ip, ip]);
    // Recovery is counted separately, so it is not blocked by the general limit.
    expect((await post(env, "/api/auth/recovery", { code: "x" }, { ip })).status).not.toBe(429);
    expect(recovery.keys).toEqual([ip]);
  });

  it("does not limit signed-in routes or /api/me", async () => {
    const { env } = setup();
    env.AUTH_LIMITER = fakeLimiter(0);
    env.AUTH_RECOVERY_LIMITER = fakeLimiter(0);
    expect((await post(env, "/api/auth/logout", {})).status).toBe(200);
    expect((await post(env, "/api/auth/passkeys/options", {})).status).toBe(401);
    expect((await get(env, "/api/me")).status).toBe(401);
  });

  it("checks Origin before counting, so cross-site requests do not use up the limit", async () => {
    const { env } = setup();
    const general = fakeLimiter(1);
    env.AUTH_LIMITER = general;
    const evil = await post(env, "/api/auth/login/options", {}, { origin: "https://evil.example" });
    expect(evil.status).toBe(403);
    expect(general.keys).toEqual([]);
  });

  it("fails open when the limiter itself errors", async () => {
    const { env } = setup();
    env.AUTH_LIMITER = { limit: () => Promise.reject(new Error("limiter down")) };
    const res = await post(env, "/api/auth/login/options", {});
    expect(res.status).toBe(200);
  });
});
