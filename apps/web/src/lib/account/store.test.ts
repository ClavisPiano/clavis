import { describe, expect, it, vi } from "vitest";
import type { AuthApi } from "./api";
import { AccountError } from "./errors";
import { createAccountStore, type AccountSnapshot } from "./store";
import { mapCeremonyError, type Ceremonies } from "./webauthn";
import { recoveryCodesText, syncStatusText } from "./format";

const CODES = Array.from({ length: 10 }, (_, i) => `CODE-${String(i)}`);

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
    logout: vi.fn(() => Promise.resolve()),
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
  const store = createAccountStore({ api, ceremonies: cer, onSignedIn, onSignedOut });
  const phases: string[] = [];
  store.subscribe((s: AccountSnapshot) => {
    if (phases.at(-1) !== s.phase) phases.push(s.phase);
  });
  return { api, cer, store, onSignedIn, onSignedOut, phases };
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
});
