/**
 * Device meta: chords with the microphone (T8.19, R31). Off until the learner turns it on in
 * Settings, because it is new, downloads a model on first use and is less sure than MIDI. Device
 * local like the MIDI input choice: another device has its own microphone and its own cache.
 */
export const MIC_CHORDS_META_KEY = "micChords";

export function parseMicChords(raw: unknown): boolean {
  return raw === true;
}

/**
 * Chords (HANDS) can be offered when the input hears several notes at once: a MIDI keyboard
 * always, the mic only when the learner has turned this on. Away mode and the on-screen keys never.
 */
export function canPlayChords(inputKind: string, micChords: boolean): boolean {
  return inputKind === "midi" || (inputKind === "mic" && micChords);
}
