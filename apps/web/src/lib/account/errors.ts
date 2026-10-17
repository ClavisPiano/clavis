/*
 * Account errors (T4.4). Every failure the UI can show is one of these kinds, so the copy lives in
 * one place and the store never inspects raw DOM or HTTP errors.
 */

export type AccountErrorKind =
  /** The person dismissed the passkey prompt or it timed out. */
  | "cancelled"
  /** The passkey on this device is already registered. */
  | "alreadyRegistered"
  /** The server did not accept the passkey or the recovery code. */
  | "rejected"
  /** The session cookie is missing or expired (HTTP 401 on a signed-in call). */
  | "unauthorized"
  /** Network failure: offline, DNS, or the server is unreachable. */
  | "network"
  /** Server error or an unexpected response. */
  | "server"
  /** The browser or device cannot do passkeys. */
  | "unsupported"
  /** Too many attempts from this network (HTTP 429). */
  | "rateLimited";

export class AccountError extends Error {
  readonly kind: AccountErrorKind;
  readonly status: number | undefined;
  constructor(kind: AccountErrorKind, message: string, status?: number, options?: ErrorOptions) {
    super(message, options);
    this.name = "AccountError";
    this.kind = kind;
    this.status = status;
  }
}

const MESSAGES: Record<AccountErrorKind, string> = {
  cancelled: "The passkey prompt was cancelled. Nothing changed. You can try again.",
  alreadyRegistered: "This device already has a passkey for Clavis. Try signing in instead.",
  rejected: "That was not accepted. Check it and try again.",
  unauthorized: "You are not signed in. Sign in and try again.",
  network: "Could not reach the server. Check your connection and try again.",
  server: "Something went wrong on the server. Try again in a moment.",
  unsupported: "Passkeys are not supported on this browser.",
  rateLimited: "Too many attempts. Wait a minute and try again.",
};

/** Plain-language text for any thrown value. */
export function describeAccountError(e: unknown): string {
  if (e instanceof AccountError) return MESSAGES[e.kind];
  return MESSAGES.server;
}
