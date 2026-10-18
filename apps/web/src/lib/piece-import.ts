import {
  ContentImportedV1,
  MAX_PUSH_BYTES,
  UserPieceSchema,
  phraseScore,
  userPieceId,
  type ContentImported,
  type Phrase,
  type ScoreSpec,
} from "@clavis/core";
import {
  ImportError,
  estimateDifficulty,
  importMusicXml,
  importMxl,
  inspectMusicXml,
  inspectMxl,
  splitPhrases,
  type ImportErrorCode,
  type ScoreInfo,
} from "@clavis/notation";

/*
 * Importing a MusicXML or MXL file as a personal piece (T7.4, spec 15). Pure helpers for the
 * `/pieces/import` page: read the file, list its parts, convert one staff, check that the result
 * is a valid user piece, explain failures in plain words, and build the `content.imported` event.
 */

/** Files above this size are refused before parsing. A score for one hand is far smaller. */
export const MAX_IMPORT_BYTES = 20 * 1024 * 1024;

/** Title length the event allows. */
export const MAX_TITLE_LENGTH = 120;

/** What the file input accepts. */
export const IMPORT_ACCEPT = ".musicxml,.xml,.mxl";

/** Plain-language text for every typed importer failure. No jargon, no codes. */
export const IMPORT_ERROR_MESSAGES: Record<ImportErrorCode, string> = {
  malformed: "This file could not be read. It may be damaged, or it is not a MusicXML file.",
  "unsupported-format":
    "This is not a MusicXML score. In your notation app, export it as MusicXML (.musicxml or .mxl).",
  "no-parts": "This score has no parts to import.",
  "no-staff": "That staff does not exist in this part.",
  "unsupported-clef": "Only staves with a treble or bass clef are supported.",
  "multiple-voices":
    "This staff has more than one voice at once. Only a single melody line is supported for now.",
  tuplets: "This score uses tuplets, such as triplets, which are not supported yet.",
  "unsupported-meter":
    "This score has a time signature that is not supported yet, such as a changing or mixed meter.",
  "unsupported-key":
    "This score changes key part way through, or is in a mode other than major or minor. That is not supported yet.",
  "unsupported-duration":
    "This score has note lengths that are not supported yet, such as notes shorter than a sixteenth or double dots.",
  "unsupported-accidental":
    "This score has accidentals that are not supported yet, such as quarter tones.",
  "unsupported-note": "This score has grace notes or unpitched notes, which are not supported yet.",
};

export const PICKUP_MESSAGE =
  "This score has a pickup bar or incomplete measures; that is not supported yet.";

/**
 * Largest serialized score and phrases (UTF-8 bytes) an import event may carry: the sync engine's
 * own push cap, so an imported score always fits in a push (the server takes 2 MiB). A bigger one
 * would be skipped by sync and never leave this device.
 */
export const MAX_IMPORT_EVENT_BYTES = MAX_PUSH_BYTES;

const TOO_MANY_NOTES_MESSAGE =
  "This staff has too much music to import as one piece. Try a shorter score or split it first.";
const TOO_BIG_MESSAGE = "This file is too large to import (the limit is 20 MB).";
const NOT_A_SCORE_MESSAGE = "Choose a MusicXML file (.musicxml, .xml or .mxl).";
const GENERIC_PIECE_MESSAGE = "This score cannot be used as a piece yet.";

/** The message for an importer error code. */
export function importErrorMessage(code: ImportErrorCode): string {
  return IMPORT_ERROR_MESSAGES[code];
}

/** The message for anything thrown while reading or converting a file. */
export function describeImportFailure(error: unknown): string {
  if (error instanceof ImportError) return importErrorMessage(error.code);
  return IMPORT_ERROR_MESSAGES.malformed;
}

/**
 * The message for a score the importer converted but that does not make a valid piece. The core
 * schema's issue texts are matched by their stable wording, and anything unexpected falls back to
 * a general sentence, so a new rule never shows raw schema text.
 */
export function pieceProblemMessage(issues: readonly { message: string }[]): string {
  const text = issues.map((i) => i.message).join("\n");
  if (text.includes("does not fill the meter")) return PICKUP_MESSAGE;
  if (text.includes("one pitch per note")) {
    return "This staff has chords. Only a single melody line is supported for now.";
  }
  if (text.includes("needs a key") || text.includes("needs a meter")) {
    return "This score does not give a key signature and a time signature, which Clavis needs.";
  }
  if (text.includes("is empty") || text.includes("phrases")) {
    return "This staff has no music to learn, or an empty measure.";
  }
  return GENERIC_PIECE_MESSAGE;
}

export type ImportKind = "musicxml" | "mxl";

