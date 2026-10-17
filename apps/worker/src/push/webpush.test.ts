import { describe, expect, it } from "vitest";
import { fromBase64Url, toBase64Url } from "../auth/session";
import { ecKeyPair } from "./test-keys";
import {
  RECORD_SIZE,
  encryptPayload,
  sendWebPush,
  vapidJwt,
  type Subscriber,
  type VapidKeys,
} from "./webpush";

const enc = new TextEncoder();
const dec = new TextDecoder();
const bytes = (text: string): Uint8Array => {
  const out = fromBase64Url(text);
  if (!out) throw new Error("bad base64url in test");
  return out;
};

async function hkdf(ikm: Uint8Array, salt: Uint8Array, info: Uint8Array, n: number) {
  const key = await crypto.subtle.importKey("raw", new Uint8Array(ikm), "HKDF", false, [
    "deriveBits",
  ]);
  return new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(salt), info: new Uint8Array(info) },
      key,
      n * 8,
    ),
  );
}

const cat = (...p: Uint8Array[]): Uint8Array => new Uint8Array(p.flatMap((a) => [...a]));

/** Independent receiver side (RFC 8291 section 4), used to check what the sender produced. */
async function decrypt(
  body: Uint8Array,
  uaPrivateJwk: JsonWebKey,
  uaPublic: Uint8Array,
  authSecret: Uint8Array,
): Promise<Uint8Array> {
  const salt = body.slice(0, 16);
  const rs = new DataView(body.buffer, body.byteOffset).getUint32(16);
  const idLen = body[20] ?? 0;
  const asPublic = body.slice(21, 21 + idLen);
  const cipher = body.slice(21 + idLen);
  expect(rs).toBe(RECORD_SIZE);
  const uaPrivate = await crypto.subtle.importKey(
    "jwk",
    uaPrivateJwk,
    { name: "ECDH", namedCurve: "P-256" },
    false,
    ["deriveBits"],
  );
  const asKey = await crypto.subtle.importKey(
    "raw",
    new Uint8Array(asPublic),
    { name: "ECDH", namedCurve: "P-256" },
    false,
    [],
  );
  const ecdh = new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: "ECDH", public: asKey } as unknown as SubtleCryptoDeriveKeyAlgorithm,
      uaPrivate,
      256,
    ),
  );
  const ikm = await hkdf(
    ecdh,
    authSecret,
    cat(enc.encode("WebPush: info\0"), uaPublic, asPublic),
    32,
  );
  const cek = await hkdf(ikm, salt, enc.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(ikm, salt, enc.encode("Content-Encoding: nonce\0"), 12);
  const key = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["decrypt"]);
  const record = new Uint8Array(
    await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce }, key, new Uint8Array(cipher)),
  );
  // Strip padding: the last non-zero byte is the delimiter 0x02.
  let end = record.length;
  while (end > 0 && record[end - 1] === 0) end -= 1;
  expect(record[end - 1]).toBe(2);
  return record.slice(0, end - 1);
}

async function makeSubscriber() {
  const pair = await ecKeyPair("ECDH");
  const authSecret = crypto.getRandomValues(new Uint8Array(16));
  const subscriber: Subscriber = {
    p256dh: toBase64Url(pair.publicRaw),
    auth: toBase64Url(authSecret),
  };
  return { subscriber, publicRaw: pair.publicRaw, privateJwk: pair.privateJwk, authSecret };
}

describe("encryptPayload (RFC 8291)", () => {
  it("matches the RFC 8291 appendix A test vector", async () => {
    const asPublic = bytes(
      "BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8",
    );
    const body = await encryptPayload(
      {
        p256dh:
          "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
        auth: "BTBZMqHH6r4Tts7J_aSIgg",
      },
      enc.encode("When I grow up, I want to be a watermelon"),
      {
        salt: bytes("DGv6ra1nlYgDCS1FRnbzlw"),
        senderKey: {
          publicRaw: asPublic,
          privateJwk: {
            kty: "EC",
            crv: "P-256",
            d: "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw",
            x: toBase64Url(asPublic.slice(1, 33)),
            y: toBase64Url(asPublic.slice(33, 65)),
          },
        },
      },
    );
    expect(toBase64Url(body)).toBe(
      "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN",
    );
  });

  it("round trips: the subscriber decrypts what was sent", async () => {
    const sub = await makeSubscriber();
    const message = JSON.stringify({ title: "Time to practise", body: "After my morning coffee" });
    const body = await encryptPayload(sub.subscriber, enc.encode(message));
    const plain = await decrypt(body, sub.privateJwk, sub.publicRaw, sub.authSecret);
    expect(dec.decode(plain)).toBe(message);
  });

  it("uses a fresh ephemeral key and salt each time", async () => {
    const sub = await makeSubscriber();
    const a = await encryptPayload(sub.subscriber, enc.encode("x"));
    const b = await encryptPayload(sub.subscriber, enc.encode("x"));
    expect(toBase64Url(a)).not.toBe(toBase64Url(b));
  });

  it("rejects malformed keys and oversized payloads", async () => {
    const sub = await makeSubscriber();
    await expect(
      encryptPayload({ ...sub.subscriber, auth: "AAAA" }, enc.encode("x")),
    ).rejects.toThrow(RangeError);
    await expect(
      encryptPayload({ ...sub.subscriber, p256dh: "AAAA" }, enc.encode("x")),
    ).rejects.toThrow(RangeError);
    await expect(encryptPayload(sub.subscriber, new Uint8Array(RECORD_SIZE))).rejects.toThrow(
      RangeError,
    );
  });
});

