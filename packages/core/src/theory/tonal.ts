// The only module in core that imports tonal. Everything else uses this typed surface.
import { majorKey, minorKey } from "@tonaljs/key";
import { get, transpose } from "@tonaljs/note";

/** Pitch class chroma 0..11 (C = 0) of a spelled pitch class name, or null if invalid. */
export function chromaOf(name: string): number | null {
  const n = get(name);
  return n.empty || n.oct !== undefined ? null : n.chroma;
}

/** Transpose a spelled pitch class by an interval name such as "3m" or "-3m". */
export function transposeName(name: string, interval: string): string {
  return transpose(name, interval);
}

/** Signed key signature (sharps positive, flats negative) for a major tonic. */
export function majorSignature(tonic: string): number {
  return majorKey(tonic).alteration;
}

/** Signed key signature (sharps positive, flats negative) for a minor tonic. */
export function minorSignature(tonic: string): number {
  return minorKey(tonic).alteration;
}
