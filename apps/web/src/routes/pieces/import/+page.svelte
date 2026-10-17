<script lang="ts">
  import { onMount } from "svelte";
  import { goto } from "$app/navigation";
  import { resolve } from "$app/paths";
  import { createUlidGenerator } from "@clavis/core";
  import NotationView from "../../../lib/components/NotationView.svelte";
  import { useLearner } from "../../../lib/learner.svelte";
  import { getNotationClient } from "../../../lib/notation/shared";
  import { createNotationViewPort } from "../../../lib/notation/view-port";
  import {
    IMPORT_ACCEPT,
    MAX_TITLE_LENGTH,
    buildImportEvent,
    cleanTitle,
    convertFile,
    defaultTitle,
    inspectFile,
    previewScore,
    type ImportKind,
  } from "../../../lib/piece-import";
  import type { ScoreInfo } from "@clavis/notation";

  /*
   * Import a MusicXML file as a personal piece (T7.4). Everything happens on this device: the file
   * is read in the browser, converted, previewed, and saved as a `content.imported` event.
   */

  const learner = useLearner();
  const port = createNotationViewPort(getNotationClient());

  let bytes = $state.raw<Uint8Array | undefined>();
  let kind = $state<ImportKind>("musicxml");
  let info = $state.raw<ScoreInfo | undefined>();
  let fileError = $state("");
  let partIndex = $state(0);
  let staff = $state(1);
  let title = $state("");
  let phraseIndex = $state(0);
  let previewFailed = $state(false);
  let saving = $state(false);
  let saveError = $state("");

  onMount(() => {
    void learner.init();
    return () => {
      port.hide();
    };
  });

  const part = $derived(info?.parts[partIndex]);
  const converted = $derived(
    bytes !== undefined && info !== undefined
      ? convertFile(kind, bytes, { partIndex, staff })
      : undefined,
  );
  const candidate = $derived(converted?.ok === true ? converted.candidate : undefined);
  const convertError = $derived(converted?.ok === false ? converted.message : "");
  const phraseCount = $derived(candidate?.phrases.length ?? 0);
  const cleaned = $derived(cleanTitle(title));
  const canSave = $derived(
    candidate !== undefined && cleaned !== undefined && learner.status === "ready" && !saving,
  );

  $effect(() => {
    if (!candidate) {
      port.hide();
      return;
    }
    previewFailed = false;
    const shown = previewScore(candidate, Math.min(phraseIndex, phraseCount - 1));
    port.show(shown).catch(() => {
      previewFailed = true;
    });
  });

  async function onFile(event: Event): Promise<void> {
    const input = event.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    bytes = undefined;
    info = undefined;
    fileError = "";
    saveError = "";
    phraseIndex = 0;
    partIndex = 0;
    staff = 1;
    if (!file) return;
    let data: Uint8Array;
    try {
      data = new Uint8Array(await file.arrayBuffer());
    } catch {
      fileError = "This file could not be read.";
      return;
    }
    const result = inspectFile(file.name, data);
    if (!result.ok) {
      fileError = result.message;
      return;
    }
    kind = result.kind;
    bytes = data;
    info = result.info;
    title = defaultTitle(result.info, file.name);
  }

  function onPart(event: Event): void {
    partIndex = Number((event.currentTarget as HTMLSelectElement).value);
    staff = 1;
    phraseIndex = 0;
  }

  function onStaff(event: Event): void {
    staff = Number((event.currentTarget as HTMLSelectElement).value);
    phraseIndex = 0;
  }

  const staffName = (n: number, total: number): string =>
    total === 2 ? (n === 1 ? "Staff 1 (upper)" : "Staff 2 (lower)") : `Staff ${String(n)}`;

  async function save(): Promise<void> {
    if (!candidate || cleaned === undefined || !canSave) return;
    saving = true;
    saveError = "";
    try {
      const newId = createUlidGenerator({
        now: () => Date.now(),
        randomBytes: (n) => crypto.getRandomValues(new Uint8Array(n)),
      });
      const event = buildImportEvent({
        eventId: newId(),
        pieceUlid: newId(),
        deviceId: learner.ctx.deviceId,
        at: Date.now(),
        title: cleaned,
        kind,
        partIndex,
        staff,
        candidate,
      });
      await learner.append([event]);
      await goto(resolve("/"));
    } catch {
      saveError = "The piece could not be saved on this device. Try again.";
      saving = false;
    }
  }
</script>

<h1>Import a piece</h1>

<p class="muted">
  Choose a MusicXML file (.musicxml, .xml or .mxl) exported from MuseScore, Sibelius, Dorico or
  Finale. It stays on this device. One melody line is imported: a single voice, no tuplets, and full
  measures.
</p>

