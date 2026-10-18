// @vitest-environment happy-dom
import { cleanup, render, screen, within } from "@testing-library/svelte";
import { afterEach, describe, expect, it } from "vitest";
import type { PieceCardData, PieceRow } from "../piece-card";
import PieceCard from "./PieceCard.svelte";

afterEach(() => {
  cleanup();
});

const row = (o: Partial<PieceRow> & Pick<PieceRow, "id" | "title" | "status">): PieceRow => ({
  source: "Traditional",
  hand: "right",
  phraseCount: 4,
  learned: 0,
  missing: [],
  runs: 0,
  ...o,
});

function card(rows: PieceRow[]): PieceCardData {
  const open = rows.filter((r) => r.status === "playing" || r.status === "ready");
  const oneHand = open.find((r) => r.hand !== "both");
  const hands = open.find((r) => r.hand === "both");
  return {
    rows,
    current: oneHand ?? hands,
    handsCurrent: oneHand === undefined ? undefined : hands,
    completed: rows.filter((r) => r.status === "completed"),
  };
}

describe("PieceCard", () => {
  it("shows the current piece with its phrase progress and no play-through yet", () => {
    render(PieceCard, {
      card: card([
        row({ id: "piece.a", title: "Hot Cross Buns", status: "playing", learned: 1 }),
        row({ id: "piece.b", title: "Ode to Joy", status: "next" }),
      ]),
    });
    expect(screen.getByTestId("current-title").textContent).toBe("Hot Cross Buns");
    const progress = screen.getByTestId("phrase-progress");
    expect(progress.getAttribute("aria-label")).toBe("1 of 4 phrases learned");
    expect(progress.querySelectorAll(".dot")).toHaveLength(4);
    expect(progress.querySelectorAll(".dot.done")).toHaveLength(1);
    expect(screen.queryByTestId("play-through")).toBeNull();
    expect(screen.getByTestId("piece-hint").textContent).toContain("1 of 4 phrases learned");
  });

  it("offers Play it through, as a link to a run of that piece, once every phrase is learned", () => {
    render(PieceCard, {
      card: card([
        row({ id: "piece.hot-cross-buns", title: "Hot Cross Buns", status: "ready", learned: 4 }),
      ]),
    });
    const link = screen.getByTestId("play-through");
    expect(link.tagName).toBe("A");
    expect(link.getAttribute("href")).toContain("/session?run=piece.hot-cross-buns");
    expect(screen.getByTestId("phrase-progress").querySelectorAll(".dot.done")).toHaveLength(4);
  });

  it("lists every piece with its state, and what a locked piece needs", () => {
    render(PieceCard, {
      card: card([
        row({ id: "piece.a", title: "Hot Cross Buns", status: "completed" }),
        row({ id: "piece.b", title: "Ode to Joy", status: "playing", learned: 2 }),
        row({ id: "piece.c", title: "Mary", status: "next" }),
        row({
          id: "piece.d",
          title: "Mary (left hand)",
          hand: "left",
          status: "locked",
          missing: ["Bass landmarks", "Bass steps"],
        }),
      ]),
    });
    const rows = screen.getAllByTestId("piece-row");
    expect(rows.map((r) => r.dataset.status)).toEqual(["completed", "playing", "next", "locked"]);
    expect(rows[0]?.textContent).toContain("Played through");
    expect(rows[1]?.textContent).toContain("Learning: 2 of 4 phrases");
    expect(rows[2]?.textContent).toContain("Up next");
    expect(rows[3]?.textContent).toContain("Locked: needs Bass landmarks, Bass steps");
    expect(rows[3]?.textContent).toContain("Left hand");
  });

  it("records the pieces played through as milestones", () => {
    render(PieceCard, {
      card: card([
        row({ id: "piece.a", title: "Hot Cross Buns", status: "completed" }),
        row({ id: "piece.b", title: "Ode to Joy", status: "completed" }),
        row({ id: "piece.c", title: "Mary", status: "playing" }),
      ]),
    });
    const milestones = screen.getByTestId("milestones");
    expect(
      within(milestones)
        .getAllByTestId("milestone")
        .map((m) => m.textContent),
    ).toEqual(["Hot Cross Buns, ", "Ode to Joy"]);
  });

  it("says so when every unlocked piece is played through", () => {
    render(PieceCard, {
      card: card([
        row({ id: "piece.a", title: "Hot Cross Buns", status: "completed" }),
        row({
          id: "piece.d",
          title: "Mary (left hand)",
          status: "locked",
          missing: ["Bass steps"],
        }),
      ]),
    });
    expect(screen.getByTestId("all-done")).toBeTruthy();
    expect(screen.queryByTestId("current-piece")).toBeNull();
  });

  it("explains that the first tune is still locked when nothing is unlocked", () => {
    render(PieceCard, {
      card: card([
        row({
          id: "piece.a",
          title: "Hot Cross Buns",
          status: "locked",
          missing: ["Treble landmarks"],
        }),
      ]),
    });
    expect(screen.getByTestId("first-piece-locked")).toBeTruthy();
    expect(screen.queryByTestId("milestones")).toBeNull();
    expect(screen.getByTestId("piece-row").textContent).toContain("Locked: needs Treble landmarks");
  });

  it("shows a hands-together piece learned alongside, and what unlocks a locked one (T5.6)", () => {
    render(PieceCard, {
      card: card([
        row({ id: "piece.b-lh", title: "Ode to Joy (left hand)", status: "playing", hand: "left" }),
        row({
          id: "piece.a-hands",
          title: "Hot Cross Buns (hands together)",
          status: "ready",
          hand: "both",
          learned: 4,
        }),
        row({
          id: "piece.b-hands",
          title: "Ode to Joy (hands together)",
          status: "locked",
          hand: "both",
          missing: ["Hands together, block chords"],
          after: "Ode to Joy",
        }),
      ]),
    });
    expect(screen.getByTestId("current-piece").getAttribute("data-piece")).toBe("piece.b-lh");
    const hands = screen.getByTestId("current-hands-piece");
    expect(within(hands).getByTestId("current-title").textContent).toBe(
      "Hot Cross Buns (hands together)",
    );
    expect(hands.textContent).toContain("Both hands");
    expect(within(hands).getByTestId("midi-note").textContent).toContain("MIDI keyboard");
    expect(within(hands).getByTestId("play-through").getAttribute("href")).toContain(
      "/session?run=piece.a-hands",
    );
    const locked = screen
      .getAllByTestId("piece-row")
      .find((li) => li.getAttribute("data-piece") === "piece.b-hands");
    expect(locked?.textContent).toContain(
      "Locked: needs Hands together, block chords; play Ode to Joy through first",
    );
  });
});
