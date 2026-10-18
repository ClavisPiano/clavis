import { z } from "zod";
import type { JsonObject } from "../json.js";
import type { ExpectedResponse } from "./expected.js";
import { itemId } from "./ids.js";
import type { ItemParams } from "./types.js";

/*
 * Error micro-drills (spec 5.4, R27, T5.8). A failed `chordLine` or `performance` attempt spawns at
 * most one drill item: the first chord change that went wrong, as an item of the same node with
 * params `drill=<from>-<to>` (plus the key family of the source item). The drill plays the two
 * chords twice, from-to-from-to, in the same pattern as its node. Drill items are never listed as
 * new (`listItems` never returns them) but the node's generator accepts them, and the session logs
 * the spawn as `drill.spawned`, which gives the drill a card that is due at once.
 *
 * Choices beyond the spec:
 * - "First" is the lowest chord index any positioned error names. Errors without a chord or a bar
 *   (a timeout, a skip, `chord.extra`) are ignored, so an attempt with only those spawns nothing.
 * - The change is the one into the erring chord. When the first chord itself is wrong there is no
 *   change into it, so the drill is the change out of it (first to second).
 * - A drill item never spawns another drill: it already is the drill.
 */

/** Drill cards one node keeps at most (R27). A new drill past this retires the oldest. */
export const MAX_DRILLS_PER_NODE = 3;

/** The item param that marks a drill and names its chord change. */
export const DRILL_PARAM = "drill";

/** `<from>-<to>`: two different chord numerals. */
export const DrillParam = z
  .string()
  .regex(/^[A-Za-z]+-[A-Za-z]+$/, "must be <from>-<to>")
  .refine((d) => {
    const [from, to] = d.split("-");
    return from !== to;
  }, "a drill needs two different chords");

/** Item params of a drill: the change and the key family. */
export const DrillItemParams = z.strictObject({
  fam: z.enum(["A", "B", "C"]),
  drill: DrillParam,
});

/** The progression a drill plays: from, to, from, to. Throws on a malformed drill. */
export function drillProgression(drill: string): string[] {
  const [from, to] = DrillParam.parse(drill).split("-") as [string, string];
  return [from, to, from, to];
}

/** True when an item id names a drill item (it carries a `drill=` param). */
export function isDrillItemId(id: string): boolean {
  return id
    .split("|")
    .slice(1)
    .some((p) => p.startsWith(`${DRILL_PARAM}=`));
}

/**
 * The params of a drill item id (`node|drill=IV-V|fam=A`), or undefined when the id is not a
 * well-formed drill of `nodeId`. Drill params are plain strings, so they read back exactly.
 */
export function drillParamsOf(nodeId: string, id: string): ItemParams | undefined {
  const [head, ...parts] = id.split("|");
  if (head !== nodeId) return undefined;
  const raw: Record<string, string> = {};
  for (const p of parts) {
    const eq = p.indexOf("=");
    if (eq <= 0) return undefined;
    raw[p.slice(0, eq)] = p.slice(eq + 1);
  }
  const parsed = DrillItemParams.safeParse(raw);
  if (!parsed.success) return undefined;
  // Round trip, so only canonical ids count.
  return itemId(nodeId, parsed.data) === id ? parsed.data : undefined;
}

/** An attempt error as `attempt.completed` logs it (kept local: events import this module). */
interface AttemptError {
  code: string;
  detail?: JsonObject | undefined;
}

export interface SpawnedDrill {
  itemId: string;
  params: ItemParams;
  from: string;
  to: string;
}

function detailNumber(e: AttemptError, key: string): number | undefined {
  const v = e.detail?.[key];
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

/** The chord index each positioned error names, for the item's target. */
function erringChords(
  expected: ExpectedResponse,
  chordCount: number,
  errors: readonly AttemptError[],
): number[] {
  const play = expected.play;
  if (play?.kind === "chordLine") {
    return errors.flatMap((e) => {
      const i = detailNumber(e, "index");
      return e.code.startsWith("chord.") && i !== undefined ? [i] : [];
    });
  }
  if (play?.kind === "performance") {
    // Chords share the piece evenly (one per bar in `coordTask`), so a note's onset gives its chord.
    const totalBeats = Math.max(0, ...play.notes.map((n) => n.onsetBeats + n.durationBeats));
    if (totalBeats <= 0) return [];
    const beatsPerChord = totalBeats / chordCount;
    return errors.flatMap((e) => {
      const measure = detailNumber(e, "measure");
      const beat = detailNumber(e, "beat");
      if (!e.code.startsWith("note.") || measure === undefined || beat === undefined) return [];
      const onset = (measure - 1) * play.beatsPerBar + (beat - 1);
      return [Math.floor(onset / beatsPerChord)];
    });
  }
  return [];
}

/**
 * The drill a failed attempt spawns, or undefined. Pure: the session decides whether to log it.
 * `params` are the attempted item's params; the progression comes from `prog` (a drill item has
 * `drill` instead and spawns nothing).
 */
export function spawnDrill(input: {
  nodeId: string;
  params: ItemParams;
  expected: ExpectedResponse;
  correct: boolean;
  errors: readonly AttemptError[];
}): SpawnedDrill | undefined {
  if (input.correct || DRILL_PARAM in input.params) return undefined;
  const kind = input.expected.play?.kind;
  if (kind !== "chordLine" && kind !== "performance") return undefined;
  const prog = input.params.prog;
  if (!Array.isArray(prog) || prog.length < 2 || !prog.every((c) => typeof c === "string")) {
    return undefined;
  }
  const chords = prog;
  const hits = erringChords(input.expected, chords.length, input.errors).filter(
    (i) => Number.isInteger(i) && i >= 0 && i < chords.length,
  );
  if (hits.length === 0) return undefined;
  const first = Math.min(...hits);
  const [a, b] = first === 0 ? [0, 1] : [first - 1, first];
  const from = chords[a];
  const to = chords[b];
  if (from === undefined || to === undefined || from === to) return undefined;
  const fam = input.params.fam;
  if (fam !== "A" && fam !== "B" && fam !== "C") return undefined;
  const params: ItemParams = { fam, drill: `${from}-${to}` };
  return { itemId: itemId(input.nodeId, params), params, from, to };
}
