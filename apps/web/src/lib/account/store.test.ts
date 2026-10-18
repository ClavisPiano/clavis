import { describe, expect, it, vi } from "vitest";
import type { AuthApi } from "./api";
import { AccountError } from "./errors";
import { createAccountStore, type AccountSnapshot } from "./store";
import { mapCeremonyError, type Ceremonies } from "./webauthn";
import { recoveryCodesText, syncStatusText } from "./format";

const CODES = Array.from({ length: 10 }, (_, i) => `CODE-${String(i)}`);

const NEW_CODES = Array.from({ length: 10 }, (_, i) => `NEW-${String(i)}`);
const PASSKEYS = [
  { id: "a", label: "Laptop", createdAt: 1, lastUsedAt: 2 },
  { id: "b", label: null, createdAt: 3, lastUsedAt: null },
];

function setup(overrides: Partial<AuthApi> = {}, ceremonies: Partial<Ceremonies> = {}) {
  const api: AuthApi = {
    me: vi.fn(() => Promise.reject(new AccountError("unauthorized", "no", 401))),
    registerOptions: vi.fn(() => Promise.resolve({ challengeId: "c1", options: {} as never })),
    registerVerify: vi.fn(() => Promise.resolve({ userId: "u1", recoveryCodes: CODES })),
    loginOptions: vi.fn(() => Promise.resolve({ challengeId: "c2", options: {} as never })),
    loginVerify: vi.fn(() => Promise.resolve({ userId: "u1" })),
    recovery: vi.fn(() => Promise.resolve({ userId: "u1", recoveryCodesLeft: 9 })),
    passkeyOptions: vi.fn(() => Promise.resolve({ challengeId: "c3", options: {} as never })),
    passkeyVerify: vi.fn(() => Promise.resolve({ userId: "u1", passkeys: 2 })),
    listPasskeys: vi.fn(() => Promise.resolve(PASSKEYS)),
    renamePasskey: vi.fn(() => Promise.resolve()),
    removePasskey: vi.fn(() => Promise.resolve({ passkeys: 1 })),
    regenerateRecoveryCodes: vi.fn(() => Promise.resolve(NEW_CODES)),
    deleteAccount: vi.fn(() => Promise.resolve()),
    logout: vi.fn(() => Promise.resolve()),
    logoutAll: vi.fn(() => Promise.resolve()),
    ...overrides,
  };
  const cer: Ceremonies = {
    supported: () => true,
    register: vi.fn(() => Promise.resolve({ id: "new-cred" })),
    authenticate: vi.fn(() => Promise.resolve({ id: "cred" })),
    ...ceremonies,
  };
  const onSignedIn = vi.fn();
  const onSignedOut = vi.fn();
  const onSessionExpired = vi.fn();
  const onAccountDeleted = vi.fn(() => Promise.resolve());
  const store = createAccountStore({
    api,
    ceremonies: cer,
    onSignedIn,
    onSignedOut,
    onSessionExpired,
    onAccountDeleted,
  });
  const phases: string[] = [];
  store.subscribe((s: AccountSnapshot) => {
    if (phases.at(-1) !== s.phase) phases.push(s.phase);
  });
  return { api, cer, store, onSignedIn, onSignedOut, onSessionExpired, onAccountDeleted, phases };
}

const me = { userId: "u1", passkeys: 1, recoveryCodesLeft: 10 };

