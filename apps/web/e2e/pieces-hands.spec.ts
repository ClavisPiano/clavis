import { expect, test } from "@playwright/test";
import { currentPerformance, playPerformance, stubMidi } from "./midi-helpers";
import { expectNotationDrawn, seedLearner } from "./read-helpers";

/*
 * Hands-together pieces (T5.6). A learner who reads the treble staff, plays hands together over
 * block chords (placed as mastered) and has played Hot Cross Buns through is offered the tune again
 * for both hands. Its phrases are played on a stubbed Web MIDI keyboard, in real time at the
 * written 60 bpm, and graded as two-hand performances.
 */

const HCB = "piece.hot-cross-buns";
const HANDS = `${HCB}-hands`;
const PLACED = [
  "read.treble.landmarks",
  "read.treble.steps",
  "read.treble.skips",
  "hands.lh.triads.root",
  "hands.coord.basic",
];

async function seed(page: Parameters<typeof seedLearner>[0]): Promise<void> {
  await seedLearner(page, [], {
    placedMastered: PLACED,
    piecesCompleted: [{ pieceId: HCB, phrases: 2 }],
  });
}

test.describe("Hands-together pieces on a MIDI keyboard", () => {
  test.setTimeout(150_000);
  test.skip(({ browserName }) => browserName !== "chromium", "Web MIDI is a Chromium feature");

  test("Home offers the tune for both hands once it was played through", async ({ page }) => {
    await seed(page);
    await page.goto("/");
    await expect(page.getByTestId("current-piece").getByTestId("current-title")).toHaveText(
      "Ode to Joy",
    );
    const hands = page.getByTestId("current-hands-piece");
    await expect(hands).toHaveAttribute("data-piece", HANDS);
    await expect(hands.getByTestId("current-title")).toHaveText("Hot Cross Buns (hands together)");
    await expect(hands).toContainText("Both hands");
    await expect(hands.getByTestId("midi-note")).toBeVisible();
    await page.getByText("All pieces").click();
    const locked = page.locator('[data-testid="piece-row"][data-piece="piece.ode-to-joy-hands"]');
    await expect(locked).toContainText("Locked: play Ode to Joy through first");
  });

  test("grades each phrase of a run as a two-hand performance", async ({ page }) => {
    await stubMidi(page);
    await seed(page);
    await page.goto(`/session?run=${HANDS}&input=midi&audio=silent&headphones=yes`);
    await page.getByTestId("start").click();

    // Phrase 1: bars 1 and 2 on a grand staff, a C chord under each bar.
    await page.waitForFunction(() => window.__clavisSession?.phase === "listening-play");
    await expectNotationDrawn(page);
    await expect(page.getByTestId("notation-slot")).toHaveAttribute("data-block", "apply");
    await expect(page.getByTestId("prompt")).toHaveText("Play this with both hands");
    await expect(page.getByTestId("hands-hint")).toBeVisible();
    await expect(page.getByTestId("chord-labels").locator(".chord")).toHaveCount(2);
    const first = await currentPerformance(page);
    expect(first.notes.filter((n) => n.hand === "rh")).toHaveLength(6);
    expect(first.notes.filter((n) => n.hand === "lh").map((n) => n.midi)).toEqual([
      48, 52, 55, 48, 52, 55,
    ]);
    await playPerformance(page, first);
    await expect(page.getByTestId("feedback")).toHaveAttribute("data-correct", "true", {
      timeout: 15_000,
    });
    await expect(page.getByTestId("result")).toHaveText("Correct");
    await page.getByTestId("next").click();

    // Phrase 2 (bars 3 and 4): I then V in its first bar. Play the V chord's root a semitone low.
    await page.waitForFunction(() => window.__clavisSession?.phase === "listening-play");
    const second = await currentPerformance(page);
    const vRoot = second.notes.find((n) => n.hand === "lh" && n.onsetBeats === 2);
    expect(vRoot?.midi).toBe(43);
    await playPerformance(page, second, (n) => (n.id === vRoot?.id ? n.midi - 1 : n.midi));
    await expect(page.getByTestId("feedback")).toHaveAttribute("data-correct", "false", {
      timeout: 15_000,
    });
    await expect(page.getByTestId("issues")).toContainText(
      /Bar 1: LH played [A-G][#b]?2 instead of G2/,
    );
  });
});
