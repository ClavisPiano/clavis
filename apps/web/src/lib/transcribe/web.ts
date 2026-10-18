import { createBasicPitchTranscriber, type BasicPitchTranscriber } from "./client";

/** Basic Pitch wired to the bundled worker. The worker (and tfjs) load on the first take. */
export function createWebTranscriber(): BasicPitchTranscriber {
  return createBasicPitchTranscriber(
    () =>
      new Worker(new URL("./basic-pitch.worker.ts", import.meta.url), {
        type: "module",
        name: "basic-pitch",
      }),
  );
}
