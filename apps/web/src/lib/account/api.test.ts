import { describe, expect, it } from "vitest";
import { createAuthApi } from "./api";
import { AccountError, describeAccountError, type AccountErrorKind } from "./errors";

interface Call {
  url: string;
  init: RequestInit;
}

function fake(respond: (call: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fetchFn = ((input: RequestInfo | URL, init?: RequestInit) => {
    const call = {
      url: typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
      init: init ?? {},
    };
    calls.push(call);
    return Promise.resolve(respond(call));
  }) as typeof fetch;
  return { calls, api: createAuthApi(fetchFn) };
}

const jsonRes = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const bodyOf = (body: BodyInit | null | undefined): string => body as string;

async function kindOf(p: Promise<unknown>): Promise<AccountErrorKind | "no error"> {
  try {
    await p;
    return "no error";
  } catch (e) {
    if (e instanceof AccountError) return e.kind;
    throw e;
  }
}

describe("auth API request shapes", () => {
  it("GET /api/me sends credentials and returns the summary", async () => {
    const { api, calls } = fake(() => jsonRes({ userId: "u1", passkeys: 2, recoveryCodesLeft: 9 }));
    expect(await api.me()).toEqual({ userId: "u1", passkeys: 2, recoveryCodesLeft: 9 });
    expect(calls[0]?.url).toBe("/api/me");
    expect(calls[0]?.init.method).toBe("GET");
    expect(calls[0]?.init.credentials).toBe("include");
  });

  it("options endpoints POST an empty JSON object and return challengeId and options", async () => {
    const { api, calls } = fake(() => jsonRes({ challengeId: "c1", options: { challenge: "x" } }));
    const reg = await api.registerOptions();
    await api.loginOptions();
    await api.passkeyOptions();
    expect(reg).toEqual({ challengeId: "c1", options: { challenge: "x" } });
    expect(calls.map((c) => c.url)).toEqual([
      "/api/auth/register/options",
      "/api/auth/login/options",
      "/api/auth/passkeys/options",
    ]);
    for (const c of calls) {
      expect(c.init.method).toBe("POST");
      expect(c.init.credentials).toBe("include");
      expect(new Headers(c.init.headers).get("content-type")).toBe("application/json");
      expect(c.init.body).toBe("{}");
    }
  });

  it("verify endpoints send { challengeId, response }", async () => {
    const { api, calls } = fake((c) =>
      c.url.endsWith("register/verify")
        ? jsonRes({ userId: "u1", recoveryCodes: ["A", "B"] })
        : c.url.endsWith("login/verify")
          ? jsonRes({ userId: "u1" })
          : jsonRes({ userId: "u1", passkeys: 2 }),
    );
    const cred = { id: "cred" };
    expect(await api.registerVerify("c1", cred)).toEqual({
      userId: "u1",
      recoveryCodes: ["A", "B"],
    });
    expect(await api.loginVerify("c2", cred)).toEqual({ userId: "u1" });
    expect(await api.passkeyVerify("c3", cred)).toEqual({ userId: "u1", passkeys: 2 });
    expect(calls.map((c) => c.url)).toEqual([
      "/api/auth/register/verify",
      "/api/auth/login/verify",
      "/api/auth/passkeys/verify",
    ]);
    expect(JSON.parse(bodyOf(calls[0]?.init.body))).toEqual({ challengeId: "c1", response: cred });
    expect(JSON.parse(bodyOf(calls[2]?.init.body))).toEqual({ challengeId: "c3", response: cred });
  });

  it("recovery posts the code and logout posts an empty body", async () => {
    const { api, calls } = fake((c) =>
      c.url.endsWith("recovery")
        ? jsonRes({ userId: "u1", recoveryCodesLeft: 8 })
        : jsonRes({ ok: true }),
    );
    expect(await api.recovery("AAAA-BBBB")).toEqual({ userId: "u1", recoveryCodesLeft: 8 });
    await api.logout();
    expect(JSON.parse(bodyOf(calls[0]?.init.body))).toEqual({ code: "AAAA-BBBB" });
    expect(calls[1]?.url).toBe("/api/auth/logout");
    expect(calls[1]?.init.credentials).toBe("include");
  });
});

describe("auth API error mapping", () => {
  it("maps a network failure", async () => {
    const api = createAuthApi(() => Promise.reject(new TypeError("Failed to fetch")));
    expect(await kindOf(api.me())).toBe("network");
  });

  it.each([
    [
      "me 401 is unauthorized",
      (a: ReturnType<typeof createAuthApi>) => a.me(),
      401,
      "unauthorized",
    ],
    [
      "passkey add 401 is unauthorized",
      (a: ReturnType<typeof createAuthApi>) => a.passkeyOptions(),
      401,
      "unauthorized",
    ],
    [
      "login verify 401 is rejected",
      (a: ReturnType<typeof createAuthApi>) => a.loginVerify("c", {}),
      401,
      "rejected",
    ],
    [
      "recovery 401 is rejected",
      (a: ReturnType<typeof createAuthApi>) => a.recovery("x"),
      401,
      "rejected",
    ],
    [
      "register verify 409 is alreadyRegistered",
      (a: ReturnType<typeof createAuthApi>) => a.registerVerify("c", {}),
      409,
      "alreadyRegistered",
    ],
    [
      "register verify 400 is rejected",
      (a: ReturnType<typeof createAuthApi>) => a.registerVerify("c", {}),
      400,
      "rejected",
    ],
    [
      "login options 403 is rejected",
      (a: ReturnType<typeof createAuthApi>) => a.loginOptions(),
      403,
      "rejected",
    ],
    [
      "passkey verify 409 is alreadyRegistered",
      (a: ReturnType<typeof createAuthApi>) => a.passkeyVerify("c", {}),
      409,
      "alreadyRegistered",
    ],
    [
      "login verify 409 is rejected, not alreadyRegistered",
      (a: ReturnType<typeof createAuthApi>) => a.loginVerify("c", {}),
      409,
      "rejected",
    ],
    [
      "recovery 409 is rejected",
      (a: ReturnType<typeof createAuthApi>) => a.recovery("x"),
      409,
      "rejected",
    ],
    [
      "recovery 429 is rateLimited",
      (a: ReturnType<typeof createAuthApi>) => a.recovery("x"),
      429,
      "rateLimited",
    ],
    [
      "login options 429 is rateLimited",
      (a: ReturnType<typeof createAuthApi>) => a.loginOptions(),
      429,
      "rateLimited",
    ],
    ["me 500 is server", (a: ReturnType<typeof createAuthApi>) => a.me(), 500, "server"],
  ] as const)("%s", async (_name, call, status, kind) => {
    const { api } = fake(() => jsonRes({ error: "x" }, status));
    expect(await kindOf(call(api))).toBe(kind);
  });

  it("rejects negative counts from recovery and passkey verify as malformed", async () => {
    const rec = fake(() => jsonRes({ userId: "u1", recoveryCodesLeft: -1 }));
    expect(await kindOf(rec.api.recovery("x"))).toBe("server");
    const pk = fake(() => jsonRes({ userId: "u1", passkeys: -1 }));
    expect(await kindOf(pk.api.passkeyVerify("c", {}))).toBe("server");
  });

  it("maps a malformed 200 body to server", async () => {
    const { api } = fake(() => jsonRes({ nope: true }));
    expect(await kindOf(api.me())).toBe("server");
    const bad = fake(() => new Response("<html>", { status: 200 }));
    expect(await kindOf(bad.api.me())).toBe("server");
  });

  it("has plain, em dash free copy for every kind", () => {
    const kinds: AccountErrorKind[] = [
      "cancelled",
      "alreadyRegistered",
      "rejected",
      "unauthorized",
      "network",
      "server",
      "unsupported",
      "rateLimited",
    ];
    for (const k of kinds) {
      const text = describeAccountError(new AccountError(k, "x"));
      expect(text.length).toBeGreaterThan(10);
      expect(text).not.toContain("—");
    }
    expect(describeAccountError(new Error("boom"))).toBe(
      describeAccountError(new AccountError("server", "x")),
    );
  });
});
