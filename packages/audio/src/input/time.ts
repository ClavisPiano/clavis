/** `AudioContext.getOutputTimestamp()` result. Both fields are optional in the DOM typings. */
export interface OutputTimestampLike {
  /** AudioContext time in seconds. */
  contextTime?: number | undefined;
  /** `performance.now()` clock in ms, the same clock as DOM `event.timeStamp`. */
  performanceTime?: number | undefined;
}

export interface TimeSources {
  /** `context.getOutputTimestamp()`, if the browser has it. */
  outputTimestamp?: OutputTimestampLike | undefined;
  /** `context.currentTime * 1000`. */
  contextNowMs: number;
  /** `performance.now()`, used only by the fallback. */
  performanceNowMs?: number | undefined;
}

/**
 * Convert a DOM `event.timeStamp` (performance.now clock, ms) to the AudioContext clock in ms.
 *
 * Preferred: anchor on `getOutputTimestamp()`, which pairs a context time with a performance time,
 * so `ctxMs = contextTime * 1000 + (eventTimeStamp - performanceTime)`. Fallback when that pair is
 * missing, zero (not yet running) or non-finite: take the context clock now and subtract how long
 * ago the event happened (`performanceNowMs - eventTimeStamp`) when known. With neither, the event
 * is assumed to be happening now. The result is never negative.
 */
export function eventTimeToContextMs(eventTimeStamp: number, src: TimeSources): number {
  const ts = src.outputTimestamp;
  const ct = ts?.contextTime;
  const pt = ts?.performanceTime;
  if (
    ct !== undefined &&
    pt !== undefined &&
    Number.isFinite(ct) &&
    Number.isFinite(pt) &&
    pt > 0 &&
    Number.isFinite(eventTimeStamp)
  ) {
    return Math.max(0, ct * 1000 + (eventTimeStamp - pt));
  }
  const age =
    src.performanceNowMs !== undefined && Number.isFinite(eventTimeStamp)
      ? Math.max(0, src.performanceNowMs - eventTimeStamp)
      : 0;
  return Math.max(0, src.contextNowMs - age);
}
