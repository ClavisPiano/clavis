import { describe, expect, it } from "vitest";
import { ImportError } from "./errors.js";
import { inspectMusicXml, inspectMxl } from "./inspect.js";
import { IMPORT_GOLDENS, buildMxl } from "./testing.js";

const codeOf = (fn: () => unknown): string | undefined => {
  try {
    fn();
  } catch (e) {
    return e instanceof ImportError ? e.code : "other";
  }
  return undefined;
};

describe("inspectMusicXml", () => {
  const piano = IMPORT_GOLDENS[1];
  const single = IMPORT_GOLDENS[0];
  if (piano === undefined || single === undefined) throw new Error("no golden");

  it("lists the part and its staves", () => {
    expect(inspectMusicXml(piano.xml)).toEqual({
      title: undefined,
      parts: [{ index: 0, name: "Piano", staves: 2 }],
    });
    expect(inspectMusicXml(single.xml).parts).toEqual([{ index: 0, name: "Piano", staves: 1 }]);
  });

  it("reads the work title, then the movement title, and names unnamed parts", () => {
    const xml = (head: string) =>
      `<score-partwise>${head}<part-list><score-part id="P1"/><score-part id="P2"><part-name>Flute</part-name></score-part></part-list><part id="P1"><measure number="1"/></part><part id="P2"><measure number="1"/></part></score-partwise>`;
    const both = inspectMusicXml(
      xml("<work><work-title> Sonata </work-title></work><movement-title>Allegro</movement-title>"),
    );
    expect(both.title).toBe("Sonata");
    expect(both.parts.map((p) => p.name)).toEqual(["Part 1", "Flute"]);
    expect(inspectMusicXml(xml("<movement-title>Allegro</movement-title>")).title).toBe("Allegro");
    expect(inspectMusicXml(xml("<work><work-title/></work>")).title).toBeUndefined();
  });

  it("reads an mxl archive and raises typed errors", () => {
    expect(inspectMxl(buildMxl(piano.xml)).parts[0]?.staves).toBe(2);
    expect(codeOf(() => inspectMusicXml("<score-timewise/>"))).toBe("unsupported-format");
    expect(codeOf(() => inspectMusicXml("<html/>"))).toBe("unsupported-format");
    expect(codeOf(() => inspectMusicXml("<score-partwise/>"))).toBe("no-parts");
    expect(codeOf(() => inspectMusicXml("<score-partwise>"))).toBe("malformed");
    expect(codeOf(() => inspectMxl(new Uint8Array([1, 2, 3])))).toBe("malformed");
  });
});
