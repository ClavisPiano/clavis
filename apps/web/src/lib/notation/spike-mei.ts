// SPIKE DATA for T3.2 only. Hand-written MEI for the four T3.1 score fixtures. Replaced by
// `toMei(score)` from @clavis/notation (T3.3); delete this file when the spike page moves to it.

const HEAD =
  '<?xml version="1.0" encoding="UTF-8"?><mei xmlns="http://www.music-encoding.org/ns/mei" meiversion="5.0"><meiHead><fileDesc><titleStmt><title/></titleStmt><pubStmt/></fileDesc></meiHead><music><body><mdiv><score>';
const TAIL = "</score></mdiv></body></music></mei>";

function doc(scoreDefAttrs: string, staffDef: string, measures: string): string {
  return `${HEAD}<scoreDef ${scoreDefAttrs}><staffGrp><staffDef n="1" ${staffDef}/></staffGrp></scoreDef><section>${measures}</section>${TAIL}`;
}

const BASS = 'lines="5" clef.shape="F" clef.line="4"';

function measure(n: number, layer: string): string {
  return `<measure n="${String(n)}"><staff n="1"><layer n="1">${layer}</layer></staff></measure>`;
}

export const SPIKE_MEI = {
  bassF3GMajor: doc(
    'keysig="1s"',
    BASS,
    measure(1, '<note xml:id="n1" pname="f" oct="3" dur="1" accid.ges="s"/>'),
  ),
  dMinorRaised7th: doc(
    'keysig="1f"',
    BASS,
    measure(1, '<note xml:id="n1" pname="c" oct="3" dur="1" accid="s"/>'),
  ),
  intervalC3G3: doc(
    'keysig="0"',
    BASS,
    measure(
      1,
      '<note xml:id="n1" pname="c" oct="3" dur="2"/><note xml:id="n2" pname="g" oct="3" dur="2"/>',
    ),
  ),
  percussionRhythm: doc(
    'meter.count="4" meter.unit="4"',
    'lines="1" clef.shape="perc"',
    measure(
      1,
      '<note xml:id="n1" pname="b" oct="4" dur="4" dots="1"/><note xml:id="n2" pname="b" oct="4" dur="8"/><note xml:id="n3" pname="b" oct="4" dur="4"/><note xml:id="n4" pname="b" oct="4" dur="4" tie="i"/>',
    ) + measure(2, '<note xml:id="n5" pname="b" oct="4" dur="2" tie="t"/><rest dur="2"/>'),
  ),
} as const;

export type SpikeFixtureKey = keyof typeof SPIKE_MEI;

export const SPIKE_NOTE_IDS: Record<SpikeFixtureKey, readonly string[]> = {
  bassF3GMajor: ["n1"],
  dMinorRaised7th: ["n1"],
  intervalC3G3: ["n1", "n2"],
  percussionRhythm: ["n1", "n2", "n3", "n4", "n5"],
};
