// Notation worker (T3.4). Loads the Verovio toolkit (the WASM is inlined in the module as base64
// and instantiated from memory, so there is no extra network fetch) and renders ScoreSpecs to SVG.
// The page talks to it through `createNotationClient`, which sits behind `NotationRenderer`, so a
// different engine could replace this file without touching the callers.
import createVerovioModule from "verovio/wasm";
import { VerovioToolkit } from "verovio/esm";
import { toMei } from "@clavis/notation";
import type { ScoreSpec } from "@clavis/core";
import type { NotationRequest, NotationResponse } from "./protocol";

// The tsconfig has no WebWorker lib, so describe the bits of the worker scope we use.
interface WorkerScope {
  onmessage: ((event: MessageEvent<NotationRequest>) => void) | null;
  postMessage(message: NotationResponse): void;
}
const scope = globalThis as unknown as WorkerScope;

let toolkit: Promise<VerovioToolkit> | undefined;

function loadToolkit(): Promise<VerovioToolkit> {
  toolkit ??= createVerovioModule().then((mod) => {
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
    return tk;
  });
  return toolkit;
}

function noteIdsOf(score: ScoreSpec): string[] {
  const ids: string[] = [];
  for (const staff of score.staves)
    for (const measure of staff.measures)
      for (const el of measure) if (el.kind === "note") ids.push(el.id);
  return ids;
}

async function handle(msg: NotationRequest): Promise<NotationResponse> {
  const tk = await loadToolkit();
  if (msg.type === "preload") return { id: msg.id, type: "ready" };
  if (!tk.loadData(toMei(msg.score))) throw new Error("Verovio could not load the score");
  return {
    id: msg.id,
    type: "rendered",
    svg: tk.renderToSVG(1),
    noteIds: noteIdsOf(msg.score),
  };
}

scope.onmessage = (event) => {
  const msg = event.data;
  handle(msg).then(
    (res) => {
      scope.postMessage(res);
    },
    (err: unknown) => {
      // A failed engine load must not stick: let the next request try again.
      if (msg.type === "preload") toolkit = undefined;
      scope.postMessage({ id: msg.id, type: "error", message: String(err) });
    },
  );
};
