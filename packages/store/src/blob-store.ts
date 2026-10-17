import { baseContentType, isAllowedBlobType, isValidBlobName } from "@clavis/core";
import type { Dexie, Table } from "dexie";

/*
 * Local recording storage (T4.5). Rows live in the Dexie `blobs` table. Booleans are stored as
 * booleans and filtered in memory: the table is small (a size cap bounds it) and booleans are not
 * indexable in IndexedDB.
 */

export const DEFAULT_BLOB_CAP_BYTES = 200 * 1024 * 1024;

export interface BlobRecord {
  /** One path segment matching the server's name pattern; the server prefixes the user id. */
  key: string;
  blob: Blob;
  contentType: string;
  size: number;
  /** Epoch ms. Orders uploads and eviction (oldest first). */
  createdAt: number;
  /** Pinned rows are never evicted (for example a benchmark the learner wants to keep). */
  pinned: boolean;
  /** True once the server holds a copy. */
  uploaded: boolean;
}

export type BlobMeta = Omit<BlobRecord, "blob">;

export interface PutBlobInput {
  key: string;
  blob: Blob;
  /** Defaults to `blob.type`. Must be one the server accepts. */
  contentType?: string;
  createdAt?: number;
  pinned?: boolean;
  /** True when the server already holds these bytes (a download), so the queue skips them. */
  uploaded?: boolean;
}

export interface BlobStore {
  /** Store (or replace) a blob, then enforce the cap. Returns the keys evicted to make room. */
  put(input: PutBlobInput): Promise<{ evicted: string[] }>;
  get(key: string): Promise<BlobRecord | undefined>;
  /** Metadata only (no blob bytes), oldest first. */
  list(): Promise<BlobMeta[]>;
  /**
   * Mark `key` uploaded. With `uploaded`, only when the stored row is still that version (same
   * `createdAt` and `size`): a row replaced by `put` while its old bytes were uploading stays
   * pending, so the new bytes get uploaded too.
   */
  markUploaded(key: string, uploaded?: Pick<BlobMeta, "createdAt" | "size">): Promise<void>;
  /** Enforce the cap now. Returns evicted keys, in eviction order. */
  evict(): Promise<string[]>;
  delete(key: string): Promise<void>;
}

export interface BlobStoreOptions {
  /** Total size cap in bytes. Defaults to 200 MB. */
  maxBytes?: number;
  now?: () => number;
}

type Row = BlobRecord;

const byAge = (a: BlobMeta, b: BlobMeta): number =>
  a.createdAt - b.createdAt || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);

const meta = (row: Row): BlobMeta => ({
  key: row.key,
  contentType: row.contentType,
  size: row.size,
  createdAt: row.createdAt,
  pinned: row.pinned,
  uploaded: row.uploaded,
});

/**
 * Eviction order: unpinned rows only. Rows the server already holds go first (oldest first),
 * because dropping them loses nothing. Rows that were never uploaded go last (oldest first), and
 * only if the cap still cannot be met. `keep` is exempt (the row just written).
 */
export function pickEvictions(rows: BlobMeta[], maxBytes: number, keep?: string): string[] {
  let total = rows.reduce((n, r) => n + r.size, 0);
  const candidates = rows.filter((r) => !r.pinned && r.key !== keep).sort(byAge);
  const ordered = [
    ...candidates.filter((r) => r.uploaded),
    ...candidates.filter((r) => !r.uploaded),
  ];
  const out: string[] = [];
  for (const r of ordered) {
    if (total <= maxBytes) break;
    out.push(r.key);
    total -= r.size;
  }
  return out;
}

export class DexieBlobStore implements BlobStore {
  private readonly maxBytes: number;
  private readonly now: () => number;

  constructor(
    private readonly db: Dexie,
    private readonly table: Table<Row, string>,
    options: BlobStoreOptions = {},
  ) {
    this.maxBytes = options.maxBytes ?? DEFAULT_BLOB_CAP_BYTES;
    this.now = options.now ?? (() => Date.now());
  }

  async put(input: PutBlobInput): Promise<{ evicted: string[] }> {
    if (!isValidBlobName(input.key)) throw new Error(`invalid blob key: ${input.key}`);
    const contentType = baseContentType(input.contentType ?? input.blob.type);
    if (!isAllowedBlobType(contentType)) throw new Error(`unsupported blob type: ${contentType}`);
    const row: Row = {
      key: input.key,
      blob: input.blob,
      contentType,
      size: input.blob.size,
      createdAt: input.createdAt ?? this.now(),
      pinned: input.pinned ?? false,
      uploaded: input.uploaded ?? false,
    };
    return this.db.transaction("rw", this.table, async () => {
      await this.table.put(row);
      return { evicted: await this.enforce(input.key) };
    });
  }

  async get(key: string): Promise<BlobRecord | undefined> {
    return this.table.get(key);
  }

  async list(): Promise<BlobMeta[]> {
    // `each` avoids materializing every blob at once, and only metadata is kept.
    const out: BlobMeta[] = [];
    await this.table.each((row) => out.push(meta(row)));
    return out.sort(byAge);
  }

  async markUploaded(key: string, uploaded?: Pick<BlobMeta, "createdAt" | "size">): Promise<void> {
    await this.table
      .where("key")
      .equals(key)
      .filter((r) => !uploaded || (r.createdAt === uploaded.createdAt && r.size === uploaded.size))
      .modify({ uploaded: true });
  }

  evict(): Promise<string[]> {
    return this.db.transaction("rw", this.table, () => this.enforce());
  }

  async delete(key: string): Promise<void> {
    await this.table.delete(key);
  }

  private async enforce(keep?: string): Promise<string[]> {
    const doomed = pickEvictions(await this.list(), this.maxBytes, keep);
    if (doomed.length > 0) await this.table.bulkDelete(doomed);
    return doomed;
  }
}
