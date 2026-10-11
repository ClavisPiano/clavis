import { z } from "zod";
import type { SkillNode } from "../graph/schema.js";
import {
  spelledToMidi,
  type ScoreNote,
  type ScoreSpec,
  type SpelledPitch,
} from "../score/schema.js";
import type { Key, KeyFamily, Mode, VoiceRange } from "../theory/keys.js";
import {
  formatStaffPosition,
  parseStaffPosition,
  positionInKey,
  positionsInRange,
  staffPosition,
  stepOffset,
  writtenAccidental,
  type StaffPosition,
} from "../theory/staff.js";
import { degreeLabels, keyToJson, latencyField } from "./build.js";
import { keyForFamily } from "./family.js";
import { itemId } from "./ids.js";
import type { GenerateContext, Generator, ItemInstance, ItemParams } from "./types.js";

/*
 * Bass-staff note reading (R15, R17, R18). One generator serves five nodes. The variant is
 * detected from the node params, in this order (the first match wins):
 *   mode "interval"      -> interval   (read.bass.intervals)
 *   accidentals          -> minor      (read.minor.accidentals)
 *   fullRange            -> skips      (read.bass.skips)
 *   anchors              -> steps      (read.bass.steps)
 *   notes                -> landmarks  (read.bass.landmarks)
 *
 * Item ids follow R15 as far as the shared `itemId` helper allows. It sorts param keys, so the id
 * is `nodeId|fam=A|pos=F3` for note items, `nodeId|fam=A|raise=6` for minor accidentals and
 * `nodeId|dir=up|fam=A|interval=3` for intervals. The key is never in the id.
 *
 * Key contract: the composer computes the key per planned item (including the C-major-first rule)
 * and passes it as `ctx.preferredKey`. `generate` uses it when it is in the item's family and mode
 * (via `keyForFamily`), otherwise it picks a seeded key of that family and mode. The generator
 * therefore never needs `cMajorFirst` itself. Note and interval items are major-mode; minor
 * accidental items are minor-mode.
 */

/** Default bass reading range, C2..E4. */
export const BASS_READ_RANGE: VoiceRange = { low: 36, high: 64 };
/** Landmark notes the interval variant starts from (the same four as read.bass.landmarks). */
export const BASS_LANDMARKS: readonly string[] = ["C2", "F3", "C4", "G2"];
const DEFAULT_LOW = "C2";
const DEFAULT_HIGH = "E4";

export const BASS_NOTE_WINDOW_MS = 6000;
export const BASS_INTERVAL_WINDOW_MS = 10000;
const DIRECTIONS = ["up", "down"] as const;
const FAMILIES: readonly KeyFamily[] = ["A", "B", "C"];

const PosText = z.string().regex(/^[A-G]-?[0-9]+$/);
const LandmarksParams = z.object({ notes: z.array(PosText).min(1) });
const StepsParams = z.object({
  anchors: z.array(PosText).min(1),
  maxOffsetSteps: z.int().min(1).optional(),
});
const SkipsParams = z.object({ fullRange: z.tuple([PosText, PosText]) });
const MinorParams = z.object({ accidentals: z.array(z.enum(["raised6", "raised7"])).min(1) });
const IntervalParams = z.object({
  mode: z.literal("interval"),
  maxIntervalSteps: z.int().min(1).max(6).optional(),
});

interface StaffRange {
  low: StaffPosition;
  high: StaffPosition;
}

type NoteVariant =
  | { kind: "landmarks"; positions: StaffPosition[]; range: StaffRange }
  | { kind: "steps"; positions: StaffPosition[]; range: StaffRange }
  | { kind: "skips"; positions: StaffPosition[]; range: StaffRange }
  | { kind: "minor"; raises: (6 | 7)[]; range: StaffRange };
type Variant = NoteVariant | { kind: "interval"; maxIntervalSteps: number };

function defaultRange(): StaffRange {
  return { low: parseStaffPosition(DEFAULT_LOW), high: parseStaffPosition(DEFAULT_HIGH) };
}

