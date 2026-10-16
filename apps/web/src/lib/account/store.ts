import type { AuthApi } from "./api";
import { AccountError, describeAccountError, type AccountErrorKind } from "./errors";
import type { Ceremonies } from "./webauthn";

/*
 * Account state machine (T4.4). Plain TypeScript with injected API, ceremonies and callbacks, so it
 * is testable without a browser. `account.svelte.ts` makes it reactive and `app.ts` wires it up.
 *
 *   unknown -> (me 200) signedIn | (me 401) anonymous | (network) stays unknown, offline = true
 *   anonymous -> signingUp -> signedIn with recoveryCodes pending -> acknowledge -> signedIn
 *   anonymous -> signingIn | recovering -> signedIn
 *   signedIn -> addingPasskey -> signedIn;  signedIn -> signingOut -> anonymous
 *   signedIn + 401 from /api/me -> anonymous (session expired)
 *
 * Only one action runs at a time (`phase` is not `idle` while one does). A network error on refresh
 * keeps the last known account state and sets `offline`.
 */

export type AccountState =
  | { kind: "unknown" }
  | { kind: "anonymous" }
  | { kind: "signedIn"; userId: string; passkeys: number; recoveryCodesLeft: number };

export type AccountPhase =
  "idle" | "loading" | "signingUp" | "signingIn" | "recovering" | "addingPasskey" | "signingOut";

export interface AccountSnapshot {
  account: AccountState;
  phase: AccountPhase;
  /** The last `/api/me` check or action failed to reach the server. */
  offline: boolean;
  /** WebAuthn is available in this browser. */
  supported: boolean;
  /** Recovery codes from sign-up, shown once until the person confirms they saved them. */
  recoveryCodes: readonly string[] | undefined;
  /** After a recovery code sign-in: ask the person to add a passkey on this device. */
  suggestPasskey: boolean;
  error: { kind: AccountErrorKind; message: string } | undefined;
}

export interface AccountStoreDeps {
  api: AuthApi;
  ceremonies: Ceremonies;
  /** Called after sign-up, passkey sign-in or recovery sign-in (sync clears `signedOut`). */
  onSignedIn: () => void;
  /** Called after sign-out, or when a signed-in session turns out to be expired. */
  onSignedOut: () => void;
}

export interface AccountStore {
  readonly snapshot: AccountSnapshot;
  subscribe(fn: (s: AccountSnapshot) => void): () => void;
  refresh(): Promise<void>;
  signUp(): Promise<boolean>;
  /** The person confirmed they saved the recovery codes. */
  acknowledgeRecoveryCodes(): void;
  signIn(): Promise<boolean>;
  recover(code: string): Promise<boolean>;
  addPasskey(): Promise<boolean>;
  dismissPasskeySuggestion(): void;
  signOut(): Promise<boolean>;
  clearError(): void;
}

export function createAccountStore(deps: AccountStoreDeps): AccountStore {
  const { api, ceremonies } = deps;
  let snap: AccountSnapshot = {
    account: { kind: "unknown" },
    phase: "idle",
    offline: false,
    supported: ceremonies.supported(),
    recoveryCodes: undefined,
    suggestPasskey: false,
    error: undefined,
  };
  const subs = new Set<(s: AccountSnapshot) => void>();

  const set = (patch: Partial<AccountSnapshot>): void => {
    snap = { ...snap, ...patch };
    for (const fn of [...subs]) fn(snap);
  };

  const failure = (e: unknown): AccountSnapshot["error"] => ({
    kind: e instanceof AccountError ? e.kind : "server",
    message: describeAccountError(e),
  });

  /** Reads `/api/me` into state. Throws nothing: errors become `offline` or `anonymous`. */
  async function load(): Promise<void> {
    try {
      const me = await api.me();
      set({
        account: {
          kind: "signedIn",
          userId: me.userId,
          passkeys: me.passkeys,
          recoveryCodesLeft: me.recoveryCodesLeft,
        },
        offline: false,
      });
    } catch (e) {
      if (e instanceof AccountError && e.kind === "unauthorized") {
        const wasSignedIn = snap.account.kind === "signedIn";
        set({ account: { kind: "anonymous" }, offline: false });
        if (wasSignedIn) deps.onSignedOut();
      } else {
        // Offline or a server problem: keep what we last knew.
        set({ offline: true });
      }
    }
  }

  /** Runs one action in `phase`, ignoring the call if another action is in flight. */
  async function action(phase: AccountPhase, body: () => Promise<void>): Promise<boolean> {
    if (snap.phase !== "idle") return false;
    set({ phase, error: undefined });
    try {
      await body();
      return true;
    } catch (e) {
      const kind = e instanceof AccountError ? e.kind : undefined;
      set({ error: failure(e), ...(kind === "network" ? { offline: true } : {}) });
      if (kind === "unauthorized" && snap.account.kind === "signedIn") {
        // The session expired while signed in.
        set({ account: { kind: "anonymous" } });
        deps.onSignedOut();
      }
      return false;
    } finally {
      set({ phase: "idle" });
    }
  }

  function requireSupport(): void {
    if (!ceremonies.supported()) throw new AccountError("unsupported", "WebAuthn unavailable");
  }

  return {
    get snapshot() {
      return snap;
    },
    subscribe(fn) {
      subs.add(fn);
      fn(snap);
      return () => subs.delete(fn);
    },
    async refresh() {
      if (snap.phase !== "idle") return;
      set({ phase: "loading" });
      try {
        await load();
      } finally {
        set({ phase: "idle" });
      }
    },
    signUp: () =>
      action("signingUp", async () => {
        requireSupport();
        const { challengeId, options } = await api.registerOptions();
        const response = await ceremonies.register(options);
        const done = await api.registerVerify(challengeId, response);
        set({
          account: {
            kind: "signedIn",
            userId: done.userId,
            passkeys: 1,
            recoveryCodesLeft: done.recoveryCodes.length,
          },
          recoveryCodes: done.recoveryCodes,
          suggestPasskey: false,
          offline: false,
        });
        deps.onSignedIn();
      }),
    acknowledgeRecoveryCodes() {
      set({ recoveryCodes: undefined });
    },
    signIn: () =>
      action("signingIn", async () => {
        requireSupport();
        const { challengeId, options } = await api.loginOptions();
        const response = await ceremonies.authenticate(options);
        await api.loginVerify(challengeId, response);
        await load();
        set({ suggestPasskey: false });
        deps.onSignedIn();
      }),
    recover: (code) =>
      action("recovering", async () => {
        await api.recovery(code.trim());
        await load();
        set({ suggestPasskey: ceremonies.supported() });
        deps.onSignedIn();
      }),
    addPasskey: () =>
      action("addingPasskey", async () => {
        requireSupport();
        const { challengeId, options } = await api.passkeyOptions();
        const response = await ceremonies.register(options);
        const done = await api.passkeyVerify(challengeId, response);
        const account = snap.account;
        if (account.kind === "signedIn") {
          set({ account: { ...account, passkeys: done.passkeys }, suggestPasskey: false });
        } else {
          await load();
          set({ suggestPasskey: false });
        }
      }),
    dismissPasskeySuggestion() {
      set({ suggestPasskey: false });
    },
    signOut: () =>
      action("signingOut", async () => {
        await api.logout();
        set({
          account: { kind: "anonymous" },
          recoveryCodes: undefined,
          suggestPasskey: false,
          offline: false,
        });
        deps.onSignedOut();
      }),
    clearError() {
      set({ error: undefined });
    },
  };
}
