import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  isSessionExpired,
  isSignedInHint,
  noteSyncSignedOut,
  setSessionExpired,
  setSignedInHint,
} from "./hint";

describe("signed-in and session-expired hints", () => {
  beforeEach(() => {
    const data = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => data.get(k) ?? null,
      setItem: (k: string, v: string) => void data.set(k, v),
      removeItem: (k: string) => void data.delete(k),
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("starts with neither flag set", () => {
    expect(isSignedInHint()).toBe(false);
    expect(isSessionExpired()).toBe(false);
  });

  it("keeps the expired mark when the signed-in hint is cleared", () => {
    setSignedInHint(true);
    setSessionExpired(true);
    setSignedInHint(false);
    expect(isSignedInHint()).toBe(false);
    expect(isSessionExpired()).toBe(true);
  });

  it("signing in again clears the expired mark", () => {
    setSessionExpired(true);
    setSignedInHint(true);
    expect(isSessionExpired()).toBe(false);
  });

  it("reads as not expired when storage is blocked", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    });
    expect(isSessionExpired()).toBe(false);
    expect(() => {
      setSessionExpired(true);
    }).not.toThrow();
  });

  it("can be cleared explicitly", () => {
    setSessionExpired(true);
    setSessionExpired(false);
    expect(isSessionExpired()).toBe(false);
  });

  it("a sync 401 while the hint is set marks the session expired and clears the hint", () => {
    setSignedInHint(true);
    noteSyncSignedOut();
    expect(isSessionExpired()).toBe(true);
    expect(isSignedInHint()).toBe(false);
  });

  it("a sync 401 after the person signed out themselves is not an expiry", () => {
    setSignedInHint(true);
    setSignedInHint(false); // the explicit sign out got there first
    noteSyncSignedOut();
    expect(isSessionExpired()).toBe(false);
  });
});
