import { expect, type Page } from "@playwright/test";

/*
 * Shared by the reading specs (T3.15): seed a learner, get a reading item on screen, and find out
 * what it expects. The session UI never reveals the target, so it is read from the event log.
 */

/** Prefix of the ids the seed helper mints. Crockford base32, so digits and capitals only. */
const SEED_ID_PREFIX = "01JBX0000000000000000";

export interface SeedNode {
  nodeId: string;
  /** Key-dependent (READ) nodes are introduced in family A. */
  keyFamily?: "A";
}

/**
 * Seed a learner through the /dev/state import: one finished session three days ago that
 * introduced the given nodes (and optionally raised the daily new-item cap). Leaves the page on /dev/state. Returns the number of events added.
 */
export async function seedLearner(
  page: Page,
  nodes: readonly SeedNode[],
  opts: {
    newItemsPerDay?: number;
    /** Nodes placed as mastered (a `placement.completed`), so their dependents unlock. */
    placedMastered?: readonly string[];
  } = {},
): Promise<number> {
  const at = Date.now() - 3 * 86_400_000;
  const id = (n: number): string => `${SEED_ID_PREFIX}${String(n).padStart(5, "0")}`;
  const sessionId = id(1);
  const base = { deviceId: "seed-device", v: 1 };
  const events = [
    {
      ...base,
      id: id(2),
      at,
      type: "session.started",
      sessionId,
      mode: "instrument",
      budgetSec: 720,
      key: { tonic: "C", mode: "major" },
      tzOffsetMin: 0,
      contentVersion: "seed",
    },
    ...nodes.map((n, i) => ({
      ...base,
      id: id(3 + i),
      at: at + 1000 + i,
      type: "node.introduced",
      sessionId,
      nodeId: n.nodeId,
      ...(n.keyFamily === undefined ? {} : { keyFamily: n.keyFamily }),
    })),
    ...(opts.placedMastered === undefined
      ? []
      : [
          {
            ...base,
            id: id(101),
            at: at + 500,
            type: "placement.completed",
            placementId: id(102),
            results: Object.fromEntries(opts.placedMastered.map((n) => [n, "mastered"])),
          },
        ]),
    ...(opts.newItemsPerDay === undefined
      ? []
      : [
          {
            ...base,
            v: 2,
            id: id(100),
            at: at + 2000,
            type: "settings.changed",
            patch: { newItemsPerDay: opts.newItemsPerDay },
          },
        ]),
    {
      ...base,
      id: id(3 + nodes.length),
      at: at + 60_000,
      type: "session.ended",
      sessionId,
      reason: "completed",
    },
  ];
  const doc = {
    format: "clavis-events",
    formatVersion: 1,
    exportedAt: new Date().toISOString(),
    deviceId: "seed-device",
    contentVersion: "seed",
    reducerVersion: 1,
    events,
  };
  await page.goto("/dev/state");
  await expect(page.getByTestId("event-count")).toHaveText("1");
  await page.getByTestId("import-file").setInputFiles({
    name: "seed.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(doc)),
  });
  const count = String(events.length);
  await expect(page.getByTestId("import-status")).toContainText(`${count} valid events`);
  await page.getByTestId("import").click();
  await expect(page.getByTestId("import-status")).toContainText(`${count} inserted`);
  return events.length;
}

/**
 * Click through intro cards, orient and the ear block (skipping every ear item) until a reading item
 * is waiting for an answer. Works for any input kind, because skipping needs no answer.
 */
export async function skipToReadItem(page: Page): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const state = await page.getByTestId("session").getAttribute("data-state");
    if (state === "error" || state === "summary") throw new Error(`session ended early: ${state}`);
    const block = await page
      .getByTestId("notation-slot")
      .getAttribute("data-block", { timeout: 500 })
      .catch(() => null);
    if (block === "read") {
      // Never skip a reading item: wait for it to finish presenting.
      if (state === "listening") return;
      await page.waitForTimeout(50);
      continue;
    }
    const click = async (testId: string): Promise<void> => {
      await page
        .getByTestId(testId)
        .click({ timeout: 1_000 })
        .catch(() => undefined);
    };
    if (state === "orient" || state === "intro") await click("continue");
    else if (state === "feedback") await click("next");
    // Only skip while listening: a reading item's notation may not be attached yet while it is
    // still presenting, and skipping then would skip the item this helper is waiting for.
    else if (state === "listening") await click("skip");
    else await page.waitForTimeout(100);
  }
  throw new Error("no reading item appeared");
}

/**
 * The target midi of the newest reading item, read from the event log on a second page of the
 * same browser context (the session UI never shows it).
 */
export async function presentedReadTarget(
  page: Page,
  generator: "bassNoteRead" | "trebleNoteRead" = "bassNoteRead",
): Promise<number> {
  const log = await page.context().newPage();
  try {
    let midi = Number.NaN;
    await expect(async () => {
      await log.goto("/dev/events");
      await expect(log.getByTestId("events")).toBeVisible();
      const raw = await log
        .locator(`[data-testid="event"][data-generator="${generator}"]`)
        .first()
        .getAttribute("data-midi", { timeout: 1_000 });
      midi = Number(raw);
      expect(Number.isInteger(midi)).toBe(true);
    }).toPass({ timeout: 15_000 });
    return midi;
  } finally {
    await log.close();
  }
}

/** Wait until the notation of the current item has been drawn. */
export async function expectNotationDrawn(page: Page): Promise<void> {
  await expect(page.getByTestId("notation-slot").locator("svg").first()).toBeVisible({
    timeout: 30_000,
  });
}
