import { describe, expect, it } from "vitest";
import { extractToken, fromBase64Url, signSession, toBase64Url, verifySession } from "./session";

const NOW = 1_800_000_000_000;
const claims = { sub: "user-1", exp: NOW / 1000 + 60 };

describe("session tokens", () => {
  it("round-trips", async () => {
    const token = await signSession(claims, "s1");
    expect(await verifySession(token, "s1", NOW)).toEqual({ ...claims, ep: 0 });
  });

  it("carries the session epoch, and rejects a malformed one", async () => {
    const token = await signSession({ ...claims, ep: 3 }, "s1");
    expect((await verifySession(token, "s1", NOW))?.ep).toBe(3);
    const bad = await signSession({ ...claims, ep: -1 }, "s1");
    expect(await verifySession(bad, "s1", NOW)).toBeNull();
  });

  it("rejects a wrong secret, tampering, expiry and garbage", async () => {
    const token = await signSession(claims, "s1");
    expect(await verifySession(token, "other", NOW)).toBeNull();
    const [payload, sig] = token.split(".") as [string, string];
    const forged = toBase64Url(
      new TextEncoder().encode(JSON.stringify({ sub: "u2", exp: claims.exp })),
    );
    expect(await verifySession(`${forged}.${sig}`, "s1", NOW)).toBeNull();
    expect(await verifySession(`${payload}.${sig.slice(0, -2)}AA`, "s1", NOW)).toBeNull();
    expect(await verifySession(token, "s1", claims.exp * 1000)).toBeNull();
    expect(await verifySession(token, "", NOW)).toBeNull();
    for (const bad of ["", "abc", "a.b.c", "!!.??", `${payload}.`]) {
      expect(await verifySession(bad, "s1", NOW)).toBeNull();
    }
  });

  it("rejects validly signed tokens with bad claims", async () => {
    const sign = async (obj: unknown) => {
      const payload = toBase64Url(new TextEncoder().encode(JSON.stringify(obj)));
      const real = await signSession(claims, "s1");
      // Sign the odd payload with the real signer by reusing its machinery.
      const key = await crypto.subtle.importKey(
        "raw",
        new TextEncoder().encode("s1"),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"],
      );
      const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
      expect(real).toBeTruthy();
      return `${payload}.${toBase64Url(new Uint8Array(sig))}`;
    };
    expect(await verifySession(await sign({ sub: "", exp: claims.exp }), "s1", NOW)).toBeNull();
    expect(await verifySession(await sign({ sub: "u", exp: "x" }), "s1", NOW)).toBeNull();
    expect(await verifySession(await sign(null), "s1", NOW)).toBeNull();
  });
});

describe("base64url", () => {
  it("round-trips bytes and rejects bad input", () => {
    const bytes = new Uint8Array([0, 250, 251, 252, 253, 254, 255]);
    expect(fromBase64Url(toBase64Url(bytes))).toEqual(bytes);
    expect(fromBase64Url("a+b")).toBeNull();
    expect(fromBase64Url("a")).toBeNull();
  });
});

describe("extractToken", () => {
  const req = (headers: Record<string, string>) => new Request("https://x.test/", { headers });
  it("reads bearer and cookie, bearer first", () => {
    expect(extractToken(req({ authorization: "Bearer abc" }))).toBe("abc");
    expect(extractToken(req({ cookie: "a=1; __Host-clavis_session=tok; b=2" }))).toBe("tok");
    expect(
      extractToken(req({ authorization: "Bearer one", cookie: "__Host-clavis_session=two" })),
    ).toBe("one");
    // The name used before the __Host- prefix still works, and the new name wins when both exist.
    expect(extractToken(req({ cookie: "clavis_session=old" }))).toBe("old");
    expect(extractToken(req({ cookie: "clavis_session=old; __Host-clavis_session=new" }))).toBe(
      "new",
    );
    expect(extractToken(req({ authorization: "Basic abc" }))).toBeNull();
    expect(extractToken(req({ cookie: "other=1" }))).toBeNull();
    expect(extractToken(req({}))).toBeNull();
  });
});
