/**
 * Web Push sending with WebCrypto only (no Node built-ins, runs on Workers):
 * - VAPID (RFC 8292): an ES256 JWT in the `Authorization` header.
 * - Message encryption (RFC 8291) with the `aes128gcm` content coding (RFC 8188).
 * A single-record message is enough: payloads here are tiny.
 */
import { fromBase64Url, toBase64Url } from "../auth/session";

const enc = new TextEncoder();

const concat = (...parts: Uint8Array[]): Uint8Array<ArrayBuffer> => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
};

/** Copy into a standalone ArrayBuffer-backed view, as WebCrypto typings require. */
const buf = (bytes: Uint8Array): Uint8Array<ArrayBuffer> => new Uint8Array(bytes);

async function hkdf(
  ikm: Uint8Array,
  salt: Uint8Array,
  info: Uint8Array,
  bytes: number,
): Promise<Uint8Array<ArrayBuffer>> {
  const key = await crypto.subtle.importKey("raw", buf(ikm), "HKDF", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt: buf(salt), info: buf(info) },
    key,
    bytes * 8,
  );
  return new Uint8Array(bits);
}

/** Record size written into the header. The whole message must fit in one record. */
export const RECORD_SIZE = 4096;
/** The 16 byte GCM tag and the 0x02 delimiter byte share the record with the payload. */
const MAX_PLAINTEXT = RECORD_SIZE - 16 - 1;

export interface EncryptOptions {
  /** Test seam: the sender's ephemeral ECDH key pair (private JWK and 65 byte public). */
  senderKey?: { privateJwk: JsonWebKey; publicRaw: Uint8Array };
  /** Test seam: the 16 byte salt. */
  salt?: Uint8Array;
}

export interface Subscriber {
  /** base64url 65 byte uncompressed P-256 public key. */
  p256dh: string;
  /** base64url 16 byte auth secret. */
  auth: string;
}

/** Encrypt `plaintext` for a push subscriber. Returns the full request body (RFC 8188 layout). */
export async function encryptPayload(
  subscriber: Subscriber,
  plaintext: Uint8Array,
  options: EncryptOptions = {},
): Promise<Uint8Array<ArrayBuffer>> {
  if (plaintext.length > MAX_PLAINTEXT) throw new RangeError("payload too large");
  const uaPublic = fromBase64Url(subscriber.p256dh);
  const authSecret = fromBase64Url(subscriber.auth);
  if (uaPublic?.length !== 65 || uaPublic[0] !== 4) throw new RangeError("bad p256dh");
  if (authSecret?.length !== 16) throw new RangeError("bad auth secret");

  let privateKey: CryptoKey;
  let asPublic: Uint8Array;
  if (options.senderKey) {
    privateKey = await crypto.subtle.importKey(
      "jwk",
      options.senderKey.privateJwk,
      { name: "ECDH", namedCurve: "P-256" },
      false,
      ["deriveBits"],
    );
    asPublic = options.senderKey.publicRaw;
  } else {
    const pair = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, [
      "deriveBits",
    ])) as CryptoKeyPair;
    privateKey = pair.privateKey;
    asPublic = new Uint8Array(
      (await crypto.subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer,
    );
  }
  const uaKey = await crypto.subtle.importKey(
    "raw",
    buf(uaPublic),
    { name: "ECDH", namedCurve: "P-256" },
    false,
    [],
  );
  const ecdh = new Uint8Array(
    // The runtime property is `public`; workers-types spells it `$public`.
    await crypto.subtle.deriveBits(
      { name: "ECDH", public: uaKey } as unknown as SubtleCryptoDeriveKeyAlgorithm,
      privateKey,
      256,
    ),
  );

  const salt = options.salt ?? crypto.getRandomValues(new Uint8Array(16));
  const keyInfo = concat(enc.encode("WebPush: info\0"), uaPublic, asPublic);
  const ikm = await hkdf(ecdh, authSecret, keyInfo, 32);
  const cek = await hkdf(ikm, salt, enc.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(ikm, salt, enc.encode("Content-Encoding: nonce\0"), 12);

  const aes = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  // 0x02 marks the last (here: only) record.
  const record = concat(plaintext, new Uint8Array([2]));
  const cipher = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, aes, record),
  );
  const header = new Uint8Array(21 + asPublic.length);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, RECORD_SIZE);
  header[20] = asPublic.length;
  header.set(asPublic, 21);
  return concat(header, cipher);
}

