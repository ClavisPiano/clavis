import type { NodeState } from "../graph/schema.js";
import type { Rng } from "../random.js";
import type { NodeRecord } from "../state/types.js";
import { keyFamily, keysInFamilies, type Key, type KeyFamily, type Mode } from "../theory/keys.js";

const FAMILIES: readonly KeyFamily[] = ["A", "B", "C"];
const RANK: Record<NodeState, number> = {
  locked: 0,
  available: 1,
  learning: 2,
  fluent: 3,
  mastered: 4,
};

/**
 * Key families open for a node (R11, R15), in order A, B, C. A is open once the node is
 * learning or beyond, B once A is mastered, C once B is fluent or mastered.
 */
export function openFamilies(record: Pick<NodeRecord, "state" | "byFamily">): KeyFamily[] {
  const by = record.byFamily ?? {};
  const rank = (s: NodeState | undefined): number => (s === undefined ? 0 : RANK[s]);
  const open: KeyFamily[] = [];
  if (rank(record.state) >= RANK.learning) open.push("A");
  if (rank(by.A) >= RANK.mastered) open.push("B");
  if (rank(by.B) >= RANK.fluent) open.push("C");
  return open;
}

/**
 * Pick a key for a family and mode. Uses `preferredKey` when it is in the family and has the
 * mode, otherwise a seeded pick among that family's keys of the mode. With `cMajorFirst` and
 * family A the result is C major (or A minor). Callers pass `cMajorFirst` while
 * `read.bass.landmarks` is below fluent (R15).
 */
export function keyForFamily(
  fam: KeyFamily,
  mode: Mode,
  preferredKey: Key | undefined,
  rng: Rng,
  opts?: { cMajorFirst?: boolean },
): Key {
  if (opts?.cMajorFirst === true && fam === "A") {
    return mode === "major" ? { tonic: "C", mode } : { tonic: "A", mode };
  }
  if (preferredKey?.mode === mode && keyFamily(preferredKey) === fam) {
    return preferredKey;
  }
  const candidates = keysInFamilies([fam]).filter((k) => k.mode === mode);
  return rng.pick(candidates);
}

/** Item param carrying the family (R15): `nodeId|fam=A|pos=F3`. */
export function familyParam(fam: KeyFamily): { fam: KeyFamily } {
  return { fam };
}

/** Read the family from item params, if present and valid. */
export function familyOfParams(params: { readonly fam?: unknown }): KeyFamily | undefined {
  const f = params.fam;
  return FAMILIES.find((x) => x === f);
}
