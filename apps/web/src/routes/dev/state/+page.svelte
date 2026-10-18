<script lang="ts">
  import { onMount } from "svelte";
  import { REDUCER_VERSION } from "@clavis/core";
  import { makeBackupFile, saveFile } from "../../../lib/backup-file";
  import {
    runImport,
    validateImportText,
    type ImportError,
    type ImportMode,
    type ValidatedImport,
  } from "../../../lib/backup";
  import { useLearner } from "../../../lib/learner.svelte";
  import { recordBackupNow } from "../../../lib/backup-nudge";
  import { isSignedInHint } from "../../../lib/sync/hint";
  import { SYNCED_NOTICE } from "../../../lib/sync/notice";
  import { ReactiveSyncStatus } from "../../../lib/sync/status.svelte";
  import { dueRows, durationRows, nodeRows, recentDays } from "../../../lib/state-view";

  const learner = useLearner();
  const sync = new ReactiveSyncStatus();
  let now = $state(Date.now());
  let exportStatus = $state("");
  let signedIn = $state(false);
  let canShareFiles = $state(false);
  let importStatus = $state("");
  let importErrors = $state<ImportError[]>([]);
  let pending = $state<Extract<ValidatedImport, { ok: true }> | undefined>();
  let pendingName = $state("");
  let mode = $state<ImportMode>("merge");
  let busy = $state(false);

  onMount(async () => {
    sync.init();
    signedIn = isSignedInHint();
    await learner.init();
    now = Date.now();
    canShareFiles =
      typeof navigator.canShare === "function" &&
      navigator.canShare({ files: [new File(["{}"], "probe.json", { type: "application/json" })] });
  });

  const snap = $derived(learner.state);
  const graph = $derived(learner.status === "ready" ? learner.ctx.graph : undefined);
  const fmt = (ms: number): string => new Date(ms).toISOString().replace(".000Z", "Z");
  const pct = (x: number | undefined): string =>
    x === undefined ? "-" : `${(x * 100).toFixed(0)}%`;

  async function makeExport(): Promise<{ file: File; count: number }> {
    const { store, deviceId, graph: g } = learner.ctx;
    return makeBackupFile({ store, deviceId, contentVersion: g.contentVersion });
  }

  async function download(): Promise<void> {
    exportStatus = "";
    try {
      const { file, count } = await makeExport();
      saveFile(file);
      recordBackupNow();
      exportStatus = `Exported ${String(count)} events as ${file.name}`;
    } catch (e) {
      exportStatus = `Export failed: ${e instanceof Error ? e.message : String(e)}`;
    }
  }

  async function share(): Promise<void> {
    exportStatus = "";
    try {
      const { file, count } = await makeExport();
      await navigator.share({ files: [file], title: file.name });
      exportStatus = `Shared ${String(count)} events as ${file.name}`;
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") return;
      exportStatus = `Share failed: ${e instanceof Error ? e.message : String(e)}`;
    }
  }

  async function onFile(event: Event): Promise<void> {
    const input = event.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    pending = undefined;
    importErrors = [];
    importStatus = "";
    if (!file) return;
    const result = validateImportText(await file.text());
    if (result.ok) {
      pending = result;
      pendingName = file.name;
      importStatus = `${file.name}: ${String(result.events.length)} valid events. Nothing is imported yet.`;
    } else {
      importErrors = result.errors;
      importStatus = `${file.name}: ${String(result.errors.length)} problem(s). Nothing was imported.`;
    }
  }

  async function doImport(): Promise<void> {
    if (!pending || busy) return;
    const { service, store } = learner.ctx;
    if (mode === "replace") {
      const n = service.state.eventCount;
      const ok = confirm(
        `Replace will delete all ${String(n)} events on this device before importing ${String(pending.events.length)}. Continue?`,
      );
      if (!ok) return;
    }
    busy = true;
    try {
      const r = await runImport(service, store, pending.events, mode);
      learner.refresh();
      importStatus =
        `Import (${r.mode}) done: ${String(r.inserted)} inserted, ${String(r.skipped)} skipped` +
        (r.mode === "replace" ? `, ${String(r.deleted)} deleted.` : ".");
      pending = undefined;
    } catch (e) {
      learner.refresh();
      importStatus = `Import failed: ${e instanceof Error ? e.message : String(e)}`;
    } finally {
      busy = false;
    }
  }
</script>

<h1>Learner state</h1>

