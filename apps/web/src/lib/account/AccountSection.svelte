<script lang="ts">
  import { onMount } from "svelte";
  import { ReactiveSyncStatus } from "../sync/status.svelte";
  import { ReactiveAccount } from "./account.svelte";
  import { RECOVERY_CODES_FILENAME, recoveryCodesText, syncStatusText } from "./format";

  const account = new ReactiveAccount();
  const sync = new ReactiveSyncStatus();

  let showRecoveryInput = $state(false);
  let recoveryInput = $state("");
  let saved = $state(false);
  let copyStatus = $state("");

  onMount(() => {
    account.init();
    sync.init();
    return () => {
      account.destroy();
      sync.destroy();
    };
  });

  const snap = $derived(account.snap);
  const busy = $derived(snap !== undefined && snap.phase !== "idle");
  const signedIn = $derived(snap?.account.kind === "signedIn" ? snap.account : undefined);

  async function recover(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    if (recoveryInput.trim() === "") return;
    if (await account.store.recover(recoveryInput)) {
      recoveryInput = "";
      showRecoveryInput = false;
    }
  }

  async function copyCodes(): Promise<void> {
    if (!snap?.recoveryCodes) return;
    try {
      await navigator.clipboard.writeText(recoveryCodesText(snap.recoveryCodes));
      copyStatus = "Copied.";
    } catch {
      copyStatus = "Could not copy. Select the codes and copy them by hand, or download them.";
    }
  }

  function downloadCodes(): void {
    if (!snap?.recoveryCodes) return;
    const url = URL.createObjectURL(
      new Blob([recoveryCodesText(snap.recoveryCodes)], { type: "text/plain" }),
    );
    const a = document.createElement("a");
    a.href = url;
    a.download = RECOVERY_CODES_FILENAME;
    a.click();
    setTimeout(() => {
      URL.revokeObjectURL(url);
    }, 0);
  }

  function confirmSaved(): void {
    account.store.acknowledgeRecoveryCodes();
    saved = false;
    copyStatus = "";
  }
</script>

