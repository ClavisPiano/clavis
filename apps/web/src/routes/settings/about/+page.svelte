<script lang="ts">
  import { resolve } from "$app/paths";
  import ExternalLink from "../../../lib/components/ExternalLink.svelte";
  import {
    CLAVIS_LICENCES,
    COPYRIGHT,
    REPO_URL,
    THIRD_PARTY_ASSETS,
    THIRD_PARTY_LIBRARIES,
    displayVersion,
    isLgpl,
    loadNotices,
  } from "../../../lib/about/about";

  const lgpl = THIRD_PARTY_LIBRARIES.find(isLgpl);

  let notices = $state<string | undefined>();
  let noticesFailed = $state(false);

  /** Fetch the licence texts the first time the section is opened. */
  async function onToggle(event: Event) {
    if (!(event.currentTarget as HTMLDetailsElement).open || notices !== undefined) return;
    try {
      notices = await loadNotices();
      noticesFailed = false;
    } catch {
      noticesFailed = true;
    }
  }
</script>

<h1>Licences and source code</h1>

<p>
  Clavis is source-available, not open source. You can read, run and change it for any noncommercial
  purpose. Commercial use is reserved to the copyright holder.
</p>
<p class="muted" data-testid="copyright">{COPYRIGHT}</p>

<section aria-labelledby="source-heading">
  <h2 id="source-heading">Source code</h2>
  <p>
    <ExternalLink href={REPO_URL} testid="source-link">{REPO_URL}</ExternalLink>
  </p>
</section>

<section aria-labelledby="clavis-heading">
  <h2 id="clavis-heading">Clavis licences</h2>
  <ul class="plain">
    {#each CLAVIS_LICENCES as licence (licence.id)}
      <li data-testid={`clavis-${licence.id}`}>
        <strong>{licence.label}:</strong>
        <ExternalLink href={licence.url}>{licence.name}</ExternalLink>
        <br />
        <span class="muted">{licence.summary}</span>
        <ExternalLink href={licence.fileUrl} testid={`licence-file-${licence.id}`}>
          Read the licence file
        </ExternalLink>
      </li>
    {/each}
  </ul>
</section>

{#if lgpl}
  <section aria-labelledby="lgpl-heading" class="callout" data-testid="lgpl-notice">
    <h2 id="lgpl-heading">{lgpl.name} and the LGPL</h2>
    <p>
      Clavis draws sheet music with {lgpl.name}, which is covered by the GNU Lesser General Public
      License, version 3 or later. {lgpl.name} is used unmodified and loads as a separate file, so you
      can replace it with your own build of the same library.
    </p>
    <p>
      <ExternalLink href={lgpl.source ?? REPO_URL} testid="lgpl-source">
        {lgpl.name} source code ({displayVersion(lgpl)})
      </ExternalLink>
      <br />
      The full LGPL and GPL texts are below under "Full licence texts".
    </p>
  </section>
{/if}

<section aria-labelledby="libs-heading">
  <h2 id="libs-heading">Open-source libraries</h2>
  <ul class="plain" data-testid="libraries">
    {#each THIRD_PARTY_LIBRARIES as lib (lib.id)}
      <li data-testid={`lib-${lib.id}`}>
        <strong>{lib.name}</strong>
        {#if displayVersion(lib)}<span class="muted">{displayVersion(lib)}</span>{/if}
        <span class="badge">{lib.license}</span>
        <br />
        <span class="muted">{lib.use}.</span>
        {#if lib.source}
          <ExternalLink href={lib.source}>Source</ExternalLink>
        {/if}
      </li>
    {/each}
  </ul>
</section>

<section aria-labelledby="assets-heading">
  <h2 id="assets-heading">Sounds and tunes</h2>
  <ul class="plain" data-testid="assets">
    {#each THIRD_PARTY_ASSETS as asset (asset.id)}
      <li data-testid={`asset-${asset.id}`}>
        <strong>{asset.name}</strong>
        <span class="badge">{asset.license}</span>
        <br />
        <span class="muted">{asset.use}.</span>
        {#if asset.source}
          <ExternalLink href={asset.source}>Source</ExternalLink>
        {/if}
      </li>
    {/each}
  </ul>
</section>

<details ontoggle={onToggle} data-testid="notices">
  <summary>Full licence texts</summary>
  {#if notices !== undefined}
    <pre data-testid="notices-text">{notices}</pre>
  {:else if noticesFailed}
    <p class="error" role="alert">The licence texts could not be loaded. Try again.</p>
  {:else}
    <p class="muted">Loading</p>
  {/if}
</details>

<p><a href={resolve("/settings")}>Back to settings</a></p>

<style>
  section {
    margin-bottom: var(--space-5);
  }

  .plain {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
  }

  .muted {
    color: var(--color-text-muted);
  }

  .badge {
    display: inline-block;
    padding: 0 var(--space-2);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-sm);
    font-size: 0.85rem;
    color: var(--color-text-muted);
  }

  .callout {
    padding: var(--space-4);
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
  }

  .callout h2 {
    font-size: 1.25rem;
  }

  .callout p:last-child {
    margin-bottom: 0;
  }

  details {
    margin-bottom: var(--space-5);
  }

  summary {
    display: flex;
    align-items: center;
    min-height: var(--touch-target);
    cursor: pointer;
    font-weight: 600;
  }

  pre {
    max-height: 60vh;
    overflow: auto;
    margin: 0;
    padding: var(--space-3);
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-sm);
    font-family: var(--font-mono);
    font-size: 0.8rem;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }

  .error {
    color: var(--color-danger);
  }
</style>
