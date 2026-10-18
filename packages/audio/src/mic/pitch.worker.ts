/**
 * Dedicated worker entry. Receives `init` with the MessagePort that the AudioWorklet posts audio
 * chunks to, runs the pitch pipeline, and posts frames and notes to the main thread.
 *
 * Bundled by Vite through `../web.ts` (`?worker`). Keep this file free of DOM access.
 */
import type { CaptureChunk, WorkerInbound, WorkerOutbound } from "./messages.js";
import { PitchWorkerCore } from "./worker-core.js";

interface WorkerScope {
  postMessage(message: WorkerOutbound): void;
  addEventListener(type: "message", listener: (event: MessageEvent<WorkerInbound>) => void): void;
}

const scope = self as unknown as WorkerScope;
const core = new PitchWorkerCore((message) => {
  scope.postMessage(message);
});
let audioPort: MessagePort | undefined;

scope.addEventListener("message", (event) => {
  const message = event.data;
  switch (message.type) {
    case "init":
      core.configure(message.config);
      audioPort?.close();
      audioPort = message.port;
      audioPort.addEventListener("message", (e: MessageEvent<CaptureChunk>) => {
        core.handleChunk(e.data);
      });
      audioPort.start();
      break;
    case "pause":
      core.pause();
      break;
    case "resume":
      core.resume();
      break;
    case "range":
      core.setExpectedRange(message.range);
      break;
    case "take": {
      const take = core.takeSnapshot();
      scope.postMessage({ type: "take", take });
      break;
    }
    case "stop":
      core.stop();
      audioPort?.close();
      audioPort = undefined;
      break;
  }
});
