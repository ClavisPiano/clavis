import { describe, expect, it } from "vitest";
import { NAV_ITEMS, isActive } from "./nav";
import { parseSessionMode } from "./session-mode";

describe("isActive", () => {
  const find = (href: string) => {
    const item = NAV_ITEMS.find((i) => i.href === href);
    if (!item) throw new Error(`nav item ${href} missing`);
    return item;
  };
  const home = find("/");
  const settings = find("/settings");
  const progress = find("/progress");

  it.each([
    [home, "/", true],
    [home, "/settings", false],
    [settings, "/settings", true],
    [settings, "/settings/x", true],
    [settings, "/settingsx", false],
    [settings, "/", false],
    [progress, "/progress", true],
    [progress, "/progress/", true],
    [progress, "/progressive", false],
    [home, "/progress", false],
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
