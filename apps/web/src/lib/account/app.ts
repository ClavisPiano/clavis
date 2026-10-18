import { metaCursorStore } from "@clavis/core";
import { getLearnerState } from "../learner";
import { getSyncController } from "../sync/app";
import { isSignedInHint, setSessionExpired, setSignedInHint } from "../sync/hint";
import { createAuthApi } from "./api";
import { createAccountStore, type AccountStore } from "./store";
import { createCeremonies } from "./webauthn";

let store: AccountStore | undefined;

/** Client-only app-wide account store, wired to the sync controller. */
export function getAccountStore(): AccountStore {
  store ??= createAccountStore({
    api: createAuthApi(),
    ceremonies: createCeremonies(),
    mayHaveSession: isSignedInHint,
    onSignedIn: () => {
      setSignedInHint(true);
      void getSyncController().notifySignedIn();
    },
    onAccountDeleted: async () => {
      // The server copy is gone: everything here is unsynced again, and the old log's cursor means
      // nothing to a new account.
      const r = await getLearnerState();
      if (!r.ok) return;
      await r.store.markAllUnsynced();
      await metaCursorStore(r.store).set(0);
    },
    onSessionExpired: () => {
      setSessionExpired(true);
    },
    onSignedOut: () => {
      setSignedInHint(false);
      setSessionExpired(false);
      getSyncController().notifySignedOut();
    },
  });
  return store;
}
