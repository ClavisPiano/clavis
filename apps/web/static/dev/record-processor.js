/* global AudioWorkletProcessor, currentFrame, registerProcessor */
// Capture worklet for /dev/record. A static file because the CSP's script-src
// does not allow blob: URLs, which worklet modules are subject to.
registerProcessor(
  "rec",
  class extends AudioWorkletProcessor {
    process(inputs) {
      const ch = inputs[0] && inputs[0][0];
      if (ch) this.port.postMessage({ frame: currentFrame, samples: ch.slice() });
      return true;
    }
  },
);
