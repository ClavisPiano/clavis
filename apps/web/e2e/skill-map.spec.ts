import { expect, test, type Page } from "@playwright/test";

test.use({ timezoneId: "UTC" });

const DEVICE = "seed-device";
let seq = 0;
const eid = (): string => `01JBX0000000000000001${String(++seq).padStart(5, "0")}`;

/** A placement result (one mastered root) plus one node being learned with a single answer. */
async function seed(page: Page): Promise<void> {
  const base = { deviceId: DEVICE };
  const at = Date.parse("2026-10-14T10:00:00Z");
  const sessionId = "01JBX0000000000000SESS0001";
  const events = [
    {
      ...base,
      id: eid(),
      at,
      type: "session.started",
      v: 1,
      sessionId,
      mode: "instrument",
      budgetSec: 720,
      key: { tonic: "C", mode: "major" },
      tzOffsetMin: 0,
      contentVersion: "seed",
    },
    {
      ...base,
      id: eid(),
      at: at + 1000,
      type: "placement.completed",
      v: 1,
      placementId: "01JBX0000000000000PMAX0001",
      results: { "ear.degrees.major.135": "mastered" },
    },
    {
      ...base,
      id: eid(),
      at: at + 2000,
      type: "node.introduced",
      v: 1,
      sessionId,
      nodeId: "ear.degrees.major.diatonic",
    },
    {
      ...base,
      id: eid(),
      at: at + 2500,
      type: "item.presented",
      v: 1,
      sessionId,
      itemId: "ear.degrees.major.diatonic|d=1",
      nodeId: "ear.degrees.major.diatonic",
      generator: "degreeId",
      block: "ear",
      isNew: true,
      presentation: {},
    },
    {
      ...base,
      id: eid(),
      at: at + 3000,
      type: "attempt.completed",
      v: 1,
      sessionId,
      itemId: "ear.degrees.major.diatonic|d=1",
      nodeId: "ear.degrees.major.diatonic",
      outcome: { correct: true, latencyMs: 1800, retries: 0 },
      inputSource: "midi",
    },
    {
      ...base,
      id: eid(),
      at: at + 4000,
      type: "session.ended",
      v: 1,
      sessionId,
      reason: "completed",
    },
  ];
  const doc = {
    format: "clavis-events",
    formatVersion: 1,
    exportedAt: new Date(at).toISOString(),
    deviceId: DEVICE,
    contentVersion: "seed",
    reducerVersion: 1,
    events,
  };
  const count = String(events.length);
  await page.goto("/dev/state");
  await expect(page.getByTestId("event-count")).toHaveText("1");
  await page.getByTestId("import-file").setInputFiles({
    name: "seed.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(doc)),
  });
  await expect(page.getByTestId("import-status")).toContainText(`${count} valid`);
  await page.getByTestId("import").click();
  await expect(page.getByTestId("import-status")).toContainText(`${count} inserted`);
}

const node = (page: Page, id: string) =>
  page.locator(`[data-testid="map-node"][data-node-id="${id}"]`);

test("a fresh learner's map shows roots as available and the rest locked", async ({ page }) => {
  await page.goto("/progress");
  await page.getByTestId("skill-map-link").click();
  await expect(page).toHaveURL(/\/progress\/map$/);
  await expect(page.getByRole("heading", { name: "Skill map" })).toBeVisible();
  await expect(node(page, "ear.degrees.major.135")).toHaveAttribute("data-state", "available");
  await expect(node(page, "ear.degrees.major.diatonic")).toHaveAttribute("data-state", "locked");
  await expect(page.getByTestId("map-legend")).toContainText("Mastered");
});

test("a seeded learner's node states appear, and a node opens its details and card", async ({
  page,
}) => {
  await seed(page);
  await page.goto("/progress/map");

  await expect(node(page, "ear.degrees.major.135")).toHaveAttribute("data-state", "mastered");
  await expect(node(page, "ear.degrees.major.diatonic")).toHaveAttribute("data-state", "learning");
  await expect(node(page, "ear.rhythm.echo")).toHaveAttribute("data-state", "available");
  await expect(node(page, "ear.cells.major.2-4")).toHaveAttribute("data-state", "locked");
  // State is also text, not only colour.
  await expect(node(page, "ear.degrees.major.135")).toContainText("Mastered");
  // An edge from a prerequisite to its dependent.
  await expect(
    page.locator(
      '[data-testid="map-edge"][data-from="ear.degrees.major.135"][data-to="ear.degrees.major.diatonic"]',
    ),
  ).toHaveCount(1);

  // The page itself never scrolls sideways.
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
  );
  expect(overflow).toBe(false);

  await node(page, "ear.degrees.major.diatonic").click();
  const details = page.getByTestId("node-details");
  await expect(details).toBeVisible();
  await expect(page.getByTestId("node-title")).toHaveText("All major degrees");
  await expect(page.getByTestId("node-state")).toContainText("Learning");
  await expect(page.getByTestId("node-description")).not.toBeEmpty();
  await expect(page.getByTestId("crit-accuracy")).toContainText("90%");
  await expect(page.getByTestId("crit-accuracy")).toContainText("now 100%");
  await expect(page.getByTestId("crit-answers")).toContainText("1 of");
  await expect(page.getByTestId("node-prereqs")).toContainText("Degrees 1, 3, 5: Mastered");
  await expect(details.getByTestId("concept-card")).toHaveAttribute(
    "data-card-id",
    "concept.degrees.major.diatonic",
  );

  await page.keyboard.press("Escape");
  await expect(details).toBeHidden();
  await expect(node(page, "ear.degrees.major.diatonic")).toBeFocused();
});

test("a node opens with the keyboard, and coming-later skills can be shown", async ({ page }) => {
  await page.goto("/progress/map");
  const root = node(page, "ear.degrees.major.135");
  await root.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("node-details")).toBeVisible();
  await expect(page.getByTestId("node-title")).toHaveText("Degrees 1, 3, 5");
  await page.getByTestId("node-close").click();
  await expect(page.getByTestId("node-details")).toBeHidden();

  const before = await page.getByTestId("map-node").count();
  await page.getByTestId("show-later").check();
  const after = await page.getByTestId("map-node").count();
  expect(after).toBeGreaterThan(before);
  await expect(page.locator('[data-testid="map-node"][data-state="later"]').first()).toBeVisible();
});
