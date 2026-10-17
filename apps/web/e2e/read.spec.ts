import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { expectNotationDrawn, seedLearner, skipToReadItem } from "./read-helpers";
import { runToSummary } from "./session-helpers";

/*
 * Reading is on (T3.15): `bassNoteRead` and `rhythmRead` are registered and implemented in the
 * content graph. These specs cover a whole instrument session with all three blocks, a reload
 * while offline in the middle of a session, and the snapshot discard when `contentVersion` changes.
 */

/** The `contentVersion` in the content package's graph file, read as plain JSON. */
function graphContentVersion(): string {
  const file = join(import.meta.dirname, "../../../packages/content/src/graph/v1.json");
  const graph = JSON.parse(readFileSync(file, "utf8")) as { contentVersion: string };
  return graph.contentVersion;
}

const LANDMARKS = { nodeId: "read.bass.landmarks", keyFamily: "A" } as const;
const DEGREES = { nodeId: "ear.degrees.major.135" } as const;

async function waitForServiceWorkerControl(page: Page): Promise<void> {
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null);
}

interface PresentedEvent {
  block: string | null;
  generator: string | null;
}

async function presentedEvents(page: Page): Promise<PresentedEvent[]> {
  await page.goto("/dev/events");
  await expect(page.getByTestId("events")).toBeVisible();
  const rows = await page.locator('[data-testid="event"][data-block]').evaluateAll((els) =>
    els.map((el) => ({
      block: el.getAttribute("data-block"),
      generator: el.getAttribute("data-generator"),
    })),
  );
  return rows.reverse();
}

