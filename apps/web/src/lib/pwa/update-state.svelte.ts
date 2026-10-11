import { WARM_NOTATION_MESSAGE } from "./precache";
import { applyUpdate, watchForUpdate } from "./update";

class UpdateState {
  /** A new service worker is installed and waiting. */
  available = $state(false);

  /**
   * Whether it is safe to swap the app version right now. Never update mid-session.
   * The session page sets this to false while a session is open and back to true when it ends.
   */
  canUpdateNow = $state(true);

  #registration: ServiceWorkerRegistration | undefined;

  attach(registration: ServiceWorkerRegistration): void {
    this.#registration = registration;
    watchForUpdate(registration, navigator.serviceWorker, () => {
      this.available = true;
    });
  }

  reload(): void {
    const registration = this.#registration;
    if (!registration) return;
    applyUpdate(
      registration,
      navigator.serviceWorker,
      () => this.canUpdateNow,
      () => {
        location.reload();
      },
    );
  }
}

export const updateState = new UpdateState();

/**
 * Watches the service worker for updates. SvelteKit registers the worker itself (production
 * builds only), so this only waits for the registration and never registers anything.
 */
export async function watchServiceWorker(): Promise<void> {
  if (!("serviceWorker" in navigator)) return;
  try {
    const registration = await navigator.serviceWorker.ready;
    updateState.attach(registration);
    // Fill the notation cache in the background while we are online, so reading works offline
    // later. The worker skips what it already holds.
    if (navigator.onLine) registration.active?.postMessage({ type: WARM_NOTATION_MESSAGE });
    // Installed PWAs can stay alive for days; look for a new version when the app is foregrounded.
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") void registration.update().catch(() => undefined);
    });
  } catch {
    // The worker is optional; the app works online without it.
  }
}