/** A zip archive starts with "PK". Content decides, not the file name, which people rename. */
export function sniffKind(bytes: Uint8Array): ImportKind {
  return bytes[0] === 0x50 && bytes[1] === 0x4b ? "mxl" : "musicxml";
}

/** True for a file name the importer accepts. */
export function isImportName(name: string): boolean {
  return /\.(musicxml|xml|mxl)$/i.test(name);
}

/** The title to start from: the score's own, else the file name without its extension. */
export function defaultTitle(info: ScoreInfo, fileName: string): string {
  const fromFile = fileName
    .replace(/\.(musicxml|xml|mxl)$/i, "")
    .replace(/[_-]+/g, " ")
    .trim();
  return (info.title ?? fromFile).slice(0, MAX_TITLE_LENGTH).trim();
}

const decoder = new TextDecoder("utf-8");

function xmlText(bytes: Uint8Array): string {
  return decoder.decode(bytes);
}

export type InspectResult =
  { ok: true; kind: ImportKind; info: ScoreInfo } | { ok: false; message: string };

/** Read a file's title and parts. Never throws. */
export function inspectFile(name: string, bytes: Uint8Array): InspectResult {
  if (!isImportName(name)) return { ok: false, message: NOT_A_SCORE_MESSAGE };
  if (bytes.length > MAX_IMPORT_BYTES) return { ok: false, message: TOO_BIG_MESSAGE };
  const kind = sniffKind(bytes);
  try {
    const info = kind === "mxl" ? inspectMxl(bytes) : inspectMusicXml(xmlText(bytes));
    return { ok: true, kind, info };
  } catch (e) {
    return { ok: false, message: describeImportFailure(e) };
  }
}

/** A converted score ready to save. */
export interface ImportCandidate {
  score: ScoreSpec;
  phrases: Phrase[];
  difficulty: number;
}

export type ConvertResult =
  { ok: true; candidate: ImportCandidate } | { ok: false; message: string };

/** A placeholder id and title, only to run the user piece rules on a candidate. */
const CHECK_ID = userPieceId("0".repeat(26));

/** Convert one staff of one part and check it makes a valid piece. Never throws. */
export function convertFile(
  kind: ImportKind,
  bytes: Uint8Array,
  options: { partIndex: number; staff: number },
): ConvertResult {
  try {
    const score =
      kind === "mxl" ? importMxl(bytes, options) : importMusicXml(xmlText(bytes), options);
    const phrases = splitPhrases(score);
    const difficulty = estimateDifficulty(score);
    const check = UserPieceSchema.safeParse({
      id: CHECK_ID,
      title: "Imported",
      source: "Imported",
      score,
      phrases,
      requiredNodeIds: [],
      difficulty,
    });
    if (!check.success) return { ok: false, message: pieceProblemMessage(check.error.issues) };
    if (
      new TextEncoder().encode(JSON.stringify({ score, phrases })).length > MAX_IMPORT_EVENT_BYTES
    ) {
      return { ok: false, message: TOO_MANY_NOTES_MESSAGE };
    }
    return { ok: true, candidate: { score, phrases, difficulty } };
  } catch (e) {
    return { ok: false, message: describeImportFailure(e) };
  }
}

/** Phrase `index` (0-based) of a candidate as a score of its own, for the preview. */
export function previewScore(candidate: ImportCandidate, index: number): ScoreSpec {
  return phraseScore(
    {
      id: CHECK_ID,
      title: "Preview",
      source: "Imported",
      score: candidate.score,
      phrases: candidate.phrases,
      requiredNodeIds: [],
      difficulty: candidate.difficulty,
    },
    index,
  );
}

/** A title the event accepts, or undefined when it is empty or too long. */
export function cleanTitle(raw: string): string | undefined {
  const title = raw.replace(/\s+/g, " ").trim();
  return title === "" || title.length > MAX_TITLE_LENGTH ? undefined : title;
}

/**
 * The `content.imported` event for a candidate. `eventId` and `pieceUlid` are two fresh ULIDs: the
 * event's own id, and the one the piece id (and so every phrase's item id) is built from.
 */
export function buildImportEvent(args: {
  eventId: string;
  pieceUlid: string;
  deviceId: string;
  at: number;
  title: string;
  kind: ImportKind;
  partIndex: number;
  staff: number;
  candidate: ImportCandidate;
}): ContentImported {
  return ContentImportedV1.parse({
    id: args.eventId,
    deviceId: args.deviceId,
    at: args.at,
    type: "content.imported",
    v: 1,
    pieceId: userPieceId(args.pieceUlid),
    title: args.title,
    source: args.kind,
    score: args.candidate.score,
    phrases: args.candidate.phrases,
    difficulty: args.candidate.difficulty,
    partIndex: args.partIndex,
    staff: args.staff,
  });
}