test.describe("reading is enabled", () => {
  test.setTimeout(150_000);

  test("instrument session: Orient, Ear and Read from a seeded learner", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (err) => errors.push(err.message));
    await seedLearner(page, [DEGREES, LANDMARKS]);

    await page.goto("/session?input=fake&budget=240");
    await page.getByTestId("start").click();
    await expect(page.getByTestId("orient")).toBeVisible();

    await runToSummary(page);
    await expect(page.getByTestId("summary")).toBeVisible();
    await expect(page.getByTestId("summary-accuracy")).toHaveText("100%");

    const presented = await presentedEvents(page);
    const ear = presented.filter((e) => e.block === "ear");
    const read = presented.filter((e) => e.block === "read");
    expect(ear.length).toBeGreaterThan(0);
    expect(read.length).toBeGreaterThan(0);
    expect(read.every((e) => e.generator === "bassNoteRead")).toBe(true);
    // Blocks run in order: every ear item comes before the first reading item.
    const firstRead = presented.findIndex((e) => e.block === "read");
    expect(presented.slice(0, firstRead).every((e) => e.block === "ear")).toBe(true);
    expect(errors).toEqual([]);
  });

  test("a reload while offline in the middle of a session starts clean and still draws notation", async ({
    page,
    context,
  }) => {
    // Rhythm echo is tapped, so the Away ear block needs no microphone. The first run uses up part
    // of the daily new-item cap, so raise it to leave reading items for the second run.
    await seedLearner(page, [{ nodeId: "ear.rhythm.echo" }, LANDMARKS], { newItemsPerDay: 15 });
    await page.goto("/session?mode=away&input=tap&audio=silent&budget=60");
    await waitForServiceWorkerControl(page);
    // The worker is warmed in the background after the first online load. Wait for the asset cache
    // to hold the notation chunk and its worker dependency before going offline.
    await expect
      .poll(
        () =>
          page.evaluate(async () => {
            const cache = await caches.open("clavis-assets-v1");
            return (await cache.keys()).map((r) => r.url);
          }),
        { timeout: 60_000 },
      )
      .toEqual(
        expect.arrayContaining([
          expect.stringMatching(/verovio/),
          expect.stringMatching(/workers\/chunks\//),
        ]),
      );

    await page.getByTestId("start").click();
    await skipToReadItem(page);
    await expectNotationDrawn(page);

    // Reload mid-session with no network. There is no resume across a reload: the session page
    // comes back at its start screen from the precached shell.
    await context.setOffline(true);
    await page.reload();
    await expect(page.getByTestId("start")).toBeVisible();

    await page.getByTestId("start").click();
    await skipToReadItem(page);
    await expectNotationDrawn(page);
    await expect(page.getByTestId("notation-slot").locator("g.note")).toHaveCount(1);

    // The session killed by the reload was closed as abandoned when the new one started.
    await page.goto("/dev/events");
    await expect(page.getByTestId("events")).toBeVisible();
    const types = await page.getByTestId("event").locator("strong").allTextContents();
    expect(types.filter((t) => t === "session.started")).toHaveLength(3);
    // Seed session, plus the abandoned one. Leaving the page may also end the third.
    expect(types.filter((t) => t === "session.ended").length).toBeGreaterThanOrEqual(2);
  });

  test("a stored snapshot is discarded when contentVersion changes", async ({ page }) => {
    await seedLearner(page, [DEGREES, LANDMARKS]);

    // Write a snapshot straight into IndexedDB. Its state is deliberately wrong (999 events), so
    // whether the app restored it shows in the event count.
    const writeSnapshot = async (contentVersion: string): Promise<void> => {
      const reducerVersion = Number(await page.getByTestId("reducer-version").textContent());
      await page.evaluate(
        async ({ contentVersion: cv, reducerVersion: rv }) => {
          const db = await new Promise<IDBDatabase>((resolve, reject) => {
            const req = indexedDB.open("clavis");
            req.onsuccess = () => {
              resolve(req.result);
            };
            req.onerror = () => {
              reject(req.error ?? new Error("open failed"));
            };
          });
          const events = await new Promise<{ id: string; at: number }[]>((resolve, reject) => {
            const req = db.transaction("events").objectStore("events").getAll();
            req.onsuccess = () => {
              resolve(req.result as { id: string; at: number }[]);
            };
            req.onerror = () => {
              reject(req.error ?? new Error("read failed"));
            };
          });
          const last = [...events].sort((a, b) => a.at - b.at || a.id.localeCompare(b.id)).at(-1);
          if (!last) throw new Error("no events");
          const state = {
            cards: {},
            nodes: {},
            attempts: {},
            sessions: {},
            presented: {},
            durations: {},
            daily: {},
            keyOfDayHistory: [],
            pieces: {},
            imported: {},
            benchmarks: {},
            settings: {},
            lastEvent: { at: last.at, id: last.id },
            eventCount: 999,
            warnings: 0,
          };
          await new Promise<void>((resolve, reject) => {
            const tx = db.transaction("snapshots", "readwrite");
            tx.objectStore("snapshots").put({
              key: "learner",
              reducerVersion: rv,
              contentVersion: cv,
              lastEventAt: last.at,
              lastEventId: last.id,
              state,
            });
            tx.oncomplete = () => {
              resolve();
            };
            tx.onerror = () => {
              reject(tx.error ?? new Error("write failed"));
            };
          });
          db.close();
        },
        { contentVersion, reducerVersion },
      );
    };

    const realCount = await page.getByTestId("event-count").textContent();
    expect(Number(realCount)).toBeGreaterThan(1);
    const current = (await page.getByTestId("content-version").textContent()) ?? "";
    // The page shows the graph's own version, so a content bump never needs a spec edit.
    expect(current).toBe(graphContentVersion());

    // Control: a snapshot for the current content version is trusted.
    await writeSnapshot(current);
    await page.reload();
    await expect(page.getByTestId("event-count")).toHaveText("999");

    // The previous content version (before reading was enabled) is stale: refold from the log.
    await writeSnapshot("2026.10.1");
    await page.reload();
    await expect(page.getByTestId("event-count")).toHaveText(realCount ?? "");
    await expect(
      page.getByTestId("node-row").filter({ hasText: "read.bass.landmarks" }),
    ).toContainText("learning");
  });
});
