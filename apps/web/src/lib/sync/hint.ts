/*
 * Device-local "signed in" hint. The session cookie is HttpOnly, so the page cannot see it; this
 * flag lets the sync loop stay off the network entirely for anonymous learners (no 401 noise).
 * T4.4 sets it after sign-up or sign-in and clears it on sign-out; a 401 from sync clears it too.
 */

const KEY = "clavis.signedIn";
/** Set when a signed-in device lost its session (401), so Home can offer "sign in to resume sync". */
const EXPIRED_KEY = "clavis.sessionExpired";

export function isSignedInHint(): boolean {
  try {
    return localStorage.getItem(KEY) === "1";
  } catch {
    return false;
  }
}

export function setSignedInHint(signedIn: boolean): void {
  try {
    if (signedIn) {
      localStorage.setItem(KEY, "1");
      localStorage.removeItem(EXPIRED_KEY);
    } else localStorage.removeItem(KEY);
  } catch {
    // Storage blocked: sync stays off, which is the safe default.
  }
}

export function isSessionExpired(): boolean {
  try {
    return localStorage.getItem(EXPIRED_KEY) === "1";
  } catch {
    return false;
  }
}

/** Mark the session as expired (true) or clear the mark (false, on an explicit sign out). */
export function setSessionExpired(expired: boolean): void {
  try {
    if (expired) localStorage.setItem(EXPIRED_KEY, "1");
    else localStorage.removeItem(EXPIRED_KEY);
  } catch {
    // Storage blocked: no prompt, which only loses a reminder.
  }
}
