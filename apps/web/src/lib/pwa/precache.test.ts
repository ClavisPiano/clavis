import { describe, expect, it } from "vitest";
import { isNotationAsset, isWorkerChunk, relativeImports, splitPrecache } from "./precache";

describe("worker dependencies", () => {
  it("finds relative imports and resolves them against the module URL", () => {
    const src =
      'import{t as e}from"../verovio.worker-D4cUxr72.js";var t=1;export default t;' +
      'import"./side.js";const x=await import("./lazy.js");import{a}from"pkg";';
    expect(relativeImports(src, "https://x.test/_app/immutable/workers/chunks/MUt9.js")).toEqual([
      "https://x.test/_app/immutable/workers/verovio.worker-D4cUxr72.js",
      "https://x.test/_app/immutable/workers/chunks/side.js",
      "https://x.test/_app/immutable/workers/chunks/lazy.js",
    ]);
  });

  it("recognises worker chunks", () => {
    expect(isWorkerChunk("https://x.test/_app/immutable/workers/chunks/MUt9.js")).toBe(true);
    expect(isWorkerChunk("https://x.test/_app/immutable/chunks/abc.js")).toBe(false);
  });
});

// Shaped like the SvelteKit manifest paths the worker receives.
const MANIFEST = [
  "_app/immutable/entry/start.AbC123.js",
  "_app/immutable/chunks/index.XyZ789.js",
  "_app/immutable/workers/verovio.worker-Qw12Er.js",
  "_app/immutable/assets/0.Hh77.css",
  "icons/icon-192.png",
  "samples/piano/manifest.json",
  "verovio.wasm",
  "settings/index.html",
];

describe("precache split", () => {
  it("keeps the notation chunk and WASM out of the precache list", () => {
    const { precache, notation } = splitPrecache(MANIFEST);
    expect(precache.some((p) => /verovio|\.wasm$/i.test(p))).toBe(false);
    expect(notation).toEqual(["_app/immutable/workers/verovio.worker-Qw12Er.js", "verovio.wasm"]);
  });

  it("keeps everything else, in order", () => {
    const { precache, notation } = splitPrecache(MANIFEST);
    expect(precache).toEqual([
      "_app/immutable/entry/start.AbC123.js",
      "_app/immutable/chunks/index.XyZ789.js",
      "_app/immutable/assets/0.Hh77.css",
      "icons/icon-192.png",
      "samples/piano/manifest.json",
      "settings/index.html",
    ]);
    expect(precache.length + notation.length).toBe(MANIFEST.length);
  });

  it("recognises notation assets by URL too", () => {
    expect(isNotationAsset("https://x.test/_app/immutable/workers/verovio.worker-a.js")).toBe(true);
    expect(isNotationAsset("https://x.test/_app/immutable/chunks/app.js")).toBe(false);
  });
});
