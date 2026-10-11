// Service worker update flow, written against small structural types so it can be unit tested
// with fakes. A new worker installs and then waits; it only takes over when `applyUpdate` asks it
// to (via a SKIP_WAITING message) and the page reloads on `controllerchange`.

export interface WorkerLike {
  state: string;
  postMessage(message: unknown): void;
  addEventListener(type: "statechange", listener: () => void): void;
}

export interface RegistrationLike {
  waiting: WorkerLike | null;
  installing: WorkerLike | null;
  addEventListener(type: "updatefound", listener: () => void): void;
}

export interface ContainerLike {
  controller: unknown;
  addEventListener(type: "controllerchange", listener: () => void): void;
}

/**
 * Calls `onUpdateReady` once a new worker is installed and waiting while an older one controls the
 * page. A first-ever install (no controller) is not an update, so it never fires.
 */
export function watchForUpdate(
  registration: RegistrationLike,
  container: ContainerLike,
  onUpdateReady: () => void,
): void {
  if (registration.waiting && container.controller) onUpdateReady();

  registration.addEventListener("updatefound", () => {
    const worker = registration.installing;
    if (!worker) return;
    worker.addEventListener("statechange", () => {
      if (worker.state === "installed" && container.controller) onUpdateReady();
    });
  });
}

/**
 * Tells the waiting worker to take over and reloads once it controls the page. Returns false and
 * does nothing when updating is not allowed right now or there is no waiting worker.
 */
export function applyUpdate(
  registration: RegistrationLike,
  container: ContainerLike,
  canUpdateNow: () => boolean,
  reload: () => void,
): boolean {
  const waiting = registration.waiting;
  if (!canUpdateNow() || !waiting) return false;

  let reloaded = false;
  container.addEventListener("controllerchange", () => {
    if (reloaded) return;
    reloaded = true;
    reload();
  });
  waiting.postMessage({ type: "SKIP_WAITING" });
  return true;
}
