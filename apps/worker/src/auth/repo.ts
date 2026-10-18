import type { AsyncSql, Statement } from "./sql";

export type ChallengeKind = "register" | "login" | "add";

export interface StoredChallenge {
  id: string;
  challenge: string;
  kind: ChallengeKind;
  userId: string | null;
  /** Unix ms. */
  expiresAt: number;
}

export interface CredentialRecord {
  /** base64url credential id. */
  id: string;
  userId: string;
  publicKey: Uint8Array;
  counter: number;
  transports: string[];
}

/** Data access for auth. Times are unix ms and always passed in (inject the clock). */
export interface AuthRepo {
  putChallenge(challenge: StoredChallenge, nowMs: number): Promise<void>;
  /**
   * Delete the challenge and return it, or null when it is unknown, of another kind or expired.
   * The row is removed in every case, so a challenge can never be tried twice.
   */
  consumeChallenge(
    id: string,
    kind: ChallengeKind,
    nowMs: number,
  ): Promise<{ challenge: string; userId: string | null } | null>;
  /** Create the user, its first credential and its recovery code hashes atomically. */
  createUser(
    userId: string,
    credential: CredentialRecord,
    recoveryHashes: string[],
    nowMs: number,
  ): Promise<void>;
  addCredential(credential: CredentialRecord, nowMs: number): Promise<void>;
  getCredential(id: string): Promise<CredentialRecord | null>;
  listCredentials(userId: string): Promise<CredentialRecord[]>;
  /** Record a successful assertion. */
  touchCredential(id: string, counter: number, nowMs: number): Promise<void>;
  /** How many accounts were created at or after `sinceMs`. */
  countUsersSince(sinceMs: number): Promise<number>;
  userExists(userId: string): Promise<boolean>;
  /** The user's session epoch, or null when the user does not exist. */
  sessionEpoch(userId: string): Promise<number | null>;
  /** Invalidate every session issued so far and return the new epoch. */
  bumpSessionEpoch(userId: string): Promise<number | null>;
  recoveryCodesLeft(userId: string): Promise<number>;
  /** Mark the code used and return its user id; null when unknown or already used. */
  useRecoveryCode(codeHash: string, nowMs: number): Promise<string | null>;
}

const toBytes = (value: unknown): Uint8Array => {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  // D1 can return BLOBs as arrays of byte values.
  if (Array.isArray(value)) return Uint8Array.from(value as number[]);
  throw new Error("unexpected BLOB representation");
};

const parseTransports = (text: unknown): string[] => {
  try {
    const parsed: unknown = JSON.parse(String(text));
    return Array.isArray(parsed) ? parsed.filter((t): t is string => typeof t === "string") : [];
  } catch {
    return [];
  }
};

interface CredentialRow extends Record<string, unknown> {
  id: string;
  user_id: string;
  public_key: unknown;
  counter: number;
  transports: string;
}

const toCredential = (row: CredentialRow): CredentialRecord => ({
  id: row.id,
  userId: row.user_id,
  publicKey: toBytes(row.public_key),
  counter: row.counter,
  transports: parseTransports(row.transports),
});

const insertCredential = (c: CredentialRecord, nowMs: number): Statement => ({
  query:
    "INSERT INTO credentials (id, user_id, public_key, counter, transports, created_at) VALUES (?, ?, ?, ?, ?, ?)",
  bindings: [c.id, c.userId, c.publicKey, c.counter, JSON.stringify(c.transports), nowMs],
});

export function createAuthRepo(sql: AsyncSql): AuthRepo {
  return {
    async putChallenge(c, nowMs) {
      await sql.batch([
        { query: "DELETE FROM challenges WHERE expires_at <= ?", bindings: [nowMs] },
        {
          query:
            "INSERT INTO challenges (id, challenge, kind, user_id, expires_at) VALUES (?, ?, ?, ?, ?)",
          bindings: [c.id, c.challenge, c.kind, c.userId, c.expiresAt],
        },
      ]);
    },

    async consumeChallenge(id, kind, nowMs) {
      const rows = await sql.all<{
        challenge: string;
        kind: string;
        user_id: string | null;
        expires_at: number;
      }>("DELETE FROM challenges WHERE id = ? RETURNING challenge, kind, user_id, expires_at", id);
      const row = rows[0];
      if (row?.kind !== kind || row.expires_at <= nowMs) return null;
      return { challenge: row.challenge, userId: row.user_id };
    },

    async createUser(userId, credential, recoveryHashes, nowMs) {
      await sql.batch([
        { query: "INSERT INTO users (id, created_at) VALUES (?, ?)", bindings: [userId, nowMs] },
        insertCredential(credential, nowMs),
        ...recoveryHashes.map((hash): Statement => ({
          query: "INSERT INTO recovery_codes (user_id, code_hash) VALUES (?, ?)",
          bindings: [userId, hash],
        })),
      ]);
    },

    async addCredential(credential, nowMs) {
      const s = insertCredential(credential, nowMs);
      await sql.run(s.query, ...s.bindings);
    },

    async getCredential(id) {
      const rows = await sql.all<CredentialRow>(
        "SELECT id, user_id, public_key, counter, transports FROM credentials WHERE id = ?",
        id,
      );
      const row = rows[0];
      return row ? toCredential(row) : null;
    },

    async listCredentials(userId) {
      const rows = await sql.all<CredentialRow>(
        "SELECT id, user_id, public_key, counter, transports FROM credentials WHERE user_id = ? ORDER BY created_at, id",
        userId,
      );
      return rows.map(toCredential);
    },

    async touchCredential(id, counter, nowMs) {
      await sql.run(
        "UPDATE credentials SET counter = ?, last_used_at = ? WHERE id = ?",
        counter,
        nowMs,
        id,
      );
    },

    async countUsersSince(sinceMs) {
      const rows = await sql.all<{ n: number }>(
        "SELECT COUNT(*) AS n FROM users WHERE created_at >= ?",
        sinceMs,
      );
      return rows[0]?.n ?? 0;
    },

    async userExists(userId) {
      const rows = await sql.all("SELECT 1 AS one FROM users WHERE id = ?", userId);
      return rows.length > 0;
    },

    async sessionEpoch(userId) {
      const rows = await sql.all<{ session_epoch: number }>(
        "SELECT session_epoch FROM users WHERE id = ?",
        userId,
      );
      return rows[0]?.session_epoch ?? null;
    },

    async bumpSessionEpoch(userId) {
      const rows = await sql.all<{ session_epoch: number }>(
        "UPDATE users SET session_epoch = session_epoch + 1 WHERE id = ? RETURNING session_epoch",
        userId,
      );
      return rows[0]?.session_epoch ?? null;
    },

    async recoveryCodesLeft(userId) {
      const rows = await sql.all<{ n: number }>(
        "SELECT COUNT(*) AS n FROM recovery_codes WHERE user_id = ? AND used_at IS NULL",
        userId,
      );
      return rows[0]?.n ?? 0;
    },

    async useRecoveryCode(codeHash, nowMs) {
      const rows = await sql.all<{ user_id: string }>(
        "UPDATE recovery_codes SET used_at = ? WHERE code_hash = ? AND used_at IS NULL RETURNING user_id",
        nowMs,
        codeHash,
      );
      return rows[0]?.user_id ?? null;
    },
  };
}
