// T3.2 spike worker. Loads the Verovio toolkit (WASM is inlined in the module as base64 and
// instantiated from memory, so there is no extra network fetch) and renders MEI to SVG on request.
// Replaced by the T3.4 notation runtime.
import createVerovioModule from "verovio/wasm";
import { VerovioToolkit } from "verovio/esm";

export type SpikeRequest =
  { type: "init" } | { type: "render"; id: number; mei: string; widthPx: number };

export type SpikeResponse =
  | {
      type: "ready";
      version: string;
      moduleMs: number;
      toolkitMs: number;
      initMs: number;
      wasmHeapBytes: number | null;
    }
  | { type: "rendered"; id: number; svg: string; loadMs: number; renderMs: number; totalMs: number }
  | { type: "error"; id?: number; message: string };

// The tsconfig has no WebWorker lib, so describe the bits of the worker scope we use.
interface WorkerScope {
  onmessage: ((event: MessageEvent<SpikeRequest>) => void) | null;
  postMessage(message: SpikeResponse): void;
}
const scope = globalThis as unknown as WorkerScope;

let toolkit: VerovioToolkit | undefined;

async function init(): Promise<void> {
  const initStart = performance.now();
  const mod = await createVerovioModule();
  const moduleEnd = performance.now();
  const tk = new VerovioToolkit(mod);
  tk.setOptions({
    scale: 40,
    adjustPageHeight: true,
    adjustPageWidth: true,
    breaks: "none",
    svgViewBox: true,
    footer: "none",
    header: "none",
  });
  const initEnd = performance.now();
  toolkit = tk;
  scope.postMessage({
    type: "ready",
    version: tk.getVersion(),
    moduleMs: moduleEnd - initStart,
    toolkitMs: initEnd - moduleEnd,
    initMs: initEnd - initStart,
    wasmHeapBytes: mod.HEAPU8?.length ?? null,
  });
}

function render(id: number, mei: string): void {
  if (!toolkit) throw new Error("toolkit not ready");
  const t0 = performance.now();
  const ok = toolkit.loadData(mei);
  const t1 = performance.now();
  if (!ok) throw new Error("Verovio could not load the MEI");
  const svg = toolkit.renderToSVG(1);
  const t2 = performance.now();
  scope.postMessage({
    type: "rendered",
    id,
    svg,
    loadMs: t1 - t0,
    renderMs: t2 - t1,
    totalMs: t2 - t0,
  });
}

scope.onmessage = (event) => {
  const msg = event.data;
  try {
    if (msg.type === "init") {
      init().catch((err: unknown) => {
        scope.postMessage({ type: "error", message: String(err) });
      });
    } else {
      render(msg.id, msg.mei);
    }
  } catch (err) {
    scope.postMessage({
      type: "error",
      ...(msg.type === "render" ? { id: msg.id } : {}),
      message: String(err),
    });
  }
};
