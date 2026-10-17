import {
  browserSupportsWebAuthn,
  startAuthentication,
  startRegistration,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
} from "@simplewebauthn/browser";
import { AccountError } from "./errors";

/** The browser side of the ceremonies, injectable so the store is testable without a browser. */
export interface Ceremonies {
  supported: () => boolean;
  register: (options: PublicKeyCredentialCreationOptionsJSON) => Promise<unknown>;
  authenticate: (options: PublicKeyCredentialRequestOptionsJSON) => Promise<unknown>;
}

/** Map what `@simplewebauthn/browser` throws to an `AccountError`. Exported for tests. */
export function mapCeremonyError(e: unknown): AccountError {
  if (e instanceof AccountError) return e;
  const name = e instanceof Error ? e.name : "";
  const code = (e as { code?: unknown } | null)?.code;
  if (code === "ERROR_AUTHENTICATOR_PREVIOUSLY_REGISTERED" || name === "InvalidStateError") {
    return new AccountError("alreadyRegistered", "already registered", undefined, { cause: e });
  }
  if (code === "ERROR_CEREMONY_ABORTED" || name === "NotAllowedError" || name === "AbortError") {
    return new AccountError("cancelled", "cancelled", undefined, { cause: e });
  }
  if (
    name === "NotSupportedError" ||
    code === "ERROR_AUTHENTICATOR_MISSING_DISCOVERABLE_CREDENTIAL_SUPPORT"
  ) {
    return new AccountError("unsupported", "unsupported", undefined, { cause: e });
  }
  return new AccountError("server", "passkey ceremony failed", undefined, { cause: e });
}

export function createCeremonies(): Ceremonies {
  return {
    supported: () => typeof PublicKeyCredential !== "undefined" && browserSupportsWebAuthn(),
    async register(optionsJSON) {
      try {
        return await startRegistration({ optionsJSON });
      } catch (e) {
        throw mapCeremonyError(e);
      }
    },
    async authenticate(optionsJSON) {
      try {
        return await startAuthentication({ optionsJSON });
      } catch (e) {
        throw mapCeremonyError(e);
      }
    },
  };
}
