import type { Clock, RandomBytes } from "../random.js";

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const TIME_LEN = 10;
const RANDOM_BYTES = 10;
const RANDOM_LEN = 16;
const MAX_TIME = 2 ** 48 - 1;

/** A ULID is 26 Crockford base32 chars; the first is 0-7 so the time fits 48 bits. */
export const ULID_REGEX = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;

export function isUlid(value: unknown): value is string {
  return typeof value === "string" && ULID_REGEX.test(value);
}

export function encodeTime(ms: number): string {
  if (!Number.isInteger(ms) || ms < 0 || ms > MAX_TIME) {
    throw new RangeError(`ULID time out of range: ${String(ms)}`);
  }
  let out = "";
  let rest = ms;
  for (let i = 0; i < TIME_LEN; i++) {
    out = ALPHABET.charAt(rest % 32) + out;
    rest = Math.floor(rest / 32);
  }
  return out;
}

export function decodeTime(ulid: string): number {
  if (!ULID_REGEX.test(ulid)) throw new TypeError(`Not a ULID: ${ulid}`);
  let ms = 0;
  for (let i = 0; i < TIME_LEN; i++) {
    ms = ms * 32 + ALPHABET.indexOf(ulid.charAt(i));
  }
  return ms;
}

/** Encode 10 random bytes (80 bits) as 16 base32 chars. */
function encodeRandom(bytes: Uint8Array): string {
  let out = "";
  let acc = 0;
  let bits = 0;
  // Consume from the least significant end so the 80 bits map to exactly 16 chars.
  for (let i = bytes.length - 1; i >= 0; i--) {
    acc |= (bytes[i] ?? 0) << bits;
    bits += 8;
    while (bits >= 5) {
      out = ALPHABET.charAt(acc & 31) + out;
      acc >>>= 5;
      bits -= 5;
    }
  }
  return out;
}

/** Add one to a big-endian byte array in place. Returns false on overflow. */
function increment(bytes: Uint8Array): boolean {
  for (let i = bytes.length - 1; i >= 0; i--) {
    const next = ((bytes[i] ?? 0) + 1) & 0xff;
    bytes[i] = next;
    if (next !== 0) return true;
  }
  return false;
}

export interface UlidDeps {
  now: Clock;
  randomBytes: RandomBytes;
}

/**
 * Create a monotonic ULID generator. Within one millisecond (or if the clock
 * steps backwards) the random part is incremented, so ids from one generator
 * always sort in generation order.
 */
export function createUlidGenerator(deps: UlidDeps): () => string {
  let lastTime = -1;
  let lastRandom = new Uint8Array(RANDOM_BYTES);

  return () => {
    const now = Math.floor(deps.now());
    if (now > lastTime) {
      const fresh = deps.randomBytes(RANDOM_BYTES);
      if (fresh.length < RANDOM_BYTES) throw new RangeError("randomBytes returned too few bytes");
      lastTime = now;
      lastRandom = Uint8Array.from(fresh.subarray(0, RANDOM_BYTES));
    } else if (!increment(lastRandom)) {
      throw new RangeError("ULID random part overflow within one millisecond");
    }
    const id = encodeTime(lastTime) + encodeRandom(lastRandom);
    if (id.length !== TIME_LEN + RANDOM_LEN) throw new Error("ULID encoding bug");
    return id;
  };
}
