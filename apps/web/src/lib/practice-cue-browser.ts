import { wallNow } from "./clock";
import type { EventStore, LearnerState } from "@clavis/core";
import { deviceTzOffsetMin } from "./home";
import { readInstallEnv } from "./pwa/ios";
import {
  cueSupport,
  practisedDay,
  reportPractisedIfNeeded,
  type CueDeps,
  type CueSupport,
} from "./practice-cue";

/** Client only. The real browser wiring for the practice cue. */
export function browserCueDeps(): CueDeps {
  return {
    fetch: (input, init) => fetch(input, init),
    getRegistration: async () => {
      if (!("serviceWorker" in navigator)) return undefined;
      // `ready` never resolves when no worker is registered (dev builds), so do not wait on it.
      const registration = await Promise.race([
        navigator.serviceWorker.ready,
        new Promise<undefined>((resolve) => {
          setTimeout(() => {
            resolve(undefined);
          }, 3000);
        }),
      ]);
      return registration;
    },
    permission: () => Notification.permission,
    requestPermission: () => Notification.requestPermission(),
    tzOffsetMin: () => deviceTzOffsetMin(),
  };
}

export function readCueSupport(): CueSupport {
  return cueSupport({
    hasServiceWorker: "serviceWorker" in navigator,
    hasPushManager: "PushManager" in window,
    hasNotification: "Notification" in window,
    install: readInstallEnv(),
  });
}

/**
 * Returns a function to call whenever the learner state changes. It reports "practised today" to
 * the Worker at most once per day and never overlaps itself.
 */
export function createPractisedReporter(store: EventStore): (state: LearnerState) => void {
  let reportedDay: string | undefined;
  let running = false;
  return (state) => {
    const tz = deviceTzOffsetMin();
    const day = practisedDay(state, wallNow(), tz);
    if (day === undefined || day === reportedDay || running) return;
    running = true;
    void reportPractisedIfNeeded(
      {
        fetch: (input, init) => fetch(input, init),
        getMeta: (key) => store.getMeta(key),
        setMeta: (key, value) => store.setMeta(key, value),
        tzOffsetMin: () => tz,
      },
      state,
      wallNow(),
    )
      .then((outcome) => {
        if (outcome === "reported") reportedDay = day;
      })
      .finally(() => {
        running = false;
      });
  };
}
