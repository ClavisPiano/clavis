/* global AudioWorkletProcessor, currentTime, registerProcessor */
// Dev-only AudioWorklet for the /dev/audio spike. Posts one heartbeat per second of context time.
// It outputs silence; the page connects it through a zero-gain node so the graph pulls it.
class HeartbeatProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.count = 0;
    this.next = 0;
  }

  process() {
    if (currentTime >= this.next) {
      this.count += 1;
      this.next = currentTime + 1;
      this.port.postMessage({ count: this.count, contextTime: currentTime });
    }
    return true;
  }
}

registerProcessor("heartbeat", HeartbeatProcessor);
