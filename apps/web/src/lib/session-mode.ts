export type SessionMode = "instrument" | "away";

/** Reads the `mode` query param. Anything other than "away" means instrument mode. */
export function parseSessionMode(searchParams: { get(name: string): string | null }): SessionMode {
  return searchParams.get("mode") === "away" ? "away" : "instrument";
}
