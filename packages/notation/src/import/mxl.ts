import type { ScoreSpec } from "@clavis/core";
import { strFromU8, unzipSync } from "fflate";
import { ImportError } from "./errors.js";
import { importMusicXml, type ImportOptions } from "./musicxml.js";
import { childrenNamed, parseXml, child } from "./xml.js";

/*
 * Compressed MusicXML (.mxl): a zip whose `META-INF/container.xml` names the root score file.
 * Only the container and that one file are inflated, and an entry larger than MAX_ENTRY_BYTES is
 * refused, so a hostile archive cannot exhaust memory.
 */

const CONTAINER_PATH = "META-INF/container.xml";
const MAX_ENTRY_BYTES = 64 * 1024 * 1024;

function unzipOne(bytes: Uint8Array, path: string): Uint8Array {
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(bytes, {
      filter: (f) => {
        if (f.name !== path) return false;
        if (f.originalSize > MAX_ENTRY_BYTES) {
          throw new ImportError("malformed", `archive entry ${path} is too large`);
        }
        return true;
      },
    });
  } catch (e) {
    if (e instanceof ImportError) throw e;
    throw new ImportError("malformed", "not a readable zip archive");
  }
  const data = files[path];
  if (data === undefined) throw new ImportError("malformed", `archive has no ${path}`);
  return data;
}

function decode(data: Uint8Array): string {
  return strFromU8(data);
}

/** Path of the root score file inside the archive. */
function rootFilePath(containerXml: string): string {
  const container = parseXml(containerXml);
  const rootfiles = child(container, "rootfiles");
  const list = rootfiles === undefined ? [] : childrenNamed(rootfiles, "rootfile");
  // The first rootfile is the score, unless a later one is marked as MusicXML and the first is not.
  const pick = list.find((r) => (r.attrs["media-type"] ?? "").includes("musicxml")) ?? list[0];
  const path = pick?.attrs["full-path"];
  if (path === undefined || path === "") {
    throw new ImportError("malformed", "container.xml names no rootfile");
  }
  return path;
}

export function importMxl(bytes: Uint8Array, options: ImportOptions = {}): ScoreSpec {
  const container = decode(unzipOne(bytes, CONTAINER_PATH));
  const root = rootFilePath(container);
  return importMusicXml(decode(unzipOne(bytes, root)), options);
}
