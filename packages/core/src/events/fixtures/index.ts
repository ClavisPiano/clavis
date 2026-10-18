import deviceRegistered from "./device.registered.json";
import settingsChanged from "./settings.changed.json";
import settingsChangedV1 from "./settings.changed.v1.json";
import sessionStarted from "./session.started.json";
import sessionStartedV1 from "./session.started.v1.json";
import itemPresented from "./item.presented.json";
import attemptCompleted from "./attempt.completed.json";
import attemptCompletedV1 from "./attempt.completed.v1.json";
import nodeIntroduced from "./node.introduced.json";
import placementCompleted from "./placement.completed.json";
import contentImported from "./content.imported.json";
import pieceCompleted from "./piece.completed.json";
import sessionEnded from "./session.ended.json";
import benchmarkRecorded from "./benchmark.recorded.json";
import drillSpawned from "./drill.spawned.json";

/** One realistic example of every real event type, keyed by type. Test support only. */
export const eventFixtures: Readonly<Record<string, unknown>> = {
  "device.registered": deviceRegistered,
  "settings.changed": settingsChanged,
  "session.started": sessionStarted,
  "item.presented": itemPresented,
  "attempt.completed": attemptCompleted,
  "node.introduced": nodeIntroduced,
  "placement.completed": placementCompleted,
  "piece.completed": pieceCompleted,
  "content.imported": contentImported,
  "session.ended": sessionEnded,
  "benchmark.recorded": benchmarkRecorded,
  "drill.spawned": drillSpawned,
};

/** Shipped v1 events that must keep parsing and upcasting to the latest version. */
export const legacyEventFixtures: readonly unknown[] = [
  settingsChangedV1,
  sessionStartedV1,
  attemptCompletedV1,
];