function variantOf(node: SkillNode): Variant {
  const p = node.params;
  const interval = IntervalParams.safeParse(p);
  if (interval.success) {
    return { kind: "interval", maxIntervalSteps: interval.data.maxIntervalSteps ?? 4 };
  }
  const range = defaultRange();
  const minor = MinorParams.safeParse(p);
  if (minor.success) {
    return {
      kind: "minor",
      raises: minor.data.accidentals.map((a) => (a === "raised6" ? 6 : 7)),
      range,
    };
  }
  const skips = SkipsParams.safeParse(p);
  if (skips.success) {
    const full = {
      low: parseStaffPosition(skips.data.fullRange[0]),
      high: parseStaffPosition(skips.data.fullRange[1]),
    };
    return { kind: "skips", positions: positionsInRange(full.low, full.high), range: full };
  }
  const steps = StepsParams.safeParse(p);
  if (steps.success) {
    const anchors = steps.data.anchors.map(parseStaffPosition);
    const anchorIdx = new Set(anchors.map(staffPosition));
    const lo = staffPosition(range.low);
    const hi = staffPosition(range.high);
    // Positions one diatonic step from an anchor, never an anchor itself, inside the range.
    const found = new Map<number, StaffPosition>();
    for (const a of anchors) {
      for (const n of [-1, 1]) {
        const q = stepOffset(a, n);
        const i = staffPosition(q);
        if (!anchorIdx.has(i) && i >= lo && i <= hi) found.set(i, q);
      }
    }
    const positions = [...found.entries()].sort((x, y) => x[0] - y[0]).map(([, q]) => q);
    return { kind: "steps", positions, range };
  }
  const landmarks = LandmarksParams.safeParse(p);
  if (landmarks.success) {
    return { kind: "landmarks", positions: landmarks.data.notes.map(parseStaffPosition), range };
  }
  throw new TypeError(`node ${node.id} has no bassNoteRead params`);
}

const NoteItemParams = z.object({ fam: z.enum(["A", "B", "C"]), pos: PosText });
const MinorItemParams = z.object({
  fam: z.enum(["A", "B", "C"]),
  raise: z.union([z.literal(6), z.literal(7)]),
});

function whole(id: string, pitch: SpelledPitch, key: Key): ScoreNote {
  const accidental = writtenAccidental(pitch, key);
  return {
    kind: "note",
    id,
    pitches: [pitch],
    duration: { value: 1, dots: 0 },
    ...(accidental === undefined ? {} : { accidental }),
  };
}

function bassScore(key: Key, measures: ScoreNote[][]): ScoreSpec {
  return {
    staves: [{ clef: "bass", lines: 5, measures }],
    key: { tonic: key.tonic, mode: key.mode },
    meter: null,
  };
}

function rangeMidi(r: StaffRange): VoiceRange {
  const m = (p: StaffPosition): number =>
    spelledToMidi({ step: p.step, alter: 0, octave: p.octave });
  return { low: m(r.low), high: m(r.high) };
}

/** The node's range widened to include every given midi (a key signature can push a note out). */
function inputRangeFor(base: VoiceRange, ...midis: number[]): VoiceRange {
  return { low: Math.min(base.low, ...midis), high: Math.max(base.high, ...midis) };
}

function pickKey(fam: KeyFamily, mode: Mode, ctx: GenerateContext): Key {
  return keyForFamily(fam, mode, ctx.preferredKey, ctx.rng);
}

function listNoteItems(v: NoteVariant): ItemParams[] {
  const out: ItemParams[] = [];
  if (v.kind === "minor") {
    for (const fam of FAMILIES) for (const raise of v.raises) out.push({ fam, raise });
    return out;
  }
  for (const fam of FAMILIES)
    for (const p of v.positions) out.push({ fam, pos: formatStaffPosition(p) });
  return out;
}

function generateNote(
  node: SkillNode,
  v: NoteVariant,
  params: ItemParams,
  ctx: GenerateContext,
): ItemInstance {
  const { rng } = ctx;
  let fam: KeyFamily;
  let pos: StaffPosition;
  let raise: 6 | 7 | undefined;
  let key: Key;

  if (v.kind === "minor") {
    const ip = MinorItemParams.parse(params);
    if (!v.raises.includes(ip.raise))
      throw new RangeError(`raise ${String(ip.raise)} is not in node ${node.id}`);
    fam = ip.fam;
    raise = ip.raise;
    key = pickKey(fam, "minor", ctx);
    // The register is chosen here: any octave of the raised degree's letter inside the range.
    const tonicLetter = "CDEFGAB".indexOf(key.tonic.charAt(0));
    const letter = "CDEFGAB".charAt((tonicLetter + raise - 1) % 7);
    pos = rng.pick(positionsInRange(v.range.low, v.range.high).filter((p) => p.step === letter));
  } else {
    const ip = NoteItemParams.parse(params);
    pos = parseStaffPosition(ip.pos);
    if (!v.positions.some((p) => staffPosition(p) === staffPosition(pos)))
      throw new RangeError(`position ${ip.pos} is not in node ${node.id}`);
    fam = ip.fam;
    key = pickKey(fam, "major", ctx);
  }

  const { pitch, midi } = positionInKey(pos, key, raise === undefined ? {} : { raise });
  const seed = rng.int(0, 0x7fffffff);
  const posText = formatStaffPosition(pos);
  const idParams: ItemParams = raise === undefined ? { fam, pos: posText } : { fam, raise };
  // Landmarks and minor accidentals use the default C2..E4; steps and skips use the node range.
  const base = v.kind === "skips" ? rangeMidi(v.range) : BASS_READ_RANGE;

  return {
    itemId: itemId(node.id, idParams),
    nodeId: node.id,
    generator: "bassNoteRead",
    params: idParams,
    presentation: {
      key: keyToJson(key),
      pos: posText,
      midi,
      clef: "bass",
      fam,
      seed,
      ...(raise === undefined ? {} : { raise }),
    },
    stimulus: { events: [] },
    display: bassScore(key, [[whole("n1", pitch, key)]]),
    expected: {
      play: { kind: "exactPitch", targetMidi: midi },
      responseWindowMs: BASS_NOTE_WINDOW_MS,
    },
    inputRange: inputRangeFor(base, midi),
    ...latencyField(node),
  };
}

