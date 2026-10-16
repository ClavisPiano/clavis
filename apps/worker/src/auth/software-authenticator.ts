/**
 * Test helper: a software WebAuthn authenticator (ES256, attestation "none"). It builds real
 * clientDataJSON, authenticatorData and CBOR attestation objects, so tests exercise
 * `@simplewebauthn/server` end to end. Not imported by production code.
 */
import { toBase64Url } from "./session";

const enc = new TextEncoder();

type Cbor = number | string | Uint8Array | Cbor[] | { entries: [Cbor, Cbor][] };

function head(major: number, value: number): number[] {
  const m = major << 5;
  if (value < 24) return [m | value];
  if (value < 256) return [m | 24, value];
  if (value < 65536) return [m | 25, value >> 8, value & 255];
  throw new Error("cbor value too large for this helper");
}

/** Tiny CBOR encoder: integers, text, bytes, arrays and ordered maps. */
export function cbor(value: Cbor): Uint8Array {
  if (typeof value === "number") {
    return Uint8Array.from(value >= 0 ? head(0, value) : head(1, -1 - value));
  }
  if (typeof value === "string") {
    const bytes = enc.encode(value);
    return concat(Uint8Array.from(head(3, bytes.length)), bytes);
  }
  if (value instanceof Uint8Array) return concat(Uint8Array.from(head(2, value.length)), value);
  if (Array.isArray(value)) {
    return concat(Uint8Array.from(head(4, value.length)), ...value.map(cbor));
  }
  return concat(
    Uint8Array.from(head(5, value.entries.length)),
    ...value.entries.flatMap(([k, v]) => [cbor(k), cbor(v)]),
  );
}

export function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

const sha256 = async (data: Uint8Array): Promise<Uint8Array> =>
  new Uint8Array(await crypto.subtle.digest("SHA-256", data));

const be32 = (n: number): Uint8Array =>
  Uint8Array.from([n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]);

/** WebCrypto returns raw r||s; WebAuthn wants an ASN.1 DER ECDSA signature. */
export function rawToDer(raw: Uint8Array): Uint8Array {
  const int = (bytes: Uint8Array): Uint8Array => {
    let i = 0;
    while (i < bytes.length - 1 && bytes[i] === 0) i++;
    let body: Uint8Array = bytes.slice(i);
    if ((body[0] ?? 0) & 0x80) body = concat(Uint8Array.of(0), body);
    return concat(Uint8Array.of(0x02, body.length), body);
  };
  const body = concat(int(raw.slice(0, 32)), int(raw.slice(32)));
  return concat(Uint8Array.of(0x30, body.length), body);
}

export const FLAG_UP = 0x01;
export const FLAG_UV = 0x04;
export const FLAG_AT = 0x40;

export interface RegistrationInput {
  challenge: string;
}
export interface AssertionInput {
  challenge: string;
}
export interface Tamper {
  /** Origin written to clientDataJSON. */
  origin?: string;
  /** Replace the challenge in clientDataJSON. */
  challenge?: string;
  /** Authenticator counter to report for an assertion (default: increment). */
  counter?: number;
}

export class SoftwareAuthenticator {
  readonly credentialId: Uint8Array = crypto.getRandomValues(new Uint8Array(16));
  counter = 0;
  private keys: CryptoKeyPair | undefined;

  constructor(
    private readonly rpId: string,
    private readonly origin: string,
  ) {}

  get id(): string {
    return toBase64Url(this.credentialId);
  }

  private async keyPair(): Promise<CryptoKeyPair> {
    this.keys ??= (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
      "sign",
      "verify",
    ])) as CryptoKeyPair;
    return this.keys;
  }

  private clientData(type: string, challenge: string, tamper: Tamper): Uint8Array {
    return enc.encode(
      JSON.stringify({
        type,
        challenge: tamper.challenge ?? challenge,
        origin: tamper.origin ?? this.origin,
        crossOrigin: false,
      }),
    );
  }

  /** `navigator.credentials.create()` result, serialised as RegistrationResponseJSON. */
  async register(input: RegistrationInput, tamper: Tamper = {}) {
    const jwk = (await crypto.subtle.exportKey(
      "jwk",
      (await this.keyPair()).publicKey,
    )) as JsonWebKey;
    const x = Uint8Array.from(atob((jwk.x ?? "").replaceAll("-", "+").replaceAll("_", "/")), (c) =>
      c.charCodeAt(0),
    );
    const y = Uint8Array.from(atob((jwk.y ?? "").replaceAll("-", "+").replaceAll("_", "/")), (c) =>
      c.charCodeAt(0),
    );
    const coseKey = cbor({
      entries: [
        [1, 2], // kty EC2
        [3, -7], // alg ES256
        [-1, 1], // crv P-256
        [-2, x],
        [-3, y],
      ],
    });
    const authData = concat(
      await sha256(enc.encode(this.rpId)),
      Uint8Array.of(FLAG_UP | FLAG_UV | FLAG_AT),
      be32(this.counter),
      new Uint8Array(16), // aaguid
      Uint8Array.of(this.credentialId.length >> 8, this.credentialId.length & 255),
      this.credentialId,
      coseKey,
    );
    const attestationObject = cbor({
      entries: [
        ["fmt", "none"],
        ["attStmt", { entries: [] }],
        ["authData", authData],
      ],
    });
    return {
      id: this.id,
      rawId: this.id,
      type: "public-key",
      response: {
        clientDataJSON: toBase64Url(this.clientData("webauthn.create", input.challenge, tamper)),
        attestationObject: toBase64Url(attestationObject),
        transports: ["internal"],
      },
      clientExtensionResults: {},
      authenticatorAttachment: "platform",
    };
  }

  /** `navigator.credentials.get()` result, serialised as AuthenticationResponseJSON. */
  async assert(input: AssertionInput, tamper: Tamper = {}) {
    this.counter = tamper.counter ?? this.counter + 1;
    const authData = concat(
      await sha256(enc.encode(this.rpId)),
      Uint8Array.of(FLAG_UP | FLAG_UV),
      be32(this.counter),
    );
    const clientDataJSON = this.clientData("webauthn.get", input.challenge, tamper);
    const signed = concat(authData, await sha256(clientDataJSON));
    const raw = new Uint8Array(
      await crypto.subtle.sign(
        { name: "ECDSA", hash: "SHA-256" },
        (await this.keyPair()).privateKey,
        signed,
      ),
    );
    return {
      id: this.id,
      rawId: this.id,
      type: "public-key",
      response: {
        clientDataJSON: toBase64Url(clientDataJSON),
        authenticatorData: toBase64Url(authData),
        signature: toBase64Url(rawToDer(raw)),
      },
      clientExtensionResults: {},
      authenticatorAttachment: "platform",
    };
  }
}
