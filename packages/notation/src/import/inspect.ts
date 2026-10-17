import { ImportError } from "./errors.js";
import { mxlScoreXml } from "./mxl.js";
import { child, childText, childrenNamed, parseXml } from "./xml.js";

/*
 * What a score file holds, before choosing what to import (T7.4): its title, its parts and how many
 * staves each has. Only the structure is read, so a score the importer would later refuse (two
 * voices, tuplets) still lists its parts and the UI can show the importer's own error.
 */

export interface ScorePartInfo {
  /** Counted from 0, the `partIndex` of `ImportOptions`. */
  index: number;
  /** The part's name, or "Part N" when the file gives none. */
  name: string;
  /** Staves of the part, from its first `<staves>` (1 when absent). */
  staves: number;
}

export interface ScoreInfo {
  /** `<work-title>`, else `<movement-title>`, else undefined. */
  title: string | undefined;
  parts: ScorePartInfo[];
}

function nonEmpty(text: string | undefined): string | undefined {
  return text === undefined || text === "" ? undefined : text;
}

export function inspectMusicXml(xml: string): ScoreInfo {
  const root = parseXml(xml);
  if (root.name === "score-timewise") {
    throw new ImportError("unsupported-format", "timewise MusicXML is not supported");
  }
  if (root.name !== "score-partwise") {
    throw new ImportError("unsupported-format", `root element <${root.name}> is not MusicXML`);
  }
  const work = child(root, "work");
  const title =
    nonEmpty(work === undefined ? undefined : childText(work, "work-title")) ??
    nonEmpty(childText(root, "movement-title"));

  const names = new Map<string, string>();
  const list = child(root, "part-list");
  for (const sp of list === undefined ? [] : childrenNamed(list, "score-part")) {
    const name = nonEmpty(childText(sp, "part-name"));
    const id = sp.attrs.id;
    if (id !== undefined && name !== undefined) names.set(id, name);
  }

  const parts = childrenNamed(root, "part").map((part, index): ScorePartInfo => {
    let staves = 1;
    for (const measure of childrenNamed(part, "measure")) {
      const text = childrenNamed(measure, "attributes")
        .map((a) => childText(a, "staves"))
        .find((t) => t !== undefined);
      if (text !== undefined) {
        const n = Number(text);
        if (Number.isInteger(n) && n >= 1) staves = n;
        break;
      }
    }
    return { index, name: names.get(part.attrs.id ?? "") ?? `Part ${String(index + 1)}`, staves };
  });
  if (parts.length === 0) throw new ImportError("no-parts", "the score has no parts");
  return { title, parts };
}

export function inspectMxl(bytes: Uint8Array): ScoreInfo {
  return inspectMusicXml(mxlScoreXml(bytes));
}
