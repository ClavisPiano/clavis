import { readFileSync } from "node:fs";
import { ContentImportedV1, parseEvent, type ScoreSpec } from "@clavis/core";
import { ImportError, importMusicXml, type ImportErrorCode } from "@clavis/notation";
import { IMPORT_GOLDENS, IMPORT_REJECTS, buildMxl, toMusicXml } from "@clavis/notation/testing";
import { describe, expect, it } from "vitest";
import {
  IMPORT_ERROR_MESSAGES,
  MAX_IMPORT_BYTES,
  PICKUP_MESSAGE,
  buildImportEvent,
  cleanTitle,
  convertFile,
  defaultTitle,
  describeImportFailure,
  importErrorMessage,
  inspectFile,
  isImportName,
  pieceProblemMessage,
  previewScore,
  sniffKind,
} from "./piece-import";

const fixture = (name: string): Uint8Array =>
  new Uint8Array(readFileSync(new URL(`../../e2e/fixtures/${name}`, import.meta.url)));
const text = (s: string): Uint8Array => new TextEncoder().encode(s);

const ALL_CODES: Record<ImportErrorCode, true> = {
  malformed: true,
  "unsupported-format": true,
  "no-parts": true,
  "no-staff": true,
  "unsupported-clef": true,
  "multiple-voices": true,
  tuplets: true,
  "unsupported-meter": true,
  "unsupported-key": true,
  "unsupported-duration": true,
  "unsupported-accidental": true,
  "unsupported-note": true,
};

describe("error message mapping", () => {
  it.each(Object.keys(ALL_CODES) as ImportErrorCode[])("%s has a plain message", (code) => {
    const message = importErrorMessage(code);
    expect(message).toBe(IMPORT_ERROR_MESSAGES[code]);
    expect(message.length).toBeGreaterThan(20);
    expect(message).toMatch(/[.]$/);
    // Plain words, not the code or an em dash.
    expect(message).not.toContain(`${code}.`);
    expect(message).not.toMatch(/unsupported-|no-parts|no-staff/);
    expect(message).not.toContain("—");
  });

  it("covers exactly the importer's codes", () => {
    expect(Object.keys(IMPORT_ERROR_MESSAGES).sort()).toEqual(Object.keys(ALL_CODES).sort());
  });

  it.each<[ImportErrorCode, RegExp]>([
    ["multiple-voices", /more than one voice/],
    ["tuplets", /tuplets/],
    ["unsupported-clef", /treble or bass/],
    ["unsupported-key", /key/],
    ["malformed", /could not be read/],
  ])("%s mentions what is wrong", (code, pattern) => {
    expect(importErrorMessage(code)).toMatch(pattern);
  });

  it("maps a thrown ImportError by code and anything else to the unreadable message", () => {
    expect(describeImportFailure(new ImportError("tuplets", "x"))).toBe(
      IMPORT_ERROR_MESSAGES.tuplets,
    );
    expect(describeImportFailure(new Error("boom"))).toBe(IMPORT_ERROR_MESSAGES.malformed);
    expect(describeImportFailure("nope")).toBe(IMPORT_ERROR_MESSAGES.malformed);
  });

  it("maps the schema's piece rules to plain messages", () => {
    const m = (message: string) => pieceProblemMessage([{ message }]);
    expect(m("measure 1 does not fill the meter (16/64 of 64/64)")).toBe(PICKUP_MESSAGE);
    expect(m("a piece is a single line: one pitch per note")).toMatch(/chords/);
    expect(m("a piece needs a key")).toMatch(/key signature/);
    expect(m("a piece needs a meter")).toMatch(/time signature/);
    expect(m("measure 2 is empty")).toMatch(/empty measure/);
    expect(m("something new")).toBe("This score cannot be used as a piece yet.");
    expect(PICKUP_MESSAGE).toBe(
      "This score has a pickup bar or incomplete measures; that is not supported yet.",
    );
  });
});

describe("reading a file", () => {
  it("accepts the three extensions and sniffs zip content", () => {
    for (const name of ["a.musicxml", "a.XML", "a.mxl"]) expect(isImportName(name)).toBe(true);
    for (const name of ["a.mid", "a.pdf", "musicxml"]) expect(isImportName(name)).toBe(false);
    expect(sniffKind(buildMxl("<a/>"))).toBe("mxl");
    expect(sniffKind(text("<?xml"))).toBe("musicxml");
  });

  it("lists parts, staves and the title", () => {
    const r = inspectFile("little-tune.musicxml", fixture("little-tune.musicxml"));
    expect(r).toMatchObject({ ok: true, kind: "musicxml" });
    if (!r.ok) return;
    expect(r.info.title).toBe("Little Tune");
    expect(r.info.parts).toEqual([{ index: 0, name: "Piano", staves: 1 }]);
    const piano = inspectFile("p.musicxml", fixture("piano-two-staves.musicxml"));
    expect(piano.ok && piano.info.parts[0]?.staves).toBe(2);
  });

  it("refuses a wrong extension, a huge file and garbage with a message", () => {
    expect(inspectFile("a.mid", text("x"))).toMatchObject({ ok: false });
    const huge = inspectFile("a.xml", new Uint8Array(MAX_IMPORT_BYTES + 1));
    expect(huge.ok).toBe(false);
    expect(huge.ok ? "" : huge.message).toContain("too large");
    expect(inspectFile("a.xml", text("not xml at all"))).toEqual({
      ok: false,
      message: IMPORT_ERROR_MESSAGES.malformed,
    });
    expect(inspectFile("a.mxl", new Uint8Array([0x50, 0x4b, 1, 2]))).toEqual({
      ok: false,
      message: IMPORT_ERROR_MESSAGES.malformed,
    });
    expect(inspectFile("a.xml", text("<html/>"))).toEqual({
      ok: false,
      message: IMPORT_ERROR_MESSAGES["unsupported-format"],
    });
  });

  it("starts the title from the score, else from the file name", () => {
    expect(defaultTitle({ title: "Sonata", parts: [] }, "x.xml")).toBe("Sonata");
    expect(defaultTitle({ title: undefined, parts: [] }, "my_little-tune.musicxml")).toBe(
      "my little tune",
    );
    expect(defaultTitle({ title: "x".repeat(300), parts: [] }, "x.xml")).toHaveLength(120);
  });

  it("cleans titles", () => {
    expect(cleanTitle("  A   tune ")).toBe("A tune");
    expect(cleanTitle("   ")).toBeUndefined();
    expect(cleanTitle("x".repeat(121))).toBeUndefined();
  });
});

