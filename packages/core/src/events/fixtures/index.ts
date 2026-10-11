import deviceRegistered from "./device.registered.json";
import settingsChanged from "./settings.changed.json";
import sessionStarted from "./session.started.json";
import itemPresented from "./item.presented.json";
import attemptCompleted from "./attempt.completed.json";
import nodeIntroduced from "./node.introduced.json";
import placementCompleted from "./placement.completed.json";
import sessionEnded from "./session.ended.json";

/** One realistic example of every real event type, keyed by type. Test support only. */
export const eventFixtures: Readonly<Record<string, unknown>> = {
  "device.registered": deviceRegistered,
  "settings.changed": settingsChanged,
  "session.started": sessionStarted,
  "item.presented": itemPresented,
  "attempt.completed": attemptCompleted,
  "node.introduced": nodeIntroduced,
  "placement.completed": placementCompleted,
  "session.ended": sessionEnded,
};
