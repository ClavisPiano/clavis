import { describeEventStoreContract } from "@clavis/core/test-support";
import { IDBKeyRange, indexedDB } from "fake-indexeddb";
import { afterEach } from "vitest";
import { DexieEventStore } from "./dexie-store.js";

const opened: DexieEventStore[] = [];
let counter = 0;

afterEach(() => {
  for (const store of opened.splice(0)) store.close();
});

describeEventStoreContract("DexieEventStore", () => {
  const store = new DexieEventStore({
    name: `clavis-test-${String(++counter)}`,
    indexedDB,
    IDBKeyRange,
  });
  opened.push(store);
  return Promise.resolve(store);
});