describe("account store", () => {
  it("starts unknown, then anonymous on 401", async () => {
    const t = setup();
    expect(t.store.snapshot.account.kind).toBe("unknown");
    await t.store.refresh();
    expect(t.store.snapshot.account).toEqual({ kind: "anonymous" });
    expect(t.store.snapshot.offline).toBe(false);
    expect(t.onSignedOut).not.toHaveBeenCalled();
  });

  it("without the signed-in hint, reports anonymous and never calls /api/me", async () => {
    const me = vi.fn(() => Promise.reject(new AccountError("unauthorized", "no", 401)));
    const store = createAccountStore({
      api: { ...setup().api, me },
      ceremonies: setup().cer,
      onSignedIn: vi.fn(),
      onSignedOut: vi.fn(),
      mayHaveSession: () => false,
    });
    await store.refresh();
    expect(store.snapshot.account).toEqual({ kind: "anonymous" });
    expect(me).not.toHaveBeenCalled();
  });

  it("loads a signed in account from /api/me", async () => {
    const t = setup({ me: vi.fn(() => Promise.resolve(me)) });
    await t.store.refresh();
    expect(t.store.snapshot.account).toEqual({ kind: "signedIn", ...me });
  });

  it("anonymous -> signing up -> codes shown -> signed in, and notifies sync", async () => {
    const t = setup();
    await t.store.refresh();
    expect(await t.store.signUp()).toBe(true);
    expect(t.phases).toContain("signingUp");
    const s = t.store.snapshot;
    expect(s.phase).toBe("idle");
    expect(s.account).toEqual({
      kind: "signedIn",
      userId: "u1",
      passkeys: 1,
      recoveryCodesLeft: 10,
    });
    expect(s.recoveryCodes).toEqual(CODES);
    expect(t.cer.register).toHaveBeenCalledOnce();
    expect(t.api.registerVerify).toHaveBeenCalledWith("c1", { id: "new-cred" });
    expect(t.onSignedIn).toHaveBeenCalledOnce();
    t.store.acknowledgeRecoveryCodes();
    expect(t.store.snapshot.recoveryCodes).toBeUndefined();
    expect(t.store.snapshot.account.kind).toBe("signedIn");
  });

  it("ignores a second action while one is running", async () => {
    let release: (() => void) | undefined;
    const t = setup({
      registerOptions: vi.fn(
        () =>
          new Promise<Awaited<ReturnType<AuthApi["registerOptions"]>>>((resolve) => {
            release = () => {
              resolve({ challengeId: "c1", options: {} as never });
            };
          }),
      ),
    });
    const first = t.store.signUp();
    expect(await t.store.signIn()).toBe(false);
    expect(t.api.loginOptions).not.toHaveBeenCalled();
    release?.();
    expect(await first).toBe(true);
  });

  it("a cancelled prompt leaves the person anonymous with a plain message", async () => {
    const t = setup(
      {},
      {
        register: vi.fn(() =>
          Promise.reject(mapCeremonyError(new DOMException("x", "NotAllowedError"))),
        ),
      },
    );
    await t.store.refresh();
    expect(await t.store.signUp()).toBe(false);
    expect(t.store.snapshot.account.kind).toBe("anonymous");
    expect(t.store.snapshot.error?.kind).toBe("cancelled");
    expect(t.store.snapshot.error?.message).toMatch(/cancelled/);
    expect(t.api.registerVerify).not.toHaveBeenCalled();
    expect(t.onSignedIn).not.toHaveBeenCalled();
    t.store.clearError();
    expect(t.store.snapshot.error).toBeUndefined();
  });

  it("signs in with a passkey, then reads the summary", async () => {
    const t = setup({ me: vi.fn(() => Promise.resolve(me)) });
    expect(await t.store.signIn()).toBe(true);
    expect(t.api.loginVerify).toHaveBeenCalledWith("c2", { id: "cred" });
    expect(t.store.snapshot.account).toEqual({ kind: "signedIn", ...me });
    expect(t.store.snapshot.recoveryCodes).toBeUndefined();
    expect(t.onSignedIn).toHaveBeenCalledOnce();
  });

  it("a sign in whose /api/me read fails says so, and still tells sync", async () => {
    const meFn = vi
      .fn()
      .mockRejectedValueOnce(new AccountError("unauthorized", "no", 401))
      .mockRejectedValueOnce(new AccountError("network", "offline"));
    const t = setup({ me: meFn });
    await t.store.refresh();
    expect(await t.store.signIn()).toBe(false);
    expect(t.store.snapshot.account.kind).toBe("unknown");
    expect(t.store.snapshot.offline).toBe(true);
    expect(t.store.snapshot.error?.kind).toBe("network");
    // The session cookie exists, so sync may run and claim local data.
    expect(t.onSignedIn).toHaveBeenCalledOnce();
  });

  it("a recovery sign in whose session did not stick is an error, not signed in", async () => {
    const t = setup();
    await t.store.refresh();
    expect(await t.store.recover("CODE-1")).toBe(false);
    expect(t.store.snapshot.account.kind).toBe("anonymous");
    expect(t.store.snapshot.error?.kind).toBe("unauthorized");
    expect(t.store.snapshot.suggestPasskey).toBe(false);
    expect(t.onSignedIn).not.toHaveBeenCalled();
  });

  it("a rejected passkey login stays anonymous", async () => {
    const t = setup({
      loginVerify: vi.fn(() => Promise.reject(new AccountError("rejected", "no", 401))),
    });
    await t.store.refresh();
    expect(await t.store.signIn()).toBe(false);
    expect(t.store.snapshot.account.kind).toBe("anonymous");
    expect(t.store.snapshot.error?.kind).toBe("rejected");
  });

  it("recovery code sign in suggests adding a passkey, and adding one updates the count", async () => {
    const t = setup({ me: vi.fn(() => Promise.resolve({ ...me, recoveryCodesLeft: 9 })) });
    expect(await t.store.recover("  aaaa-bbbb ")).toBe(true);
    expect(t.api.recovery).toHaveBeenCalledWith("aaaa-bbbb");
    expect(t.store.snapshot.suggestPasskey).toBe(true);
    expect(t.onSignedIn).toHaveBeenCalledOnce();
    expect(await t.store.addPasskey()).toBe(true);
    expect(t.store.snapshot.suggestPasskey).toBe(false);
    expect(t.store.snapshot.account).toMatchObject({ kind: "signedIn", passkeys: 2 });
    expect(t.onSignedIn).toHaveBeenCalledOnce();
  });

  it("an invalid recovery code shows an error and stays anonymous", async () => {
    const t = setup({
      recovery: vi.fn(() => Promise.reject(new AccountError("rejected", "no", 401))),
    });
    expect(await t.store.recover("nope")).toBe(false);
    expect(t.store.snapshot.error?.kind).toBe("rejected");
    expect(t.store.snapshot.suggestPasskey).toBe(false);
    expect(t.onSignedIn).not.toHaveBeenCalled();
  });

  it("signs out: calls logout, becomes anonymous, tells sync, clears codes", async () => {
    const t = setup({ me: vi.fn(() => Promise.resolve(me)) });
    await t.store.refresh();
    expect(await t.store.signOut()).toBe(true);
    expect(t.api.logout).toHaveBeenCalledOnce();
    expect(t.store.snapshot.account).toEqual({ kind: "anonymous" });
    expect(t.onSignedOut).toHaveBeenCalledOnce();
    expect(t.onSessionExpired).not.toHaveBeenCalled();
  });

  it("signs out everywhere through the logoutAll call", async () => {
    const t = setup({ me: vi.fn(() => Promise.resolve(me)) });
    await t.store.refresh();
    expect(await t.store.signOutEverywhere()).toBe(true);
    expect(t.api.logoutAll).toHaveBeenCalledOnce();
    expect(t.api.logout).not.toHaveBeenCalled();
    expect(t.store.snapshot.account).toEqual({ kind: "anonymous" });
    expect(t.onSignedOut).toHaveBeenCalledOnce();
  });

  it("a failed sign out (offline) stays signed in and says so", async () => {
    const t = setup({
      me: vi.fn(() => Promise.resolve(me)),
      logout: vi.fn(() => Promise.reject(new AccountError("network", "x"))),
    });
    await t.store.refresh();
    expect(await t.store.signOut()).toBe(false);
    expect(t.store.snapshot.account.kind).toBe("signedIn");
    expect(t.store.snapshot.offline).toBe(true);
    expect(t.store.snapshot.error?.kind).toBe("network");
    expect(t.onSignedOut).not.toHaveBeenCalled();
  });

  it("a 401 on refresh while signed in drops to anonymous and tells sync", async () => {
    const meFn = vi.fn<AuthApi["me"]>(() => Promise.resolve(me));
    const t = setup({ me: meFn });
    await t.store.refresh();
    meFn.mockRejectedValueOnce(new AccountError("unauthorized", "x", 401));
    await t.store.refresh();
    expect(t.store.snapshot.account).toEqual({ kind: "anonymous" });
    expect(t.onSignedOut).toHaveBeenCalledOnce();
    expect(t.onSessionExpired).toHaveBeenCalledOnce();
  });

  it("a 401 during add passkey means the session expired", async () => {
    const t = setup({
      me: vi.fn(() => Promise.resolve(me)),
      passkeyOptions: vi.fn(() => Promise.reject(new AccountError("unauthorized", "x", 401))),
    });
    await t.store.refresh();
    expect(await t.store.addPasskey()).toBe(false);
    expect(t.store.snapshot.account.kind).toBe("anonymous");
    expect(t.onSignedOut).toHaveBeenCalledOnce();
    expect(t.onSessionExpired).toHaveBeenCalledOnce();
  });

  it("offline: keeps the last known state and sets offline, then recovers", async () => {
    const meFn = vi.fn<AuthApi["me"]>(() => Promise.resolve(me));
    const t = setup({ me: meFn });
    await t.store.refresh();
    meFn.mockRejectedValueOnce(new AccountError("network", "x"));
    await t.store.refresh();
    expect(t.store.snapshot.account).toEqual({ kind: "signedIn", ...me });
    expect(t.store.snapshot.offline).toBe(true);
    expect(t.onSignedOut).not.toHaveBeenCalled();
    await t.store.refresh();
    expect(t.store.snapshot.offline).toBe(false);
  });

  it("offline from the start stays unknown", async () => {
    const t = setup({ me: vi.fn(() => Promise.reject(new AccountError("network", "x"))) });
    await t.store.refresh();
    expect(t.store.snapshot.account.kind).toBe("unknown");
    expect(t.store.snapshot.offline).toBe(true);
  });

  it("without WebAuthn: unsupported, no API calls for passkey flows", async () => {
    const t = setup({}, { supported: () => false });
    expect(t.store.snapshot.supported).toBe(false);
    expect(await t.store.signUp()).toBe(false);
    expect(await t.store.signIn()).toBe(false);
    expect(t.store.snapshot.error?.kind).toBe("unsupported");
    expect(t.api.registerOptions).not.toHaveBeenCalled();
    expect(t.api.loginOptions).not.toHaveBeenCalled();
  });
});

