/*
 * Device-local "signed in" hint. The session cookie is HttpOnly, so the page cannot see it; this
 * flag lets the sync loop stay off the network entirely for anonymous learners (no 401 noise).
 * T4.4 sets it after sign-up or sign-in and clears it on sign-out; a 401 from sync clears it too.
 */

const KEY = "clavis.signedIn";

export function isSignedInHint(): boolean {
  try {
    return localStorage.getItem(KEY) === "1";
  } catch {
    return false;
  }
}

export function setSignedInHint(signedIn: boolean): void {
  try {
    if (signedIn) localStorage.setItem(KEY, "1");
    else localStorage.removeItem(KEY);
  } catch {
    // Storage blocked: sync stays off, which is the safe default.
  }
}