<section aria-labelledby="account-heading" data-testid="account-section">
  <h2 id="account-heading">Account</h2>

  {#if !snap}
    <p>Loading...</p>
  {:else}
    {#if snap.error}
      <p role="alert" class="error" data-testid="account-error">{snap.error.message}</p>
    {/if}

    {#if snap.recoveryCodes}
      <div class="card" role="group" aria-labelledby="codes-heading" data-testid="recovery-codes">
        <h3 id="codes-heading">Save your recovery codes</h3>
        <p>
          If you lose access to all your passkeys, a recovery code is the only way back in. Each
          code works once. They will not be shown again.
        </p>
        <ul class="codes" aria-label="Recovery codes">
          {#each snap.recoveryCodes as code (code)}
            <li><code>{code}</code></li>
          {/each}
        </ul>
        <div class="row">
          <button type="button" class="button" data-testid="codes-copy" onclick={copyCodes}>
            Copy
          </button>
          <button type="button" class="button" data-testid="codes-download" onclick={downloadCodes}>
            Download (.txt)
          </button>
        </div>
        {#if copyStatus}<p role="status" class="muted">{copyStatus}</p>{/if}
        <label class="inline">
          <input type="checkbox" data-testid="codes-saved" bind:checked={saved} />
          I have saved these
        </label>
        <button
          type="button"
          class="button"
          data-testid="codes-done"
          disabled={!saved}
          onclick={confirmSaved}
        >
          Continue
        </button>
      </div>
    {/if}

    {#if signedIn}
      <p data-testid="account-summary">
        Signed in. {signedIn.passkeys}
        {signedIn.passkeys === 1 ? "passkey" : "passkeys"}, {signedIn.recoveryCodesLeft} recovery
        {signedIn.recoveryCodesLeft === 1 ? "code" : "codes"} left.
      </p>
      <p role="status" data-testid="sync-status" data-sync-status={sync.state.status}>
        {syncStatusText(sync.state)}
      </p>
      {#if snap.suggestPasskey}
        <p class="card" data-testid="suggest-passkey">
          You signed in with a recovery code. Add a passkey on this device so you do not need
          another one.
        </p>
      {/if}
      {#if signedIn.passkeys < 2 && !snap.suggestPasskey}
        <p class="muted">
          Tip: add a passkey on another device too, so losing one device does not lock you out.
        </p>
      {/if}
      <div class="row">
        <button
          type="button"
          class="button"
          data-testid="sync-now"
          disabled={sync.state.status === "syncing"}
          onclick={() => void sync.syncNow()}
        >
          Sync now
        </button>
        <button
          type="button"
          class="button"
          data-testid="add-passkey"
          disabled={busy || !snap.supported}
          onclick={() => void account.store.addPasskey()}
        >
          Add a passkey
        </button>
        <button
          type="button"
          class="button"
          data-testid="sign-out"
          disabled={busy}
          onclick={() => void account.store.signOut()}
        >
          Sign out
        </button>
      </div>
      <p class="muted">Signing out keeps your practice on this device. It just stops syncing.</p>
    {:else if snap.account.kind === "anonymous"}
      <p>
        Your practice stays on this device. An account backs it up and syncs your devices. There is
        no email or password, only a passkey on this device.
      </p>
      {#if !snap.supported}
        <p role="status" class="muted" data-testid="passkeys-unsupported">
          Passkeys are not supported on this browser, so you cannot create an account or sign in
          here. Your practice still works and is saved on this device.
        </p>
      {/if}
      <div class="row">
        <button
          type="button"
          class="button"
          data-testid="create-account"
          disabled={busy || !snap.supported}
          onclick={() => void account.store.signUp()}
        >
          Create account
        </button>
        <button
          type="button"
          class="button"
          data-testid="sign-in"
          disabled={busy || !snap.supported}
          onclick={() => void account.store.signIn()}
        >
          Sign in with a passkey
        </button>
        <button
          type="button"
          class="button"
          data-testid="use-recovery"
          aria-expanded={showRecoveryInput}
          aria-controls="recovery-form"
          disabled={busy}
          onclick={() => {
            showRecoveryInput = !showRecoveryInput;
          }}
        >
          Use a recovery code
        </button>
      </div>
      {#if showRecoveryInput}
        <form id="recovery-form" class="card" onsubmit={recover} data-testid="recovery-form">
          <label>
            Recovery code
            <input
              type="text"
              data-testid="recovery-input"
              autocomplete="off"
              autocapitalize="characters"
              spellcheck="false"
              placeholder="XXXX-XXXX-XXXX-XXXX"
              bind:value={recoveryInput}
            />
          </label>
          <button
            type="submit"
            class="button"
            data-testid="recovery-submit"
            disabled={busy || recoveryInput.trim() === ""}
          >
            Sign in with code
          </button>
        </form>
      {/if}
    {:else}
      <p role="status" data-testid="account-unknown">
        {snap.offline
          ? "You are offline, so your account status is unavailable. Your practice is saved on this device."
          : "Checking your account..."}
      </p>
    {/if}

    {#if snap.offline && snap.account.kind !== "unknown"}
      <p role="status" class="muted" data-testid="account-offline">
        Offline. Showing what was last known.
      </p>
    {/if}
    {#if busy}
      <p role="status" class="muted">Working...</p>
    {/if}
  {/if}
</section>

<style>
  .row {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-3);
    margin: var(--space-3) 0;
  }

  .card {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    margin: var(--space-3) 0;
    padding: var(--space-4);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    background: var(--color-surface);
  }

  .card h3,
  .card p {
    margin: 0;
  }

  .codes {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(10rem, 1fr));
    gap: var(--space-2);
    margin: 0;
    padding: 0;
    list-style: none;
  }

  code {
    font-family: ui-monospace, monospace;
    overflow-wrap: anywhere;
  }

  label {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
  }

  label.inline {
    flex-direction: row;
    align-items: center;
    gap: var(--space-2);
    min-height: var(--touch-target);
  }

  input[type="text"] {
    min-height: var(--touch-target);
    padding: 0 var(--space-3);
    font: inherit;
    color: var(--color-text);
    background: var(--color-bg, var(--color-surface));
    border: 1px solid var(--color-border);
    border-radius: var(--radius-sm);
  }

  button.button:disabled {
    opacity: 0.5;
  }

  .error {
    color: var(--color-danger);
  }

  .muted {
    color: var(--color-text-muted);
  }
</style>
