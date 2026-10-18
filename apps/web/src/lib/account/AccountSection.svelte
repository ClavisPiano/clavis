<script lang="ts">
  import { resolve } from "$app/paths";
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
  /** Which passkey row is being renamed or asked to confirm removal, and the pending name. */
  let renamingId = $state<string | undefined>();
  let renameValue = $state("");
  let removingId = $state<string | undefined>();
  let confirmRegenerate = $state(false);
  let confirmDelete = $state(false);
  /** Shown after a deletion, in the signed-out view that follows. */
  let accountDeleted = $state(false);
  let listRequested = false;

  /** Recovery codes at or below this count get a warning. */
  const LOW_CODES = 3;

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

  // Fetch the passkey list once per sign-in.
  $effect(() => {
    // Actions are ignored while another one runs, so wait for idle (sign-in finishes in "loading").
    if (signedIn && !busy && snap?.passkeys === undefined && !listRequested) {
      listRequested = true;
      void account.store.loadPasskeys();
    } else if (!signedIn) {
      listRequested = false;
    }
  });

  const formatDate = (ms: number): string =>
    new Date(ms).toLocaleDateString(undefined, { dateStyle: "medium" });

  async function saveName(event: SubmitEvent, id: string): Promise<void> {
    event.preventDefault();
    if (await account.store.renamePasskey(id, renameValue)) renamingId = undefined;
  }

  async function removePasskey(id: string): Promise<void> {
    await account.store.removePasskey(id);
    removingId = undefined;
  }

  async function deleteAccount(): Promise<void> {
    if (await account.store.deleteAccount()) accountDeleted = true;
    confirmDelete = false;
  }

  async function regenerate(): Promise<void> {
    await account.store.regenerateRecoveryCodes();
    confirmRegenerate = false;
  }

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
      {#if signedIn.recoveryCodesLeft <= LOW_CODES}
        <p class="card" role="status" data-testid="low-codes">
          {signedIn.recoveryCodesLeft === 0
            ? "You have no recovery codes left."
            : `You have ${String(signedIn.recoveryCodesLeft)} recovery ${signedIn.recoveryCodesLeft === 1 ? "code" : "codes"} left.`}
          If you lose your passkeys you could be locked out. Make new codes below.
        </p>
      {/if}
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
        <button
          type="button"
          class="button"
          data-testid="sign-out-everywhere"
          disabled={busy}
          onclick={() => void account.store.signOutEverywhere()}
        >
          Sign out everywhere
        </button>
      </div>
      <p class="muted">Signing out keeps your practice on this device. It just stops syncing.</p>

      <h3 id="passkeys-heading">Passkeys</h3>
      {#if snap.passkeys}
        <ul class="passkeys" aria-labelledby="passkeys-heading" data-testid="passkey-list">
          {#each snap.passkeys as passkey (passkey.id)}
            <li data-testid="passkey-item">
              {#if renamingId === passkey.id}
                <form class="row" onsubmit={(e) => void saveName(e, passkey.id)}>
                  <label>
                    Name
                    <input
                      type="text"
                      maxlength="60"
                      data-testid="passkey-name"
                      bind:value={renameValue}
                    />
                  </label>
                  <button type="submit" class="button" data-testid="passkey-save" disabled={busy}>
                    Save
                  </button>
                  <button
                    type="button"
                    class="button"
                    onclick={() => {
                      renamingId = undefined;
                    }}
                  >
                    Cancel
                  </button>
                </form>
              {:else}
                <strong>{passkey.label ?? "Unnamed passkey"}</strong>
                <span class="muted">
                  Added {formatDate(passkey.createdAt)}{passkey.lastUsedAt === null
                    ? ", not used to sign in yet"
                    : `, last used ${formatDate(passkey.lastUsedAt)}`}
                </span>
                <div class="row">
                  <button
                    type="button"
                    class="button"
                    data-testid="passkey-rename"
                    disabled={busy}
                    onclick={() => {
                      renamingId = passkey.id;
                      renameValue = passkey.label ?? "";
                      removingId = undefined;
                    }}
                  >
                    Rename
                  </button>
                  {#if removingId === passkey.id}
                    <span id={`remove-note-${passkey.id}`}>
                      Remove this passkey? Other devices will be signed out.
                    </span>
                    <button
                      type="button"
                      class="button"
                      data-testid="passkey-remove-confirm"
                      aria-describedby={`remove-note-${passkey.id}`}
                      disabled={busy}
                      onclick={() => void removePasskey(passkey.id)}
                    >
                      Yes, remove
                    </button>
                    <button
                      type="button"
                      class="button"
                      onclick={() => {
                        removingId = undefined;
                      }}
                    >
                      Keep
                    </button>
                  {:else}
                    <button
                      type="button"
                      class="button"
                      data-testid="passkey-remove"
                      disabled={busy}
                      onclick={() => {
                        removingId = passkey.id;
                        renamingId = undefined;
                      }}
                    >
                      Remove
                    </button>
                  {/if}
                </div>
              {/if}
            </li>
          {/each}
        </ul>
      {/if}

      <h3>Recovery codes</h3>
      <p class="muted">
        {signedIn.recoveryCodesLeft}
        {signedIn.recoveryCodesLeft === 1 ? "code" : "codes"} left. Making new codes replaces all the
        old ones, used or not.
      </p>
      {#if confirmRegenerate}
        <div class="row">
          <span id="regenerate-note">The current codes will stop working.</span>
          <button
            type="button"
            class="button"
            data-testid="regenerate-confirm"
            aria-describedby="regenerate-note"
            disabled={busy}
            onclick={() => void regenerate()}
          >
            Make new codes
          </button>
          <button
            type="button"
            class="button"
            onclick={() => {
              confirmRegenerate = false;
            }}
          >
            Cancel
          </button>
        </div>
      {:else}
        <button
          type="button"
          class="button"
          data-testid="regenerate-codes"
          disabled={busy}
          onclick={() => {
            confirmRegenerate = true;
          }}
        >
          Make new recovery codes
        </button>
      {/if}

      <h3>Your data</h3>
      <p class="muted">
        Download everything the server holds for your account as one file, or delete the account.
        See the <a href={resolve("/privacy")}>privacy page</a> for what is kept.
      </p>
      <div class="row">
        <!-- eslint-disable svelte/no-navigation-without-resolve -- a file download from the API, not an app route -->
        <a
          class="button"
          href="/api/me/export"
          download="clavis-export.json"
          data-testid="export-data"
        >
          Download my data
        </a>
        <!-- eslint-enable svelte/no-navigation-without-resolve -->
        {#if !confirmDelete}
          <button
            type="button"
            class="button"
            data-testid="delete-account"
            disabled={busy}
            onclick={() => {
              confirmDelete = true;
            }}
          >
            Delete my account
          </button>
        {/if}
      </div>
      {#if confirmDelete}
        <div
          class="card"
          role="group"
          aria-labelledby="delete-heading"
          data-testid="delete-confirm"
        >
          <h4 id="delete-heading">Delete your account?</h4>
          <p>
            This removes your account, passkeys, recovery codes, synced practice history and
            recordings from the server. It cannot be undone. Practice on this device is kept.
          </p>
          <div class="row">
            <button
              type="button"
              class="button"
              data-testid="delete-confirm-yes"
              disabled={busy}
              onclick={() => void deleteAccount()}
            >
              Yes, delete my account
            </button>
            <button
              type="button"
              class="button"
              data-testid="delete-cancel"
              onclick={() => {
                confirmDelete = false;
              }}
            >
              Keep my account
            </button>
          </div>
        </div>
      {/if}
    {:else if snap.account.kind === "anonymous"}
      {#if accountDeleted}
        <p role="status" data-testid="account-deleted">
          Your account and its server data were deleted. Practice on this device is untouched.
        </p>
      {/if}
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
    <p class="muted"><a href={resolve("/privacy")} data-testid="privacy-link">Privacy</a></p>
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

  .passkeys {
    list-style: none;
    padding: 0;
    display: grid;
    gap: 0.75rem;
  }
  .muted {
    color: var(--color-text-muted);
  }
</style>
