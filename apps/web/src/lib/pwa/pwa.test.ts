import { describe, expect, it, vi } from "vitest";
import { shouldShowIosInstallHint, type InstallEnv } from "./ios";
import { PERSIST_KEY, requestPersistentStorage } from "./persist";
import { applyUpdate, watchForUpdate, type RegistrationLike, type WorkerLike } from "./update";

const IPHONE_SAFARI =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1";
const IPHONE_CHROME =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/124.0 Mobile/15E148 Safari/604.1";
const IPAD_SAFARI =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15";
const MAC_SAFARI = IPAD_SAFARI;
const ANDROID_CHROME =
  "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Mobile Safari/537.36";

function env(overrides: Partial<InstallEnv>): InstallEnv {
  return {
    userAgent: IPHONE_SAFARI,
    platform: "iPhone",
    maxTouchPoints: 5,
    navigatorStandalone: false,
    displayModeStandalone: false,
    ...overrides,
  };
}

describe("shouldShowIosInstallHint", () => {
  const cases: [string, InstallEnv, boolean][] = [
    ["iPhone Safari in browser", env({}), true],
    [
      "iPhone Safari, navigator.standalone undefined",
      env({ navigatorStandalone: undefined }),
      true,
    ],
    ["iPhone Safari installed (navigator.standalone)", env({ navigatorStandalone: true }), false],
    ["iPhone Safari installed (display-mode)", env({ displayModeStandalone: true }), false],
    ["iPhone Chrome", env({ userAgent: IPHONE_CHROME }), false],
    [
      "iPadOS Safari (desktop UA, touch)",
      env({ userAgent: IPAD_SAFARI, platform: "MacIntel", maxTouchPoints: 5 }),
      true,
    ],
    [
      "macOS Safari (no touch)",
      env({ userAgent: MAC_SAFARI, platform: "MacIntel", maxTouchPoints: 0 }),
      false,
    ],
    [
      "Android Chrome",
      env({ userAgent: ANDROID_CHROME, platform: "Linux armv8l", navigatorStandalone: undefined }),
      false,
    ],
  ];
  it.each(cases)("%s", (_name, input, expected) => {
    expect(shouldShowIosInstallHint(input)).toBe(expected);
  });
});

function memoryStore(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
  };
}

describe("requestPersistentStorage", () => {
  it("asks once and records the result", async () => {
    const persist = vi.fn(() => Promise.resolve(true));
    const local = memoryStore();
    expect(await requestPersistentStorage({ persist }, local)).toBe("granted");
    expect(local.data.get(PERSIST_KEY)).toBe("granted");
    expect(await requestPersistentStorage({ persist }, local)).toBe("already-requested");
    expect(persist).toHaveBeenCalledTimes(1);
  });

  it("records a denial", async () => {
    const local = memoryStore();
    const result = await requestPersistentStorage({ persist: () => Promise.resolve(false) }, local);
    expect(result).toBe("denied");
    expect(local.data.get(PERSIST_KEY)).toBe("denied");
  });

  it("handles unsupported browsers", async () => {
    expect(await requestPersistentStorage(undefined, memoryStore())).toBe("unsupported");
    expect(await requestPersistentStorage({}, memoryStore())).toBe("unsupported");
  });

  it("survives a throwing persist() and throwing localStorage", async () => {
    const local = memoryStore();
    expect(
      await requestPersistentStorage({ persist: () => Promise.reject(new Error("no")) }, local),
    ).toBe("denied");
    const broken = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    };
    expect(await requestPersistentStorage({ persist: () => Promise.resolve(true) }, broken)).toBe(
      "granted",
    );
  });
});

function fakeWorker(state: string): WorkerLike & { fire: () => void; posted: unknown[] } {
  let listener: (() => void) | undefined;
  const posted: unknown[] = [];
  return {
    state,
    posted,
    postMessage: (m) => posted.push(m),
    addEventListener: (_t, l) => {
      listener = l;
    },
    fire: () => listener?.(),
  };
}

function fakeRegistration(waiting: WorkerLike | null = null) {
  let onUpdateFound: (() => void) | undefined;
  const reg: RegistrationLike & { startInstall: (w: WorkerLike) => void } = {
    waiting,
    installing: null,
    addEventListener: (_t, l) => {
      onUpdateFound = l;
    },
    startInstall(w) {
      reg.installing = w;
      onUpdateFound?.();
    },
  };
  return reg;
}

function fakeContainer(controller: unknown) {
  let onChange: (() => void) | undefined;
  return {
    controller,
    addEventListener: (_t: "controllerchange", l: () => void) => {
      onChange = l;
    },
    fireControllerChange: () => onChange?.(),
  };
}

describe("watchForUpdate", () => {
  it("reports an already waiting worker when a controller exists", () => {
    const cb = vi.fn();
    watchForUpdate(fakeRegistration(fakeWorker("installed")), fakeContainer({}), cb);
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it("reports a worker that finishes installing later", () => {
    const cb = vi.fn();
    const reg = fakeRegistration();
    watchForUpdate(reg, fakeContainer({}), cb);
    const worker = fakeWorker("installing");
    reg.startInstall(worker);
    expect(cb).not.toHaveBeenCalled();
    worker.state = "installed";
    worker.fire();
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it("does not report the first install (no controller)", () => {
    const cb = vi.fn();
    const reg = fakeRegistration();
    watchForUpdate(reg, fakeContainer(null), cb);
    const worker = fakeWorker("installed");
    reg.startInstall(worker);
    worker.fire();
    expect(cb).not.toHaveBeenCalled();
  });
});

describe("applyUpdate", () => {
  it("posts SKIP_WAITING and reloads once on controllerchange", () => {
    const waiting = fakeWorker("installed");
    const container = fakeContainer({});
    const reload = vi.fn();
    expect(applyUpdate(fakeRegistration(waiting), container, () => true, reload)).toBe(true);
    expect(waiting.posted).toEqual([{ type: "SKIP_WAITING" }]);
    expect(reload).not.toHaveBeenCalled();
    container.fireControllerChange();
    container.fireControllerChange();
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("does nothing when updating is not allowed", () => {
    const waiting = fakeWorker("installed");
    const reload = vi.fn();
    expect(applyUpdate(fakeRegistration(waiting), fakeContainer({}), () => false, reload)).toBe(
      false,
    );
    expect(waiting.posted).toEqual([]);
  });

  it("does nothing without a waiting worker", () => {
    expect(applyUpdate(fakeRegistration(), fakeContainer({}), () => true, vi.fn())).toBe(false);
  });
});
