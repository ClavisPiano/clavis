import { getAccountStore } from "./app";
import type { AccountSnapshot, AccountStore } from "./store";

/** Reactive view of the account store for UI. Client-only; call `init()` from `onMount`. */
export class ReactiveAccount {
  snap = $state.raw<AccountSnapshot | undefined>();
  private off: (() => void) | undefined;
  private onOnline: (() => void) | undefined;

  get store(): AccountStore {
    return getAccountStore();
  }

  init(): void {
    this.destroy();
    this.off = this.store.subscribe((s) => {
      this.snap = s;
    });
    this.onOnline = () => {
      void this.store.refresh();
    };
    window.addEventListener("online", this.onOnline);
    void this.store.refresh();
  }

  destroy(): void {
    this.off?.();
    this.off = undefined;
    if (this.onOnline) window.removeEventListener("online", this.onOnline);
    this.onOnline = undefined;
  }
}
