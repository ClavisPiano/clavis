// @vitest-environment happy-dom
import { cleanup, render, screen } from "@testing-library/svelte";
import { tick } from "svelte";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FIXTURE_INTERVAL_C3_G3, type ScoreSpec } from "@clavis/core";
import { StubRenderer, type NotationRenderer } from "@clavis/notation";
import { createNotationViewPort } from "../notation/view-port";
import NotationView from "./NotationView.svelte";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function setup(renderer: NotationRenderer = new StubRenderer()) {
  const port = createNotationViewPort(renderer);
  const view = render(NotationView, { port, label: "Test score" });
  return { port, view };
}

describe("NotationView", () => {
  it("show resolves only after the SVG is in the DOM and two frames have fired", async () => {
    let frames = 0;
    const raf = globalThis.requestAnimationFrame.bind(globalThis);
    vi.spyOn(globalThis, "requestAnimationFrame").mockImplementation((cb) => {
      frames++;
      return raf(cb);
    });
    // A renderer that takes a moment, like the worker does.
    const slow: NotationRenderer = {
      preload: () => Promise.resolve(),
      render: async (score: ScoreSpec, opts: { widthPx: number }) => {
        await new Promise((r) => setTimeout(r, 20));
        return new StubRenderer().render(score, opts);
      },
    };
    const { port, view } = setup(slow);
    expect(view.container.querySelector("svg")).toBeNull();

    let svgAtResolve: boolean | undefined;
    let framesAtResolve = -1;
    const shown = port.show(FIXTURE_INTERVAL_C3_G3).then(() => {
      svgAtResolve = view.container.querySelector("svg") !== null;
      framesAtResolve = frames;
    });
    await Promise.resolve();
    expect(svgAtResolve).toBeUndefined();
    expect(view.container.querySelector("svg")).toBeNull();

    await shown;
    expect(svgAtResolve).toBe(true);
    expect(framesAtResolve).toBeGreaterThanOrEqual(2);
    expect(screen.getByRole("img", { name: "Test score" })).toBeTruthy();
  });

  it("describes the score for screen readers without naming the pitches by default", async () => {
    const { port, view } = setup();
    await port.show(FIXTURE_INTERVAL_C3_G3);
    const img = screen.getByRole("img", { name: "Test score" });
    const describedBy = img.getAttribute("aria-describedby");
    expect(describedBy).toBeTruthy();
    const text = view.container.querySelector(`#${describedBy ?? ""}`)?.textContent ?? "";
    expect(text).toContain("Bass clef");
    expect(text).not.toMatch(/\b[A-G] [0-9]\b/);
  });

  it("lists the notes when revealPitches is on", async () => {
    const port = createNotationViewPort(new StubRenderer());
    const view = render(NotationView, { port, label: "Example", revealPitches: true });
    await port.show(FIXTURE_INTERVAL_C3_G3);
    expect(view.container.querySelector("[data-testid=notation-description]")?.textContent).toMatch(
      /C 3/,
    );
  });

  it("has no description before a score is shown", () => {
    const { view } = setup();
    expect(view.container.querySelector("[data-testid=notation-description]")).toBeNull();
  });

  it("highlight sets the mark classes by note id and clears them", async () => {
    const { port, view } = setup();
    await port.show(FIXTURE_INTERVAL_C3_G3);
    const n1 = view.container.querySelector("#n1");
    const n2 = view.container.querySelector("#n2");
    expect(n1?.classList.length).toBe(0);

    port.highlight([
      { noteId: "n1", kind: "target" },
      { noteId: "n2", kind: "wrong" },
    ]);
    await tick();
    expect(n1?.classList.contains("target")).toBe(true);
    expect(n2?.classList.contains("wrong")).toBe(true);

    port.highlight([{ noteId: "n2", kind: "right" }]);
    await tick();
    expect(n1?.classList.contains("target")).toBe(false);
    expect(n2?.classList.contains("wrong")).toBe(false);
    expect(n2?.classList.contains("right")).toBe(true);
  });

  it("hide removes the score", async () => {
    const { port, view } = setup();
    await port.show(FIXTURE_INTERVAL_C3_G3);
    expect(view.container.querySelector("svg")).not.toBeNull();
    port.hide();
    await tick();
    expect(view.container.querySelector("svg")).toBeNull();
  });

  it("a hide during rendering supersedes the show", async () => {
    const { port, view } = setup();
    const shown = port.show(FIXTURE_INTERVAL_C3_G3);
    port.hide();
    await shown;
    expect(view.container.querySelector("svg")).toBeNull();
  });
});