/** VAPID key material as stored in env: base64url raw private scalar and uncompressed public key. */
export interface VapidKeys {
  publicKey: string;
  privateKey: string;
  subject: string;
}

async function importVapidSigningKey(keys: VapidKeys): Promise<CryptoKey> {
  const pub = fromBase64Url(keys.publicKey);
  if (pub?.length !== 65 || pub[0] !== 4) throw new RangeError("bad VAPID public key");
  return crypto.subtle.importKey(
    "jwk",
    {
      kty: "EC",
      crv: "P-256",
      d: keys.privateKey,
      x: toBase64Url(pub.slice(1, 33)),
      y: toBase64Url(pub.slice(33, 65)),
    },
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );
}

/** RFC 8292 allows up to 24 hours; use 12. */
export const VAPID_JWT_TTL_SEC = 12 * 60 * 60;

/** A signed ES256 JWT for the push service that owns `endpoint`. */
export async function vapidJwt(keys: VapidKeys, endpoint: string, nowMs: number): Promise<string> {
  const header = toBase64Url(enc.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const claims = toBase64Url(
    enc.encode(
      JSON.stringify({
        aud: new URL(endpoint).origin,
        exp: Math.floor(nowMs / 1000) + VAPID_JWT_TTL_SEC,
        sub: keys.subject,
      }),
    ),
  );
  const input = `${header}.${claims}`;
  const key = await importVapidSigningKey(keys);
  // WebCrypto ECDSA output is already the raw r||s form JWS wants.
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, enc.encode(input));
  return `${input}.${toBase64Url(new Uint8Array(sig))}`;
}

export type SendResult =
  | { kind: "sent" }
  /** The subscription is gone (404 or 410): delete it. */
  | { kind: "gone" }
  | { kind: "failed"; status: number };

export interface SendOptions {
  fetch?: typeof fetch;
  nowMs: number;
  /** Seconds the push service may hold the message. */
  ttlSec?: number;
}

export interface PushTarget extends Subscriber {
  endpoint: string;
}

/** Encrypt and POST one notification payload to the subscription's push service. */
export async function sendWebPush(
  target: PushTarget,
  payload: unknown,
  keys: VapidKeys,
  options: SendOptions,
): Promise<SendResult> {
  let body: Uint8Array<ArrayBuffer>;
  let jwt: string;
  try {
    body = await encryptPayload(target, enc.encode(JSON.stringify(payload)));
    jwt = await vapidJwt(keys, target.endpoint, options.nowMs);
  } catch {
    // Malformed stored key material or bad server keys: not retryable by this request.
    return { kind: "failed", status: 0 };
  }
  const doFetch = options.fetch ?? fetch;
  let res: Response;
  try {
    res = await doFetch(target.endpoint, {
      method: "POST",
      headers: {
        authorization: `vapid t=${jwt}, k=${keys.publicKey}`,
        "content-encoding": "aes128gcm",
        "content-type": "application/octet-stream",
        ttl: String(options.ttlSec ?? 3600),
        urgency: "normal",
        topic: "practice-cue",
      },
      body,
    });
  } catch {
    return { kind: "failed", status: 0 };
  }
  // Drain so the connection is released.
  await res.arrayBuffer().catch(() => undefined);
  if (res.status === 404 || res.status === 410) return { kind: "gone" };
  if (res.status >= 200 && res.status < 300) return { kind: "sent" };
  return { kind: "failed", status: res.status };
}
