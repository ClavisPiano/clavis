/*
 * Typed import failures (T7.3). The importer never drops content silently: anything it cannot
 * represent in a ScoreSpec raises an ImportError with a stable `code` the UI can explain.
 */

export type ImportErrorCode =
  /** Not well-formed XML, a broken archive, or contradictory data (for example a bad <duration>). */
  | "malformed"
  /** The file is not partwise MusicXML. */
  | "unsupported-format"
  /** The requested part does not exist, or the score has no parts. */
  | "no-parts"
  /** The requested staff does not exist in the part. */
  | "no-staff"
  /** Only treble (G2) and bass (F4) clefs are imported. */
  | "unsupported-clef"
  /** The staff has more than one voice. */
  | "multiple-voices"
  /** Tuplets are not representable. */
  | "tuplets"
  /** Additive meters, senza misura or unusual beat types. */
  | "unsupported-meter"
  /** Modes other than major and minor, or a key change mid-piece. */
  | "unsupported-key"
  /** Note values outside whole to 16th, or more than one dot. */
  | "unsupported-duration"
  /** Quarter-tone and other accidentals, or an alteration beyond a double sharp or flat. */
  | "unsupported-accidental"
  /** Grace notes, unpitched notes and the like. */
  | "unsupported-note";

export class ImportError extends Error {
  readonly code: ImportErrorCode;

  constructor(code: ImportErrorCode, message: string) {
    super(message);
    this.name = "ImportError";
    this.code = code;
  }
}