<section class="card" aria-labelledby="file-h">
  <h2 id="file-h">File</h2>
  <label class="field">
    <span>Score file</span>
    <input
      type="file"
      accept={IMPORT_ACCEPT}
      data-testid="import-file"
      onchange={(e) => void onFile(e)}
    />
  </label>
  {#if fileError}
    <p class="error" role="alert" data-testid="import-error">{fileError}</p>
  {/if}
</section>

{#if info}
  {#if info.parts.length > 1 || (part?.staves ?? 1) > 1}
    <section class="card" aria-labelledby="which-h">
      <h2 id="which-h">Which part</h2>
      {#if info.parts.length > 1}
        <label class="field">
          <span>Part</span>
          <select data-testid="import-part" value={String(partIndex)} onchange={onPart}>
            {#each info.parts as p (p.index)}
              <option value={String(p.index)}>{p.name}</option>
            {/each}
          </select>
        </label>
      {/if}
      {#if (part?.staves ?? 1) > 1}
        {@const total = part?.staves ?? 1}
        <label class="field">
          <span>Staff</span>
          <select data-testid="import-staff" value={String(staff)} onchange={onStaff}>
            {#each Array.from({ length: total }, (_, i) => i + 1) as n (n)}
              <option value={String(n)}>{staffName(n, total)}</option>
            {/each}
          </select>
        </label>
      {/if}
    </section>
  {/if}

  {#if convertError}
    <p class="error" role="alert" data-testid="import-error">{convertError}</p>
  {/if}

  {#if candidate}
    <section class="card" aria-labelledby="preview-h" data-testid="import-preview">
      <h2 id="preview-h">Preview</h2>
      <NotationView
        {port}
        label={`Staff showing phrase ${String(phraseIndex + 1)} of ${String(phraseCount)}`}
      />
      {#if previewFailed}
        <p class="muted" data-testid="preview-failed">
          The preview could not be drawn. You can still save the piece.
        </p>
      {/if}
      {#if phraseCount > 1}
        <div class="phrase-nav">
          <button
            type="button"
            class="button secondary"
            data-testid="phrase-prev"
            disabled={phraseIndex === 0}
            onclick={() => (phraseIndex = Math.max(0, phraseIndex - 1))}
          >
            Previous phrase
          </button>
          <button
            type="button"
            class="button secondary"
            data-testid="phrase-next"
            disabled={phraseIndex >= phraseCount - 1}
            onclick={() => (phraseIndex = Math.min(phraseCount - 1, phraseIndex + 1))}
          >
            Next phrase
          </button>
        </div>
      {/if}
      <p data-testid="import-summary">
        <span data-testid="phrase-count">{phraseCount}</span>
        {phraseCount === 1 ? "phrase" : "phrases"}, difficulty
        <span data-testid="difficulty">{candidate.difficulty}</span>
        of 10. Showing phrase {phraseIndex + 1}.
      </p>
    </section>

    <section class="card" aria-labelledby="save-h">
      <h2 id="save-h">Save</h2>
      <label class="field">
        <span>Title</span>
        <input
          type="text"
          bind:value={title}
          maxlength={MAX_TITLE_LENGTH}
          autocomplete="off"
          data-testid="import-title"
        />
      </label>
      {#if cleaned === undefined}
        <p class="error" data-testid="title-error">Give the piece a title.</p>
      {/if}
      <p class="muted">
        The piece is unlocked straight away and comes up in your sessions like any other piece.
      </p>
      <div class="actions">
        <button
          type="button"
          class="button primary"
          data-testid="import-save"
          disabled={!canSave}
          onclick={() => void save()}
        >
          <strong>Save piece</strong>
        </button>
        <a class="button secondary" href={resolve("/")} data-testid="import-cancel">Cancel</a>
      </div>
      {#if saveError}
        <p class="error" role="alert" data-testid="save-error">{saveError}</p>
      {/if}
    </section>
  {/if}
{:else}
  <p>
    <a href={resolve("/")} data-testid="import-back">Back to Home</a>
  </p>
{/if}

<style>
  .card {
    padding: var(--space-4);
    margin-bottom: var(--space-4);
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
  }

  .card h2 {
    font-size: 1.125rem;
  }

  .field {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
    margin-bottom: var(--space-3);
  }

  select,
  input[type="text"],
  input[type="file"] {
    min-height: var(--touch-target);
    padding: var(--space-2) var(--space-3);
    font: inherit;
    color: var(--color-text);
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-sm);
    max-width: 100%;
  }

  .phrase-nav,
  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-3);
    margin: var(--space-3) 0;
  }

  button.button:disabled {
    opacity: 0.5;
  }

  .error {
    color: var(--color-danger);
    margin: var(--space-2) 0;
  }

  .muted {
    color: var(--color-text-muted);
  }
</style>
