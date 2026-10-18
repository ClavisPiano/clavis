/**
 * Dedicated worker for Basic Pitch (T8.19). Loads the TensorFlow.js model on the first request and
 * keeps it for the rest of the page's life. Keep this file free of DOM access.
 */
import "./worker-env";
import * as tf from "@tensorflow/tfjs";
import { transcribeSamples } from "./basic-pitch";
import type { WorkerReply, WorkerRequest } from "./messages";

interface WorkerScope {
  postMessage(message: WorkerReply): void;
  addEventListener(type: "message", listener: (event: MessageEvent<WorkerRequest>) => void): void;
}

const scope = self as unknown as WorkerScope;
let model: Promise<tf.GraphModel> | undefined;

function loadModel(url: string): Promise<tf.GraphModel> {
  model ??= tf.loadGraphModel(url).catch((error: unknown) => {
    model = undefined;
    throw error;
  });
  return model;
}

scope.addEventListener("message", (event) => {
  const { id, samples, sampleRate, modelUrl } = event.data;
  void (async () => {
    try {
      const notes = await transcribeSamples(await loadModel(modelUrl), samples, sampleRate);
      scope.postMessage({ id, ok: true, notes, backend: tf.getBackend() });
    } catch (error) {
      scope.postMessage({
        id,
        ok: false,
        error: error instanceof Error ? error.message : "failed",
      });
    }
  })();
});
