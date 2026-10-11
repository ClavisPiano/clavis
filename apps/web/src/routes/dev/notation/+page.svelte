<script lang="ts">
  import { onDestroy, onMount } from "svelte";
  import { SCORE_FIXTURES } from "@clavis/core";
  import NotationView from "../../../lib/components/NotationView.svelte";
  import { percentile, round1 } from "../../../lib/notation/bench-stats";
  import { createNotationClient } from "../../../lib/notation/client";
  import { getNotationClient } from "../../../lib/notation/shared";
  import { createNotationViewPort } from "../../../lib/notation/view-port";

  // Dev page for the notation runtime (T3.4). Renders the T3.1 score fixtures through the real
  // client and view, and keeps the T3.2 benchmark (cold init, first render, warm round trips).

  interface Stat {
    p50: number;
    p95: number;
    max: number;
  }
  interface BenchResult {
    userAgent: string;
    coldInitMs: number;
    firstRenderMs: number;
    warmRenders: number;
    warmRoundTripMs: Stat;
    jsHeapUsedBytes: number | null;
    jsHeapLimitBytes: number | null;
  }

  type FixtureKey = keyof typeof SCORE_FIXTURES;
  const FIXTURES: readonly { key: FixtureKey; label: string }[] = [
    { key: "bassF3GMajor", label: "Bass F3, G major" },
    { key: "dMinorRaised7th", label: "D minor raised 7th" },
    { key: "intervalC3G3", label: "Interval C3-G3" },
    { key: "percussionRhythm", label: "Percussion rhythm" },
  ];
  const WARM_RENDERS = 50;
  const WIDTH_PX = 600;

  const port = createNotationViewPort(getNotationClient(), { widthPx: WIDTH_PX });

  let status = $state("Starting the notation worker...");
  let busy = $state(false);
  let results = $state<BenchResult | undefined>();
  const json = $derived(results ? JSON.stringify(results, null, 2) : "");

  async function show(key: FixtureKey): Promise<void> {
    busy = true;
    try {
      const t0 = performance.now();
      await port.show(SCORE_FIXTURES[key]);
      status = `Rendered ${key} in ${String(round1(performance.now() - t0))} ms`;
    } catch (err) {
      status = `Error: ${String(err)}`;
    } finally {
      busy = false;
    }
  }

  function stat(values: number[]): Stat {
    return {
      p50: round1(percentile(values, 50)),
      p95: round1(percentile(values, 95)),
      max: round1(Math.max(...values)),
    };
  }

  // performance.memory is Chromium only and not in lib.dom.
  interface PerfMemory {
    usedJSHeapSize: number;
    jsHeapSizeLimit: number;
  }

  async function benchmark(): Promise<void> {
    busy = true;
    results = undefined;
    // A separate client, so the cold start is a fresh worker even after the page has rendered.
    const client = createNotationClient();
    try {
      status = "Cold init: starting a fresh worker...";
      const t0 = performance.now();
      await client.preload();
      const coldInitMs = performance.now() - t0;

      status = "First render...";
      const keys = FIXTURES.map((f) => f.key);
      const first = keys[0] ?? "bassF3GMajor";
      const t1 = performance.now();
      await client.render(SCORE_FIXTURES[first], { widthPx: WIDTH_PX });
      const firstRenderMs = performance.now() - t1;

      status = `Warm renders (${String(WARM_RENDERS)})...`;
      const roundTrip: number[] = [];
      for (let i = 0; i < WARM_RENDERS; i++) {
        const key = keys[i % keys.length] ?? "bassF3GMajor";
        const t = performance.now();
        await client.render(SCORE_FIXTURES[key], { widthPx: WIDTH_PX });
        roundTrip.push(performance.now() - t);
      }

      const mem = (performance as unknown as { memory?: PerfMemory }).memory;
      results = {
        userAgent: navigator.userAgent,
        coldInitMs: round1(coldInitMs),
        firstRenderMs: round1(firstRenderMs),
        warmRenders: WARM_RENDERS,
        warmRoundTripMs: stat(roundTrip),
        jsHeapUsedBytes: mem?.usedJSHeapSize ?? null,
        jsHeapLimitBytes: mem?.jsHeapSizeLimit ?? null,
      };
      status = "Benchmark done.";
    } catch (err) {
      status = `Error: ${String(err)}`;
    } finally {
      client.dispose();
      busy = false;
    }
  }

  async function copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(json);
      status = "Copied.";
    } catch {
      status = "Copy failed: select the JSON below and copy it by hand.";
    }
  }

  const mb = (bytes: number | null): string =>
    bytes === null ? "n/a" : `${(bytes / 1048576).toFixed(1)} MB`;

  onMount(() => {
    void show("bassF3GMajor");
  });
  onDestroy(() => {
    port.hide();
  });
</script>

<h1>Notation</h1>
<p>
  The notation runtime: Verovio in a module worker, drawn by NotationView. The benchmark starts a
  fresh worker and times its cold init, then 50 warm renders. Tap it twice: the second run measures
  init with the files cached.
</p>

<div class="row">
  {#each FIXTURES as fixture (fixture.key)}
    <button type="button" disabled={busy} onclick={() => void show(fixture.key)}>
      {fixture.label}
    </button>
  {/each}
</div>
<div class="row">
  <button type="button" data-testid="benchmark" disabled={busy} onclick={() => void benchmark()}>
    Benchmark
  </button>
</div>

<p role="status" data-testid="status">{status}</p>

<div class="score" data-testid="score">
  <NotationView {port} label="Sample score" />
</div>

{#if results}
  <h2>Results</h2>
  <table data-testid="bench-table">
    <tbody>
      <tr
        ><th scope="row">Cold init (worker create to ready)</th><td>{results.coldInitMs} ms</td></tr
      >
      <tr><th scope="row">First render</th><td>{results.firstRenderMs} ms</td></tr>
      <tr>
        <th scope="row">Warm round trip p50 / p95 / max ({results.warmRenders} renders)</th>
        <td>
          {results.warmRoundTripMs.p50} / {results.warmRoundTripMs.p95} / {results.warmRoundTripMs
            .max} ms
        </td>
      </tr>
      <tr><th scope="row">Page JS heap used</th><td>{mb(results.jsHeapUsedBytes)}</td></tr>
    </tbody>
  </table>
  <div class="row">
    <button type="button" onclick={() => void copy()}>Copy JSON</button>
  </div>
  <pre data-testid="bench-json">{json}</pre>
{/if}

<style>
  .row {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2, 0.5rem);
    margin-block: var(--space-2, 0.5rem);
  }
  button {
    min-height: 44px;
    padding: 0 var(--space-4, 1rem);
  }
  .score {
    background: var(--color-surface);
    padding: var(--space-3);
    min-height: 4rem;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
  }
  table {
    border-collapse: collapse;
    width: 100%;
  }
  th,
  td {
    text-align: left;
    padding: 0.25rem 0.5rem;
    border-bottom: 1px solid currentColor;
  }
  pre {
    overflow-x: auto;
    font-size: 0.8rem;
  }
</style>
