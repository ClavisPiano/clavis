// Pure helpers for the service worker's caching split (T3.4), kept out of the worker entry so they
// can be unit tested.

/**
 * Notation build outputs: the Verovio worker chunk (about 8 MB, with the WASM inlined as base64)
 * and any separate .wasm file. They stay out of the versioned precache, which would make every
 * install and update download them, and are cached under the asset cache instead.
 */
const NOTATION_ASSET = /verovio|\.wasm$/i;

/** Is this manifest path (or URL) a notation asset? */
export function isNotationAsset(path: string): boolean {
  return NOTATION_ASSET.test(path);
}

/**
 * Transcription build outputs and model files (T8.19): the Basic Pitch worker (TensorFlow.js) and
 * the model in `static/models/basic-pitch/`. Needed only for chords on the microphone, which is
 * opt-in, so they are neither precached nor warmed: the first take fetches them and the asset
 * cache keeps them for offline use after that.
 */
const TRANSCRIPTION_ASSET = /basic-pitch/i;

/** Is this manifest path (or URL) a transcription asset? */
export function isTranscriptionAsset(path: string): boolean {
  return TRANSCRIPTION_ASSET.test(path);
}

/**
 * Splits manifest paths into the versioned precache list, the notation assets (cached at runtime
 * and warmed after the first online load) and the transcription assets (cached at runtime only).
 */
export function splitPrecache(paths: readonly string[]): {
  precache: string[];
  notation: string[];
  transcription: string[];
} {
  const precache: string[] = [];
  const notation: string[] = [];
  const transcription: string[] = [];
  for (const path of paths) {
    if (isNotationAsset(path)) notation.push(path);
    else if (isTranscriptionAsset(path)) transcription.push(path);
    else precache.push(path);
  }
  return { precache, notation, transcription };
}

/** Message the app posts to the worker after the first online load to fill the asset cache. */
export const WARM_NOTATION_MESSAGE = "WARM_NOTATION";

/**
 * Shared chunks that Rolldown splits out of a worker bundle (`_app/immutable/workers/chunks/`)
 * are not listed in the SvelteKit manifest, yet the notation worker cannot start without them.
 */
export function isWorkerChunk(path: string): boolean {
  return path.includes("/_app/immutable/workers/chunks/");
}

/**
 * Absolute URLs of the files a built ES module imports by a relative specifier (`from"./x.js"`,
 * `import"./x.js"`, `import("./x.js")`). Used to warm a worker chunk's dependencies, which the
 * manifest does not list. Minified output is assumed; non-relative specifiers are ignored.
 */
export function relativeImports(source: string, moduleUrl: string): string[] {
  const urls = new Set<string>();
  const pattern = /(?:\bfrom|\bimport)\s*\(?\s*["'`](\.{1,2}\/[^"'`]+)["'`]/g;
  for (const match of source.matchAll(pattern)) {
    const specifier = match[1];
    if (specifier === undefined) continue;
    urls.add(new URL(specifier, moduleUrl).href);
  }
  return [...urls];
}
