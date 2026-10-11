import type { LearningEvent } from "@clavis/core";

/**
 * Sessions this device started and never ended. A reload or a killed tab leaves one behind; the
 * next session closes it as abandoned before it starts.
 */
export function findOpenSessions(events: readonly LearningEvent[], deviceId: string): string[] {
  const open = new Set<string>();
  for (const e of events) {
    if (e.type === "session.started" && e.deviceId === deviceId) open.add(e.sessionId);
    else if (e.type === "session.ended") open.delete(e.sessionId);
  }
  return [...open];
}