describe("converting a file", () => {
  it("converts the fixture into phrases and a difficulty", () => {
    const r = convertFile("musicxml", fixture("little-tune.musicxml"), { partIndex: 0, staff: 1 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.candidate.phrases).toEqual([
      { firstMeasure: 1, lastMeasure: 2 },
      { firstMeasure: 3, lastMeasure: 4 },
    ]);
    expect(r.candidate.difficulty).toBeGreaterThanOrEqual(1);
    expect(r.candidate.score.staves[0]?.measures).toHaveLength(4);
    expect(previewScore(r.candidate, 1).staves[0]?.measures).toHaveLength(2);
  });

  it("converts an mxl archive and picks the staff", () => {
    const bytes = buildMxl(new TextDecoder().decode(fixture("piano-two-staves.musicxml")));
    const lower = convertFile("mxl", bytes, { partIndex: 0, staff: 2 });
    expect(lower.ok && lower.candidate.score.staves[0]?.clef).toBe("bass");
    const upper = convertFile("mxl", bytes, { partIndex: 0, staff: 1 });
    expect(upper.ok && upper.candidate.score.staves[0]?.clef).toBe("treble");
    const missing = convertFile("mxl", bytes, { partIndex: 0, staff: 3 });
    expect(missing).toEqual({ ok: false, message: IMPORT_ERROR_MESSAGES["no-staff"] });
    const noPart = convertFile("mxl", bytes, { partIndex: 4, staff: 1 });
    expect(noPart).toEqual({ ok: false, message: IMPORT_ERROR_MESSAGES["no-parts"] });
  });

  it("explains a pickup bar rather than failing", () => {
    const r = convertFile("musicxml", fixture("pickup.musicxml"), { partIndex: 0, staff: 1 });
    expect(r).toEqual({ ok: false, message: PICKUP_MESSAGE });
  });

  it("explains a short last measure and a chord the same plain way", () => {
    const base = IMPORT_GOLDENS[0]?.expected;
    if (base === undefined) throw new Error("no golden");
    // The G major golden ends on a full bar, so cut a note from its last measure.
    const staff = base.staves[0];
    if (staff === undefined) throw new Error("no staff");
    const shortLast: ScoreSpec = {
      ...base,
      staves: [
        {
          ...staff,
          measures: staff.measures.map((m, i, all) => (i === all.length - 1 ? m.slice(1) : m)),
        },
      ],
    };
    const r = convertFile("musicxml", text(toMusicXml(shortLast)), { partIndex: 0, staff: 1 });
    expect(r).toEqual({ ok: false, message: PICKUP_MESSAGE });
  });

  it.each(IMPORT_REJECTS)("maps $name to the importer's message", ({ xml, code }) => {
    const r = convertFile("musicxml", text(xml), { partIndex: 0, staff: 1 });
    expect(r).toEqual({ ok: false, message: IMPORT_ERROR_MESSAGES[code] });
  });

  it("refuses the two voice fixture used by the browser test", () => {
    const r = convertFile("musicxml", fixture("two-voices.musicxml"), { partIndex: 0, staff: 1 });
    expect(r).toEqual({ ok: false, message: IMPORT_ERROR_MESSAGES["multiple-voices"] });
    expect(() => importMusicXml(new TextDecoder().decode(fixture("two-voices.musicxml")))).toThrow(
      ImportError,
    );
  });
});

describe("the import event", () => {
  const ids = {
    eventId: "01JBX00000000000000000C001",
    pieceUlid: "01JBX00000000000000000C002",
  };

  function candidate() {
    const r = convertFile("musicxml", fixture("little-tune.musicxml"), { partIndex: 0, staff: 1 });
    if (!r.ok) throw new Error(r.message);
    return r.candidate;
  }

  it("builds a valid content.imported event with a user piece id", () => {
    const event = buildImportEvent({
      ...ids,
      deviceId: "dev",
      at: 1_760_000_000_000,
      title: "Little Tune",
      kind: "musicxml",
      partIndex: 0,
      staff: 1,
      candidate: candidate(),
    });
    expect(event.pieceId).toBe("piece.user-01jbx00000000000000000c002");
    expect(event.type).toBe("content.imported");
    expect(ContentImportedV1.safeParse(event).success).toBe(true);
    expect(parseEvent(JSON.parse(JSON.stringify(event))).ok).toBe(true);
  });

  it("does not build an event for a bad title", () => {
    expect(() =>
      buildImportEvent({
        ...ids,
        deviceId: "dev",
        at: 1,
        title: "",
        kind: "mxl",
        partIndex: 0,
        staff: 1,
        candidate: candidate(),
      }),
    ).toThrow();
  });
});