const IntervalItemParams = z.object({
  fam: z.enum(["A", "B", "C"]),
  /** Generic interval number: 2 is a second (one staff step) up to 5 (four steps). */
  interval: z.int().min(2).max(7),
  dir: z.enum(DIRECTIONS),
});

/** Families x intervals (2nd up to maxSteps + 1) x directions: 3 x 4 x 2 = 24 by default. */
function listIntervalItems(maxSteps: number): ItemParams[] {
  const out: ItemParams[] = [];
  for (const fam of FAMILIES)
    for (let interval = 2; interval <= maxSteps + 1; interval++)
      for (const dir of DIRECTIONS) out.push({ fam, interval, dir });
  return out;
}

/**
 * Interval item (R18). The first note is a landmark chosen by seed among those whose second note,
 * placed by staff steps, stays inside C2..E4 on the staff. Display is one measure with two half
 * notes n1, n2 and no meter, like the interval fixture. The expected response is an exact-octave
 * sequence; both notes are written with the key signature applied.
 */
function generateInterval(
  node: SkillNode,
  maxSteps: number,
  params: ItemParams,
  ctx: GenerateContext,
): ItemInstance {
  const { rng } = ctx;
  const ip = IntervalItemParams.parse(params);
  if (ip.interval < 2 || ip.interval > maxSteps + 1)
    throw new RangeError(`interval ${String(ip.interval)} is not in node ${node.id}`);
  const key = pickKey(ip.fam, "major", ctx);
  const range = defaultRange();
  const lo = staffPosition(range.low);
  const hi = staffPosition(range.high);
  const delta = (ip.interval - 1) * (ip.dir === "up" ? 1 : -1);
  const firsts = BASS_LANDMARKS.map(parseStaffPosition).filter((p) => {
    const i = staffPosition(p) + delta;
    return i >= lo && i <= hi;
  });
  const first = rng.pick(firsts);
  const second = stepOffset(first, delta);
  const a = positionInKey(first, key);
  const b = positionInKey(second, key);
  const seed = rng.int(0, 0x7fffffff);
  const idParams: ItemParams = { fam: ip.fam, interval: ip.interval, dir: ip.dir };
  const positions = [formatStaffPosition(first), formatStaffPosition(second)];
  const half = (id: string, pitch: SpelledPitch): ScoreNote => ({
    ...whole(id, pitch, key),
    duration: { value: 2, dots: 0 },
  });

  return {
    itemId: itemId(node.id, idParams),
    nodeId: node.id,
    generator: "bassNoteRead",
    params: idParams,
    presentation: {
      key: keyToJson(key),
      pos: positions,
      midi: [a.midi, b.midi],
      clef: "bass",
      fam: ip.fam,
      interval: ip.interval,
      dir: ip.dir,
      seed,
    },
    stimulus: { events: [] },
    display: bassScore(key, [[half("n1", a.pitch), half("n2", b.pitch)]]),
    expected: {
      play: {
        kind: "sequence",
        midi: [a.midi, b.midi],
        octaveAgnostic: false,
        degreeLabels: degreeLabels(key),
      },
      responseWindowMs: BASS_INTERVAL_WINDOW_MS,
    },
    inputRange: inputRangeFor(BASS_READ_RANGE, a.midi, b.midi),
    ...latencyField(node),
  };
}

/**
 * Read a note (or, for read.bass.intervals, two notes) on the bass staff and play it. No audio
 * preview (R17). Exported but registered by T3.15.
 */
export const bassNoteRead: Generator = {
  id: "bassNoteRead",
  listItems(node: SkillNode): ItemParams[] {
    const v = variantOf(node);
    return v.kind === "interval" ? listIntervalItems(v.maxIntervalSteps) : listNoteItems(v);
  },
  generate(node: SkillNode, params: ItemParams, ctx: GenerateContext): ItemInstance {
    const v = variantOf(node);
    return v.kind === "interval"
      ? generateInterval(node, v.maxIntervalSteps, params, ctx)
      : generateNote(node, v, params, ctx);
  },
};
