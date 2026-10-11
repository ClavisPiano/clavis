import { describe, expect, it } from "vitest";
import { NAV_ITEMS, isActive } from "./nav";
import { parseSessionMode } from "./session-mode";

describe("isActive", () => {
  const [home, settings] = NAV_ITEMS;
  if (!home || !settings) throw new Error("nav items missing");

  it.each([
    [home, "/", true],
    [home, "/settings", false],
    [settings, "/settings", true],
    [settings, "/settings/x", true],
    [settings, "/settingsx", false],
    [settings, "/", false],
  ] as const)("%j at %s -> %s", (item, path, expected) => {
    expect(isActive(item, path)).toBe(expected);
  });
});

describe("parseSessionMode", () => {
  it.each([
    ["", "instrument"],
    ["mode=away", "away"],
    ["mode=instrument", "instrument"],
    ["mode=bogus", "instrument"],
  ] as const)("%j -> %s", (qs, expected) => {
    expect(parseSessionMode(new URLSearchParams(qs))).toBe(expected);
  });
});
