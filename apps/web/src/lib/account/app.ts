import { getSyncController } from "../sync/app";
import { isSignedInHint, setSignedInHint } from "../sync/hint";
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
    onSignedOut: () => {
      setSignedInHint(false);
      getSyncController().notifySignedOut();
    },
  });
  return store;
}
