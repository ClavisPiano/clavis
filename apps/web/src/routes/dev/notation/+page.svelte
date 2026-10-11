<script lang="ts">
  import { onDestroy } from "svelte";
  import { SvelteMap } from "svelte/reactivity";
  import { percentile, round1 } from "../../../lib/notation/bench-stats";
  import { SPIKE_MEI, type SpikeFixtureKey } from "../../../lib/notation/spike-mei";
  import type { SpikeRequest, SpikeResponse } from "../../../lib/notation/verovio.worker";

  // T3.2 spike page. Renders the T3.1 fixtures through a Verovio module worker and benchmarks it.
  // The MEI is hand-written spike data (spike-mei.ts) until T3.3 provides toMei(score).

  type Ready = Extract<SpikeResponse, { type: "ready" }>;
  type Rendered = Extract<SpikeResponse, { type: "rendered" }>;

  interface Stat {
    p50: number;
    p95: number;
    max: number;
  }
  interface BenchResult {
    userAgent: string;
    verovioVersion: string;
    coldInitMs: number;
    workerInitMs: number;
    workerModuleMs: number;
    workerToolkitMs: number;
    firstRenderMs: number;
    warmRenders: number;
    warmRoundTripMs: Stat;
    warmWorkerMs: Stat;
    wasmHeapBytes: number | null;
    jsHeapUsedBytes: number | null;
    jsHeapLimitBytes: number | null;
  }

  const FIXTURES: readonly { key: SpikeFixtureKey; label: string }[] = [
    { key: "bassF3GMajor", label: "Bass F3, G major" },
    { key: "dMinorRaised7th", label: "D minor raised 7th" },
    { key: "intervalC3G3", label: "Interval C3-G3" },
    { key: "percussionRhythm", label: "Percussion rhythm" },
  ];
  const WARM_RENDERS = 50;
  const WIDTH_PX = 600;

  let worker: Worker | undefined;
  let nextId = 1;
  const pending = new SvelteMap<
    number,
    { resolve: (r: Rendered) => void; reject: (e: Error) => void }
  >();
  let readyWaiter: { resolve: (r: Ready) => void; reject: (e: Error) => void } | undefined;

  let svg = $state("");
  let status = $state("Worker not started. Render a fixture or run the benchmark.");
  let busy = $state(false);
  let results = $state<BenchResult | undefined>();
  const json = $derived(results ? JSON.stringify(results, null, 2) : "");

  function handle(msg: SpikeResponse): void {
    if (msg.type === "ready") {
      readyWaiter?.resolve(msg);
      readyWaiter = undefined;
    } else if (msg.type === "rendered") {
      pending.get(msg.id)?.resolve(msg);
      pending.delete(msg.id);
    } else if (msg.id !== undefined) {
      pending.get(msg.id)?.reject(new Error(msg.message));
      pending.delete(msg.id);
    } else {
      readyWaiter?.reject(new Error(msg.message));
      readyWaiter = undefined;
    }
  }

  function stopWorker(): void {
    worker?.terminate();
    worker = undefined;
    for (const p of pending.values()) p.reject(new Error("worker stopped"));
    pending.clear();
  }

  /** Creates the worker and resolves when the toolkit is ready. Time is taken by the caller. */
  function startWorker(): Promise<Ready> {
    stopWorker();
    const w = new Worker(new URL("../../../lib/notation/verovio.worker.ts", import.meta.url), {
      type: "module",
    });
    worker = w;
    const ready = new Promise<Ready>((resolve, reject) => {
      readyWaiter = { resolve, reject };
    });
    w.onmessage = (event: MessageEvent<SpikeResponse>) => {
      handle(event.data);
    };
    w.onerror = (event) => {
      const err = new Error(event.message || "worker error");
      readyWaiter?.reject(err);
      readyWaiter = undefined;
    };
    const init: SpikeRequest = { type: "init" };
    w.postMessage(init);
    return ready;
  }

  async function ensureWorker(): Promise<void> {
    if (!worker) {
      status = "Starting worker...";
      await startWorker();
    }
  }

  function renderMei(mei: string): Promise<Rendered> {
    const w = worker;
    if (!w) return Promise.reject(new Error("worker not started"));
    const id = nextId++;
    return new Promise<Rendered>((resolve, reject) => {
      pending.set(id, { resolve, reject });
      const req: SpikeRequest = { type: "render", id, mei, widthPx: WIDTH_PX };
      w.postMessage(req);
    });
  }

  async function show(key: SpikeFixtureKey): Promise<void> {
    busy = true;
    try {
      await ensureWorker();
      const t0 = performance.now();
      const out = await renderMei(SPIKE_MEI[key]);
      svg = out.svg;
      status = `Rendered ${key} in ${String(round1(performance.now() - t0))} ms (worker ${String(round1(out.totalMs))} ms)`;
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
    try {
      status = "Cold init: starting a fresh worker...";
      const t0 = performance.now();
      const ready = await startWorker();
      const coldInitMs = performance.now() - t0;

      status = "First render...";
      const keys = FIXTURES.map((f) => f.key);
      const first = keys[0] ?? "bassF3GMajor";
      const t1 = performance.now();
      const firstOut = await renderMei(SPIKE_MEI[first]);
      const firstRenderMs = performance.now() - t1;
      svg = firstOut.svg;

      status = `Warm renders (${String(WARM_RENDERS)})...`;
      const roundTrip: number[] = [];
      const inWorker: number[] = [];
      for (let i = 0; i < WARM_RENDERS; i++) {
        const key = keys[i % keys.length] ?? "bassF3GMajor";
        const t = performance.now();
        const out = await renderMei(SPIKE_MEI[key]);
        roundTrip.push(performance.now() - t);
        inWorker.push(out.totalMs);
        svg = out.svg;
      }

      const mem = (performance as unknown as { memory?: PerfMemory }).memory;
      results = {
        userAgent: navigator.userAgent,
        verovioVersion: ready.version,
        coldInitMs: round1(coldInitMs),
        workerInitMs: round1(ready.initMs),
        workerModuleMs: round1(ready.moduleMs),
        workerToolkitMs: round1(ready.toolkitMs),
        firstRenderMs: round1(firstRenderMs),
        warmRenders: WARM_RENDERS,
        warmRoundTripMs: stat(roundTrip),
        warmWorkerMs: stat(inWorker),
        wasmHeapBytes: ready.wasmHeapBytes,
        jsHeapUsedBytes: mem?.usedJSHeapSize ?? null,
        jsHeapLimitBytes: mem?.jsHeapSizeLimit ?? null,
      };
      status = "Benchmark done.";
    } catch (err) {
      status = `Error: ${String(err)}`;
    } finally {
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

  onDestroy(stopWorker);
</script>

<h1>Notation spike</h1>
<p>
  Verovio in a module worker. Cold init is the time from creating the worker to the toolkit being
  ready. Tap Benchmark twice: the second run measures init with the files in the HTTP cache.
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

<!-- eslint-disable-next-line svelte/no-at-html-tags -- trusted: SVG produced by our own Verovio worker from our own MEI -->
<div class="score" data-testid="score">{@html svg}</div>

{#if results}
  <h2>Results</h2>
  <table data-testid="bench-table">
    <tbody>
      <tr><th scope="row">Verovio</th><td>{results.verovioVersion}</td></tr>
      <tr
        ><th scope="row">Cold init (worker create to ready)</th><td>{results.coldInitMs} ms</td></tr
      >
      <tr>
        <th scope="row">Worker init (module / toolkit)</th>
        <td>
          {results.workerInitMs} ms ({results.workerModuleMs} / {results.workerToolkitMs})
        </td>
      </tr>
      <tr><th scope="row">First render</th><td>{results.firstRenderMs} ms</td></tr>
      <tr>
        <th scope="row">Warm round trip p50 / p95 / max ({results.warmRenders} renders)</th>
        <td>
          {results.warmRoundTripMs.p50} / {results.warmRoundTripMs.p95} / {results.warmRoundTripMs
            .max} ms
        </td>
      </tr>
      <tr>
        <th scope="row">Warm in-worker p50 / p95 / max</th>
        <td>
          {results.warmWorkerMs.p50} / {results.warmWorkerMs.p95} / {results.warmWorkerMs.max} ms
        </td>
      </tr>
      <tr><th scope="row">Worker WASM heap</th><td>{mb(results.wasmHeapBytes)}</td></tr>
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
    background: #fff;
    color: #000;
    padding: 0.5rem;
    min-height: 4rem;
    overflow-x: auto;
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
