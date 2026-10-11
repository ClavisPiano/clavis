import { expect, test, type Page } from "@playwright/test";
import { answerCurrentPhase, storedEventTypes } from "./session-helpers";

/*
 * Placement (T3.16, R19). Fake input with silent audio, so no microphone or audio context is
 * needed. The targets come from window.__clavisSession, which exists only with ?input=fake (the
 * same hook the session specs use); placement stores no item.presented events to read them from.
 */

const SEED_ID_PREFIX = "01JBX0000000000000000";
const PLACED_NODES = [
  "ear.degrees.major.135",
  "ear.degrees.major.diatonic",
  "read.bass.landmarks",
  "read.bass.steps",
  "read.bass.skips",
] as const;

/** Answer every placement item the same way until the summary shows. */
async function runPlacement(page: Page, how: "right" | "wrong"): Promise<void> {
  const root = page.getByTestId("placement");
  await expect(page.getByTestId("placement-start")).toBeVisible();
  await page.getByTestId("placement-start").click();
  const deadline = Date.now() + 280_000;
  while (Date.now() < deadline) {
    const state = await root.getAttribute("data-state");
    if (state === "summary") return;
    if (state === "error") throw new Error("placement reached the error state");
    if (how === "wrong") {
      await page
        .getByTestId("skip")
        .click({ timeout: 500 })
        .catch(() => undefined);
    } else if (state === "listening") {
      await answerCurrentPhase(page);
      await expect(root).not.toHaveAttribute("data-state", "listening", { timeout: 20_000 });
    } else {
      await page.waitForTimeout(50);
    }
  }
  throw new Error("placement did not finish in time");
}

/** Node id to state, from the nodes table of /dev/state. */
async function nodeStates(page: Page): Promise<Record<string, string>> {
  await page.goto("/dev/state");
  await expect(page.getByTestId("node-row").first()).toBeVisible();
  const rows = await page
    .getByTestId("node-row")
    .evaluateAll((trs) =>
      trs.map((tr) => [...tr.querySelectorAll("td")].map((td) => td.textContent)),
    );
  const out: Record<string, string> = {};
  for (const cells of rows) out[cells[0] ?? ""] = cells[2] ?? "";
  return out;
}

/** Import a finished placement through /dev/state, as an earlier run on this device. */
async function seedPlacement(page: Page, state: "mastered" | "fluent"): Promise<void> {
  const doc = {
    format: "clavis-events",
    formatVersion: 1,
    exportedAt: new Date().toISOString(),
    deviceId: "seed-device",
    contentVersion: "seed",
    reducerVersion: 1,
    events: [
      {
        id: `${SEED_ID_PREFIX}00001`,
        deviceId: "seed-device",
        at: Date.now() - 86_400_000,
        v: 1,
        type: "placement.completed",
        placementId: `${SEED_ID_PREFIX}00002`,
        results: Object.fromEntries(PLACED_NODES.map((id) => [id, state])),
      },
    ],
  };
  await page.goto("/dev/state");
  await expect(page.getByTestId("event-count")).toHaveText("1");
  await page.getByTestId("import-file").setInputFiles({
    name: "placement.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(doc)),
  });
  await expect(page.getByTestId("import-status")).toContainText("1 valid events");
  await page.getByTestId("import").click();
  await expect(page.getByTestId("import-status")).toContainText("1 inserted");
}

test.describe("placement", () => {
  test.setTimeout(300_000);

  test("first run offers placement; answering everything right places every node", async ({
    page,
  }) => {
    await page.goto("/");
    await expect(page.getByTestId("placement-offer")).toBeVisible();
    await expect(page.getByTestId("placement-begin")).toHaveAttribute("href", /\/placement$/);

    const before = await nodeStates(page);
    for (const id of PLACED_NODES) expect(before[id]).not.toBe("mastered");

    await page.goto("/placement?input=fake");
    await runPlacement(page, "right");

    const summary = page.getByTestId("placement-summary");
    await expect(summary).toBeVisible();
    await expect(summary.getByTestId("placed-node")).toHaveCount(PLACED_NODES.length);
    for (const id of PLACED_NODES) {
      await expect(summary.locator(`[data-node="${id}"]`)).toHaveAttribute(
        "data-state",
        "mastered",
      );
    }
    // Human-readable titles, not node ids.
    await expect(summary.getByTestId("placed-node").first()).not.toContainText("ear.degrees");

    // Exactly one event was written, and the learner state shows the placed nodes.
    expect(await storedEventTypes(page)).toEqual(["device.registered", "placement.completed"]);
    const after = await nodeStates(page);
    for (const id of PLACED_NODES) expect(after[id]).toBe("mastered");

    // The offer is gone, and Settings can run it again.
    await page.goto("/");
    await expect(page.getByTestId("welcome")).toBeVisible();
    await expect(page.getByTestId("placement-offer")).toHaveCount(0);
    await page.goto("/settings");
    await expect(page.getByTestId("rerun-placement")).toHaveAttribute("href", /\/placement$/);
  });

  test("re-running and answering everything wrong never lowers a node", async ({ page }) => {
    await seedPlacement(page, "mastered");
    const before = await nodeStates(page);
    for (const id of PLACED_NODES) expect(before[id]).toBe("mastered");

    await page.goto("/placement?input=fake");
    await runPlacement(page, "wrong");
    await expect(page.getByTestId("placement-summary")).toBeVisible();
    // Everything is "available" in this run, and the summary says so.
    await expect(page.getByTestId("placed-node").first()).toHaveAttribute(
      "data-state",
      "available",
    );

    const after = await nodeStates(page);
    for (const id of PLACED_NODES) expect(after[id]).toBe("mastered");
    expect((await storedEventTypes(page)).filter((t) => t === "placement.completed")).toHaveLength(
      2,
    );
  });

  test("leaving mid-way stores nothing", async ({ page }) => {
    await page.goto("/placement?input=fake");
    await page.getByTestId("placement-start").click();
    await expect(page.getByTestId("placement")).toHaveAttribute(
      "data-state",
      /presenting|listening/,
    );
    await page.getByTestId("finish").click();
    await expect(page.getByTestId("placement-abandoned")).toBeVisible();
    expect(await storedEventTypes(page)).toEqual(["device.registered"]);
  });

  test("Skip hides the offer, and stays hidden after a reload", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByTestId("placement-offer")).toBeVisible();
    await page.getByTestId("placement-skip").click();
    await expect(page.getByTestId("placement-offer")).toHaveCount(0);

    await page.reload();
    await expect(page.getByTestId("welcome")).toBeVisible();
    await expect(page.getByTestId("placement-offer")).toHaveCount(0);
    // Skipping stores no event.
    expect(await storedEventTypes(page)).toEqual(["device.registered"]);
  });
});
