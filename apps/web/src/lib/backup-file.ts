import type { EventStore } from "@clavis/core";
import { buildExport, exportFilename } from "./backup";

/** The export document as a JSON file, named for the device and time. Browser only. */
export async function makeBackupFile(args: {
  store: EventStore;
  deviceId: string;
  contentVersion: string;
}): Promise<{ file: File; count: number }> {
  const when = new Date();
  const events = await args.store.list();
  const doc = buildExport({
    events,
    deviceId: args.deviceId,
    contentVersion: args.contentVersion,
    now: when,
  });
  const file = new File([JSON.stringify(doc, null, 2)], exportFilename(args.deviceId, when), {
    type: "application/json",
  });
  return { file, count: events.length };
}

/** Save `file` through a temporary link. Browser only. */
export function saveFile(file: File): void {
  const url = URL.createObjectURL(file);
  const a = document.createElement("a");
  a.href = url;
  a.download = file.name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => {
    URL.revokeObjectURL(url);
  }, 60_000);
}