{#if learner.status === "loading"}
  <p>Loading...</p>
{:else if learner.status === "failed" || !snap || !graph}
  <p>Local storage is unavailable.</p>
{:else}
  {@const dueList = dueRows(snap, now)}
  <section>
    <h2>Versions</h2>
    <p>Content version: <code data-testid="content-version">{graph.contentVersion}</code></p>
    <p>Reducer version: <code data-testid="reducer-version">{REDUCER_VERSION}</code></p>
    <p>Device: <code data-testid="device-id">{learner.ctx.deviceId}</code></p>
    <p>Events: <strong data-testid="event-count">{snap.eventCount}</strong></p>
    <p>
      Last event:
      {#if snap.lastEvent}
        <code>{snap.lastEvent.id}</code> at {fmt(snap.lastEvent.at)}
      {:else}
        none
      {/if}
    </p>
    <p>Warnings: <strong data-testid="warnings">{snap.warnings}</strong></p>
    <p>
      Sync: <strong data-testid="sync-status">{sync.state.status}</strong>
      {#if sync.state.lastSyncedAt !== undefined}
        (last {fmt(sync.state.lastSyncedAt)})
      {/if}
    </p>
  </section>

  <section>
    <h2>Backup</h2>
    <p>
      <button type="button" data-testid="export" onclick={download}>Export events</button>
      {#if canShareFiles}
        <button type="button" data-testid="share" onclick={share}>Share</button>
      {/if}
    </p>
    <p role="status" data-testid="export-status">{exportStatus}</p>
    <p>
      <label>
        Import file
        <input
          type="file"
          accept="application/json,.json"
          data-testid="import-file"
          onchange={onFile}
        />
      </label>
    </p>
    {#if pending}
      {#if signedIn}
        <p role="note" data-testid="synced-notice">You are signed in. {SYNCED_NOTICE}</p>
      {/if}
      <fieldset>
        <legend>Import mode for {pendingName}</legend>
        <label
          ><input type="radio" bind:group={mode} value="merge" /> Merge (append, skips known events)</label
        >
        <label
          ><input type="radio" bind:group={mode} value="replace" /> Replace (delete this device's events
          first)</label
        >
      </fieldset>
      <p>
        <button type="button" data-testid="import" disabled={busy} onclick={doImport}>Import</button
        >
      </p>
    {/if}
    <p role="status" data-testid="import-status">{importStatus}</p>
    {#if importErrors.length > 0}
      <ul data-testid="import-errors">
        {#each importErrors.slice(0, 5) as err (err.index)}
          <li>{err.index < 0 ? "File" : `Event ${String(err.index)}`}: {err.message}</li>
        {/each}
        {#if importErrors.length > 5}
          <li>...and {importErrors.length - 5} more</li>
        {/if}
      </ul>
    {/if}
  </section>

  <section>
    <h2>Nodes</h2>
    <div class="scroll">
      <table data-testid="nodes">
        <thead>
          <tr>
            <th>Id</th><th>Strand</th><th>State</th><th>Families</th><th>Introduced</th>
            <th>Attempts</th><th>Window acc.</th>
          </tr>
        </thead>
        <tbody>
          {#each nodeRows(snap, graph) as row (row.id)}
            <tr data-testid="node-row">
              <td>{row.id}</td>
              <td>{row.strand}</td>
              <td>{row.state}</td>
              <td>{row.families}</td>
              <td>{row.introducedAt === undefined ? "-" : fmt(row.introducedAt)}</td>
              <td>{row.attempts}</td>
              <td>{pct(row.windowAccuracy)}</td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  </section>

  <section>
    <h2>Due now</h2>
    {#if dueList.length === 0}
      <p>Nothing due.</p>
    {:else}
      <div class="scroll">
        <table data-testid="due">
          <thead>
            <tr><th>Item</th><th>Node</th><th>Due</th><th>Overdueness</th><th>Stability (d)</th></tr
            >
          </thead>
          <tbody>
            {#each dueList as row (row.itemId)}
              <tr>
                <td>{row.itemId}</td><td>{row.nodeId}</td><td>{fmt(row.due)}</td>
                <td>{row.overdueness.toFixed(2)}</td><td>{row.stability.toFixed(2)}</td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    {/if}
  </section>

  <section>
    <h2>Last 7 learner days</h2>
    <div class="scroll">
      <table data-testid="daily">
        <thead>
          <tr>
            <th>Day</th><th>Sessions</th><th>Practice (s)</th><th>New items</th>
            <th>Nodes introduced</th><th>Instrument</th><th>Away</th>
          </tr>
        </thead>
        <tbody>
          {#each recentDays(snap, now, -new Date().getTimezoneOffset()) as d (d.day)}
            <tr>
              <td>{d.day}</td><td>{d.record.sessions}</td><td>{d.record.practiceSec}</td>
              <td>{d.record.newItems}</td><td>{d.record.nodesIntroduced}</td>
              <td>{d.record.mode.instrument}</td><td>{d.record.mode.away}</td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  </section>

  <section>
    <h2>Median duration per generator</h2>
    <div class="scroll">
      <table data-testid="durations">
        <thead
          ><tr><th>Generator</th><th>Median (s)</th><th>Samples</th><th>Implemented</th></tr></thead
        >
        <tbody>
          {#each durationRows(snap, graph) as d (d.generator)}
            <tr>
              <td>{d.generator}</td><td>{d.medianSec.toFixed(1)}</td><td>{d.samples}</td>
              <td>{d.implemented ? "yes" : "no"}</td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  </section>

  <section>
    <h2>Settings</h2>
    <pre data-testid="settings">{JSON.stringify(snap.settings, null, 2)}</pre>
  </section>
{/if}

<style>
  .scroll {
    overflow-x: auto;
    max-width: 100%;
  }
  table {
    border-collapse: collapse;
    font-size: 0.85rem;
    white-space: nowrap;
  }
  th,
  td {
    border: 1px solid #8884;
    padding: 0.2rem 0.5rem;
    text-align: left;
  }
  fieldset label {
    display: block;
  }
</style>
