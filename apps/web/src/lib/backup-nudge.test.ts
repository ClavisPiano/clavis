import { describe, expect, it } from "vitest";
import {
  BACKUP_STALE_DAYS,
  LAST_BACKUP_KEY,
  NUDGE_DISMISSED_KEY,
  NUDGE_MIN_EVENTS,
  NUDGE_SNOOZE_DAYS,
  readLastBackup,
  readNudgeDismissed,
  readPersistState,
  recordBackup,
  recordNudgeDismissed,
  shouldNudgeBackup,
  type NudgeInput,
} from "./backup-nudge";
import { PERSIST_KEY } from "./pwa/persist";

const DAY = 86_400_000;
const NOW = 1_800_000_000_000;
const base: NudgeInput = {
  now: NOW,
  signedIn: false,
  persist: "denied",
  eventCount: NUDGE_MIN_EVENTS,
  lastBackupAt: undefined,
  dismissedAt: undefined,
};

function memory(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
  };
}

describe("shouldNudgeBackup", () => {
  it("nudges an unsynced learner with unprotected data and no backup", () => {
    expect(shouldNudgeBackup(base)).toBe(true);
    expect(shouldNudgeBackup({ ...base, persist: "unknown" })).toBe(true);
  });

  it.each<[string, Partial<NudgeInput>]>([
    ["signed in", { signedIn: true }],
    ["storage is persistent", { persist: "granted" }],
    ["too little to lose", { eventCount: NUDGE_MIN_EVENTS - 1 }],
    ["backed up recently", { lastBackupAt: NOW - (BACKUP_STALE_DAYS - 1) * DAY }],
    ["said not now recently", { dismissedAt: NOW - (NUDGE_SNOOZE_DAYS - 1) * DAY }],
  ])("stays quiet when %s", (_name, patch) => {
    expect(shouldNudgeBackup({ ...base, ...patch })).toBe(false);
  });

  it("comes back once a backup is stale or a snooze has passed", () => {
    expect(shouldNudgeBackup({ ...base, lastBackupAt: NOW - (BACKUP_STALE_DAYS + 1) * DAY })).toBe(
      true,
    );
    expect(shouldNudgeBackup({ ...base, dismissedAt: NOW - (NUDGE_SNOOZE_DAYS + 1) * DAY })).toBe(
      true,
    );
  });

  it("a backup edge: exactly stale-days old is still fresh", () => {
    expect(shouldNudgeBackup({ ...base, lastBackupAt: NOW - BACKUP_STALE_DAYS * DAY })).toBe(false);
  });
});

describe("stored values", () => {
  it("round-trips the backup and dismissal times", () => {
    const local = memory();
    expect(readLastBackup(local)).toBeUndefined();
    recordBackup(local, NOW);
    recordNudgeDismissed(local, NOW + 5);
    expect(readLastBackup(local)).toBe(NOW);
    expect(readNudgeDismissed(local)).toBe(NOW + 5);
  });

  it("ignores junk and blocked storage", () => {
    expect(readLastBackup(memory({ [LAST_BACKUP_KEY]: "soon" }))).toBeUndefined();
    expect(readNudgeDismissed(memory({ [NUDGE_DISMISSED_KEY]: "-4" }))).toBeUndefined();
    const blocked = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    };
    expect(readLastBackup(blocked)).toBeUndefined();
    expect(readPersistState(blocked)).toBe("unknown");
    expect(() => {
      recordBackup(blocked, NOW);
    }).not.toThrow();
    expect(readLastBackup(undefined)).toBeUndefined();
  });

  it("reads the persistence answer", () => {
    expect(readPersistState(memory())).toBe("unknown");
    expect(readPersistState(memory({ [PERSIST_KEY]: "granted" }))).toBe("granted");
    expect(readPersistState(memory({ [PERSIST_KEY]: "denied" }))).toBe("denied");
  });
});