async function makeVapid(): Promise<VapidKeys> {
  const pair = await ecKeyPair("ECDSA");
  return {
    publicKey: toBase64Url(pair.publicRaw),
    privateKey: pair.privateJwk.d ?? "",
    subject: "mailto:ops@clavis.example",
  };
}

describe("vapidJwt", () => {
  it("is an ES256 JWT that verifies with the public key and names the push service", async () => {
    const keys = await makeVapid();
    const now = Date.UTC(2026, 9, 16, 12, 0, 0);
    const jwt = await vapidJwt(keys, "https://fcm.googleapis.com/fcm/send/abc", now);
    const [h, c, s] = jwt.split(".") as [string, string, string];
    expect(JSON.parse(dec.decode(bytes(h)))).toEqual({ typ: "JWT", alg: "ES256" });
    expect(JSON.parse(dec.decode(bytes(c)))).toEqual({
      aud: "https://fcm.googleapis.com",
      exp: now / 1000 + 12 * 3600,
      sub: "mailto:ops@clavis.example",
    });
    const publicKey = await crypto.subtle.importKey(
      "raw",
      new Uint8Array(bytes(keys.publicKey)),
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"],
    );
    const ok = await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      publicKey,
      new Uint8Array(bytes(s)),
      enc.encode(`${h}.${c}`),
    );
    expect(ok).toBe(true);
    expect(bytes(s)).toHaveLength(64);
  });
});

describe("sendWebPush", () => {
  it("posts an encrypted body with VAPID and push headers, and maps statuses", async () => {
    const keys = await makeVapid();
    const sub = await makeSubscriber();
    const target = { ...sub.subscriber, endpoint: "https://push.example.com/send/xyz" };
    const calls: { url: string; init: RequestInit }[] = [];
    const reply = (status: number) =>
      ((url: string, init: RequestInit) => {
        calls.push({ url, init });
        return Promise.resolve(new Response(null, { status }));
      }) as unknown as typeof fetch;

    const sent = await sendWebPush(target, { title: "t" }, keys, {
      nowMs: Date.now(),
      fetch: reply(201),
    });
    expect(sent).toEqual({ kind: "sent" });
    const call = calls[0];
    expect(call?.url).toBe(target.endpoint);
    const headers = call?.init.headers as Record<string, string>;
    expect(headers["content-encoding"]).toBe("aes128gcm");
    expect(headers.authorization).toMatch(
      new RegExp(`^vapid t=[\\w-]+\\.[\\w-]+\\.[\\w-]+, k=${keys.publicKey}$`),
    );
    const plain = await decrypt(
      call?.init.body as Uint8Array,
      sub.privateJwk,
      sub.publicRaw,
      sub.authSecret,
    );
    expect(JSON.parse(dec.decode(plain))).toEqual({ title: "t" });

    for (const status of [404, 410]) {
      expect(
        await sendWebPush(target, {}, keys, { nowMs: Date.now(), fetch: reply(status) }),
      ).toEqual({ kind: "gone" });
    }
    expect(await sendWebPush(target, {}, keys, { nowMs: Date.now(), fetch: reply(500) })).toEqual({
      kind: "failed",
      status: 500,
    });
    const boom = (() => Promise.reject(new Error("net"))) as unknown as typeof fetch;
    expect(await sendWebPush(target, {}, keys, { nowMs: Date.now(), fetch: boom })).toEqual({
      kind: "failed",
      status: 0,
    });
  });
});
