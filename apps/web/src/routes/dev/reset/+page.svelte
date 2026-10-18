<script lang="ts">
  import { onMount } from "svelte";
  import { resolve } from "$app/paths";
  import { makeBackupFile, saveFile } from "../../../lib/backup-file";
  import { useLearner } from "../../../lib/learner.svelte";
  import { recordBackupNow } from "../../../lib/backup-nudge";
  import { isSignedInHint } from "../../../lib/sync/hint";
  import { SYNCED_NOTICE } from "../../../lib/sync/notice";
  import { resetEverything, resetProgress } from "../../../lib/reset";

  type Kind = "progress" | "everything";

  const learner = useLearner();
  let confirming = $state<Kind | undefined>();
  let backupFirst = $state(true);
  let busy = $state(false);
  let status = $state("");
  let signedIn = $state(false);

  onMount(async () => {
    signedIn = isSignedInHint();
    await learner.init();
  });

  function local(): Storage | undefined {
    try {
      return localStorage;
    } catch {
      return undefined;
    }
  }

  async function run(kind: Kind): Promise<void> {
    busy = true;
    status = "";
    try {
      const { store, deviceId, graph } = learner.ctx;
      if (backupFirst) {
        const { file } = await makeBackupFile({
          store,
          deviceId,
          contentVersion: graph.contentVersion,
        });
        saveFile(file);
        recordBackupNow();
      }
      if (kind === "progress") await resetProgress(store);
      else await resetEverything(store, local());
      // A full load rebuilds the app-wide learner state from what is left.
      window.location.assign(resolve("/"));
    } catch (e) {
      status = `Reset failed: ${e instanceof Error ? e.message : String(e)}`;
      busy = false;
    }
  }
</script>

<h1>Reset</h1>
{#if signedIn}
  <p role="note" class="notice" data-testid="synced-notice">
    You are signed in. {SYNCED_NOTICE}
  </p>
{/if}
<p>
  For testing. Neither reset can be undone except by importing a backup on the Learner state page.
</p>

{#if learner.status === "failed"}
  <p role="alert">Local storage is unavailable.</p>
{:else}
  <section>
    <h2>Reset progress</h2>
    <p>
      Deletes sessions, attempts, introductions and placements. Keeps settings, latency calibration
      and headphones. The placement offer and the warm-up card come back.
    </p>
    <button
      type="button"
      data-testid="reset-progress"
      disabled={learner.status !== "ready" || busy}
      onclick={() => (confirming = "progress")}>Reset progress...</button
    >
  </section>

  <section>
    <h2>Reset everything</h2>
    <p>
      Deletes all local data, including settings and calibration, as if freshly installed. The
      developer tools link in Settings stays on.
    </p>
    <button
      type="button"
      data-testid="reset-everything"
      disabled={learner.status !== "ready" || busy}
      onclick={() => (confirming = "everything")}>Reset everything...</button
    >
  </section>

  {#if confirming}
    <div
      class="confirm"
      role="alertdialog"
      aria-labelledby="confirm-title"
      data-testid="reset-confirm"
    >
      <h2 id="confirm-title">
        {confirming === "progress" ? "Reset progress?" : "Reset everything?"}
      </h2>
      <label>
        <input type="checkbox" bind:checked={backupFirst} data-testid="reset-backup" />
        Download a backup first
      </label>
      <p>
        <button
          type="button"
          class="danger"
          data-testid="reset-confirm-button"
          disabled={busy}
          onclick={() => {
            if (confirming) void run(confirming);
          }}>Reset</button
        >
        <button type="button" disabled={busy} onclick={() => (confirming = undefined)}
          >Cancel</button
        >
      </p>
    </div>
  {/if}
  <p role="status" data-testid="reset-status">{status}</p>
{/if}

<style>
  section {
    margin-bottom: var(--space-4);
  }

  .confirm {
    padding: var(--space-4);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
  }

  .confirm h2 {
    margin-top: 0;
  }

  .danger {
    font-weight: 600;
  }
</style>