describe("ceremony error mapping", () => {
  it.each([
    [new DOMException("x", "NotAllowedError"), "cancelled"],
    [Object.assign(new Error("x"), { code: "ERROR_CEREMONY_ABORTED" }), "cancelled"],
    [new DOMException("x", "InvalidStateError"), "alreadyRegistered"],
    [new DOMException("x", "NotSupportedError"), "unsupported"],
    [new Error("weird"), "server"],
  ] as const)("%#", (error, kind) => {
    expect(mapCeremonyError(error).kind).toBe(kind);
  });
});

describe("format", () => {
  it("describes sync states with and without a last synced time", () => {
    expect(syncStatusText({ status: "idle" })).toBe("Waiting to sync.");
    expect(syncStatusText({ status: "idle", lastSyncedAt: 1_700_000_000_000 }, "en-US")).toMatch(
      /^Synced\. Last synced .*2023/,
    );
    expect(
      syncStatusText({ status: "idle", lastSyncedAt: 1_700_000_000_000, oversized: 1 }, "en-US"),
    ).toMatch(
      /Synced\. Last synced .*2023.*\. 1 item is too large to back up and stays on this device only\.$/,
    );
    expect(syncStatusText({ status: "error", oversized: 3 })).toMatch(
      /3 items are too large to back up and stay on this device only\.$/,
    );
    // The note only goes with states that say how the backup went.
    expect(syncStatusText({ status: "offline", oversized: 3 })).not.toMatch(/too large/);
    expect(syncStatusText({ status: "idle", oversized: 0 })).toBe("Waiting to sync.");
    expect(syncStatusText({ status: "offline" })).toMatch(/^Offline/);
    expect(syncStatusText({ status: "signedOut" })).toMatch(/signed out/);
    expect(syncStatusText({ status: "syncing" })).toMatch(/^Syncing/);
    expect(syncStatusText({ status: "error" })).toMatch(/could not be backed up/);
  });

  it("recovery codes text lists every code and has no em dash", () => {
    const text = recoveryCodesText(CODES);
    for (const c of CODES) expect(text).toContain(c);
    expect(text).not.toContain("—");
  });

  describe("passkey and recovery code management", () => {
    const signedIn = {
      me: vi.fn(() => Promise.resolve({ userId: "u1", passkeys: 2, recoveryCodesLeft: 2 })),
    };

    it("loads the passkey list and clears it on sign out", async () => {
      const t = setup(signedIn);
      await t.store.refresh();
      expect(await t.store.loadPasskeys()).toBe(true);
      expect(t.store.snapshot.passkeys).toEqual(PASSKEYS);
      expect(t.phases.at(-1)).toBe("idle");
      await t.store.signOut();
      expect(t.store.snapshot.passkeys).toBeUndefined();
    });

    it("adding a passkey refreshes a list that is already loaded, and only then", async () => {
      const t = setup(signedIn);
      await t.store.refresh();
      await t.store.addPasskey();
      expect(t.api.listPasskeys).not.toHaveBeenCalled();
      await t.store.loadPasskeys();
      await t.store.addPasskey();
      expect(t.api.listPasskeys).toHaveBeenCalledTimes(2);
    });

    it("renames, then reloads the list", async () => {
      const t = setup(signedIn);
      await t.store.refresh();
      expect(await t.store.renamePasskey("b", "Phone")).toBe(true);
      expect(t.api.renamePasskey).toHaveBeenCalledWith("b", "Phone");
      expect(t.api.listPasskeys).toHaveBeenCalledOnce();
    });

    it("removes a passkey, updates the count and the list", async () => {
      const t = setup(signedIn);
      await t.store.refresh();
      expect(await t.store.removePasskey("a")).toBe(true);
      expect(t.api.removePasskey).toHaveBeenCalledWith("a");
      expect(t.store.snapshot.account).toEqual({
        kind: "signedIn",
        userId: "u1",
        passkeys: 1,
        recoveryCodesLeft: 2,
      });
      expect(t.store.snapshot.passkeys).toEqual(PASSKEYS);
    });

    it("refusing to remove the last passkey shows the lastPasskey message and stays signed in", async () => {
      const t = setup({
        ...signedIn,
        removePasskey: vi.fn(() => Promise.reject(new AccountError("lastPasskey", "x", 409))),
      });
      await t.store.refresh();
      expect(await t.store.removePasskey("a")).toBe(false);
      expect(t.store.snapshot.error?.kind).toBe("lastPasskey");
      expect(t.store.snapshot.account.kind).toBe("signedIn");
      expect(t.onSignedOut).not.toHaveBeenCalled();
    });

    it("regenerating shows the new codes once and resets the count to ten", async () => {
      const t = setup(signedIn);
      await t.store.refresh();
      expect(await t.store.regenerateRecoveryCodes()).toBe(true);
      expect(t.store.snapshot.recoveryCodes).toEqual(NEW_CODES);
      expect(t.store.snapshot.account).toMatchObject({ recoveryCodesLeft: 10 });
      t.store.acknowledgeRecoveryCodes();
      expect(t.store.snapshot.recoveryCodes).toBeUndefined();
    });

    it("deleting the account resets sync state before reporting signed out, and is not an expiry", async () => {
      const order: string[] = [];
      const t = setup(signedIn);
      t.onAccountDeleted.mockImplementation(() => {
        order.push("reset");
        return Promise.resolve();
      });
      t.onSignedOut.mockImplementation(() => {
        order.push("signedOut");
      });
      await t.store.refresh();
      await t.store.loadPasskeys();
      expect(await t.store.deleteAccount()).toBe(true);
      expect(t.api.deleteAccount).toHaveBeenCalledOnce();
      expect(order).toEqual(["reset", "signedOut"]);
      expect(t.store.snapshot.account).toEqual({ kind: "anonymous" });
      expect(t.store.snapshot.passkeys).toBeUndefined();
      expect(t.onSessionExpired).not.toHaveBeenCalled();
    });

    it("a failed deletion keeps the account, the sync state and an error", async () => {
      const t = setup({
        ...signedIn,
        deleteAccount: vi.fn(() => Promise.reject(new AccountError("server", "x", 500))),
      });
      await t.store.refresh();
      expect(await t.store.deleteAccount()).toBe(false);
      expect(t.onAccountDeleted).not.toHaveBeenCalled();
      expect(t.onSignedOut).not.toHaveBeenCalled();
      expect(t.store.snapshot.account.kind).toBe("signedIn");
      expect(t.store.snapshot.error?.kind).toBe("server");
    });

    it("a 401 while managing means the session expired", async () => {
      const t = setup({
        ...signedIn,
        listPasskeys: vi.fn(() => Promise.reject(new AccountError("unauthorized", "x", 401))),
      });
      await t.store.refresh();
      expect(await t.store.loadPasskeys()).toBe(false);
      expect(t.store.snapshot.account.kind).toBe("anonymous");
      expect(t.onSessionExpired).toHaveBeenCalledOnce();
    });
  });
});
