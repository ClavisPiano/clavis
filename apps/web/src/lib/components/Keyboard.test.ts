// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from "@testing-library/svelte";
import { afterEach, describe, expect, it, vi } from "vitest";
import Keyboard from "./Keyboard.svelte";

afterEach(() => {
  cleanup();
});

/** happy-dom's PointerEvent support varies, so build a MouseEvent-based pointer event. */
function pointer(type: string, pointerId: number, timeStamp?: number): Event {
  const e = new MouseEvent(type, { bubbles: true, cancelable: true });
  Object.defineProperty(e, "pointerId", { value: pointerId });
  if (timeStamp !== undefined) Object.defineProperty(e, "timeStamp", { value: timeStamp });
  return e;
}

function key(name: string): HTMLElement {
  return screen.getByRole("button", { name });
}

describe("Keyboard", () => {
  it("spans at least two octaves, even if asked for less", () => {
    render(Keyboard, { low: 60, high: 62 });
    expect(screen.getAllByRole("button").length).toBeGreaterThanOrEqual(25);
  });

  it("gives every key an accessible note name", () => {
    render(Keyboard, { low: 60, high: 84 });
    expect(key("C 4").dataset.midi).toBe("60");
    expect(key("C sharp 4").dataset.midi).toBe("61");
    expect(key("B 5").dataset.midi).toBe("83");
  });

  it("renders labels per mode", () => {
    const { unmount } = render(Keyboard, { low: 60, high: 84, labels: "c-only" });
    expect(screen.getByText("C4")).toBeTruthy();
    expect(screen.getByText("C6")).toBeTruthy();
    expect(screen.queryByText("D4")).toBeNull();
    unmount();

    const all = render(Keyboard, { low: 60, high: 84, labels: "all" });
    expect(screen.getByText("D4")).toBeTruthy();
    expect(screen.getByText("C#4")).toBeTruthy();
    all.unmount();

    render(Keyboard, { low: 60, high: 84, labels: "none" });
    expect(screen.queryByText("C4")).toBeNull();
  });

  it("marks highlighted keys", () => {
    render(Keyboard, { low: 60, high: 84, highlight: [64] });
    expect(key("E 4").classList.contains("highlight")).toBe(true);
    expect(key("C 4").classList.contains("highlight")).toBe(false);
  });

  it("tracks two pointers independently (multi-touch)", async () => {
    const onpress = vi.fn();
    const onrelease = vi.fn();
    render(Keyboard, { low: 60, high: 84, onpress, onrelease });
    const c = key("C 4");
    const e = key("E 4");

    await fireEvent(c, pointer("pointerdown", 1, 100));
    await fireEvent(e, pointer("pointerdown", 2, 150));
    expect(onpress.mock.calls).toEqual([
      [60, 100],
      [64, 150],
    ]);
    expect(c.classList.contains("pressed")).toBe(true);
    expect(e.classList.contains("pressed")).toBe(true);

    await fireEvent(c, pointer("pointerup", 1, 200));
    expect(onrelease.mock.calls).toEqual([[60, 200]]);
    expect(c.classList.contains("pressed")).toBe(false);
    expect(e.classList.contains("pressed")).toBe(true);

    await fireEvent(e, pointer("pointerup", 2, 250));
    expect(onrelease.mock.calls).toEqual([
      [60, 200],
      [64, 250],
    ]);
  });

  it("releases on pointercancel, once", async () => {
    const onrelease = vi.fn();
    render(Keyboard, { low: 60, high: 84, onrelease });
    const c = key("C 4");
    await fireEvent(c, pointer("pointerdown", 7));
    await fireEvent(c, pointer("pointercancel", 7));
    await fireEvent(c, pointer("lostpointercapture", 7));
    expect(onrelease).toHaveBeenCalledTimes(1);
    expect(c.classList.contains("pressed")).toBe(false);
  });

  it("ignores a release for a pointer that never pressed", async () => {
    const onrelease = vi.fn();
    render(Keyboard, { low: 60, high: 84, onrelease });
    await fireEvent(key("C 4"), pointer("pointerup", 9));
    expect(onrelease).not.toHaveBeenCalled();
  });

  it("ignores input when disabled", async () => {
    const onpress = vi.fn();
    const playSound = vi.fn();
    render(Keyboard, { low: 60, high: 84, disabled: true, onpress, playSound });
    const c = key("C 4");
    await fireEvent(c, pointer("pointerdown", 1));
    expect(onpress).not.toHaveBeenCalled();
    expect(playSound).not.toHaveBeenCalled();
    expect(c.classList.contains("pressed")).toBe(false);
  });

  it("calls playSound on press", async () => {
    const playSound = vi.fn();
    render(Keyboard, { low: 60, high: 84, playSound });
    await fireEvent(key("G 4"), pointer("pointerdown", 1));
    expect(playSound).toHaveBeenCalledWith(67);
  });
});
