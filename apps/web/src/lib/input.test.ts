import { describe, expect, it } from "vitest";
import { createInput, resolveInputKind, type FakeInputHook } from "./input";
import { isBlackKey, keySlots, noteName, normalizeRange } from "./keyboard";

const q = (s: string) => new URLSearchParams(s);

describe("resolveInputKind", () => {
  it("defaults by session mode", () => {
    expect(resolveInputKind("instrument", q(""))).toBe("mic");
    expect(resolveInputKind("away", q(""))).toBe("tap");
  });

  it("query overrides storage overrides mode", () => {
    expect(resolveInputKind("away", q("input=fake"), "mic")).toBe("fake");
    expect(resolveInputKind("away", q(""), "fake")).toBe("fake");
    expect(resolveInputKind("instrument", q(""), "tap")).toBe("tap");
  });

  it("ignores unknown values", () => {
    expect(resolveInputKind("instrument", q("input=midi"), "bogus")).toBe("mic");
  });
});

describe("createInput", () => {
  it("attaches the fake hook only for fake", () => {
    const target: { __clavisFakeInput?: FakeInputHook | undefined } = {};
    createInput("tap", { target });
    expect(target.__clavisFakeInput).toBeUndefined();

    const handle = createInput("fake", { target });
    const notes: number[] = [];
    handle.adapter.onNote((n) => notes.push(n.pitch));
    target.__clavisFakeInput?.emitNote(62);
    expect(notes).toEqual([62]);
  });
});

describe("keyboard helpers", () => {
  it("names notes with middle C as C4", () => {
    expect(noteName(60)).toBe("C4");
    expect(noteName(61)).toBe("C#4");
    expect(isBlackKey(61)).toBe(true);
    expect(isBlackKey(62)).toBe(false);
  });

  it("widens ranges to two octaves and clamps", () => {
    expect(normalizeRange(60, 61)).toEqual({ low: 60, high: 84 });
    expect(normalizeRange(120, 127)).toEqual({ low: 103, high: 127 });
    expect(normalizeRange(84, 60)).toEqual({ low: 60, high: 84 });
  });

  it("builds slots with black keys attached to the white key below", () => {
    const slots = keySlots(60, 72);
    expect(slots.map((s) => s.white)).toEqual([60, 62, 64, 65, 67, 69, 71, 72]);
    expect(slots.filter((s) => s.black !== undefined).map((s) => s.black)).toEqual([
      61, 63, 66, 68, 70,
    ]);
  });
});
