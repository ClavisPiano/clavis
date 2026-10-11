import type { SkillGraph, SkillNode } from "../graph/schema.js";
import { bassNoteRead } from "../items/bass-note-read.js";
import { itemId } from "../items/ids.js";
import type { ItemParams } from "../items/types.js";
import type { Rng } from "../random.js";
import { STAGE_SPECS, walk, type StageSpec } from "./evaluate.js";
import type {
  PlacementAttempt,
  PlacementItem,
  PlacementPlan,
  PlacementStage,
  PlacementStep,
} from "./types.js";

const EAR_135_DEGREES = [1, 3, 5] as const;
const EAR_DIATONIC_DEGREES = [2, 4, 6, 7] as const;

function shuffled<T>(items: readonly T[], rng: Rng): T[] {
  const a = [...items];
  for (let i = a.length - 1; i > 0; i--) {
    const j = rng.int(0, i);
    [a[i], a[j]] = [a[j] as T, a[i] as T];
  }
  return a;
}

function nodeOf(graph: SkillGraph, spec: StageSpec): SkillNode {
  const node = graph.nodes.find((n) => n.id === spec.nodeId);
  if (!node) throw new RangeError(`placement needs node ${spec.nodeId}`);
  return node;
}

function earItems(
  spec: StageSpec,
  node: SkillNode,
  degrees: readonly number[],
  reps: number,
  rng: Rng,
): PlacementItem[] {
  const listed = Array.isArray(node.params.degrees) ? (node.params.degrees as unknown[]) : [];
  for (const d of degrees) {
    if (!listed.includes(d)) throw new RangeError(`node ${node.id} lacks degree ${String(d)}`);
  }
  const items: PlacementItem[] = [];
  for (let r = 0; r < reps; r++) {
    for (const degree of degrees) {
      const params: ItemParams = { degree };
      items.push({
        section: spec.section,
        stageId: spec.id,
        nodeId: node.id,
        generator: "degreeId",
        itemId: itemId(node.id, params),
        params,
        degree,
      });
    }
  }
  return shuffled(items, rng);
}

/** Family A positions of a bassNoteRead node, as staff position text. */
function familyAPositions(node: SkillNode): string[] {
  return bassNoteRead
    .listItems(node)
    .filter((p) => p.fam === "A")
    .map((p) => (typeof p.pos === "string" ? p.pos : ""));
}

function readItems(
  spec: StageSpec,
  node: SkillNode,
  positions: readonly string[],
): PlacementItem[] {
  return positions.map((pos) => {
    const params: ItemParams = { fam: "A", pos };
    return {
      section: spec.section,
      stageId: spec.id,
      nodeId: node.id,
      generator: "bassNoteRead" as const,
      itemId: itemId(node.id, params),
      params,
      pos,
    };
  });
}

/**
 * The ordered placement plan (R19), C major throughout (T3.16 passes C major as `preferredKey`).
 * Items are shuffled within a stage by the seeded RNG. READ positions come from family A: all 4
 * landmarks, then 3 distinct step positions, then 3 distinct skip positions that are neither
 * landmarks nor step positions, so the three nodes test different notes.
 */
export function placementPlan(graph: SkillGraph, rng: Rng): PlacementPlan {
  const stages: PlacementStage[] = [];
  const used = new Set<string>();
  for (const spec of STAGE_SPECS) {
    const node = nodeOf(graph, spec);
    let items: PlacementItem[];
    if (spec.id === "ear.135") items = earItems(spec, node, EAR_135_DEGREES, 3, rng);
    else if (spec.id === "ear.diatonic") items = earItems(spec, node, EAR_DIATONIC_DEGREES, 2, rng);
    else {
      const pool = familyAPositions(node).filter((p) => !used.has(p));
      if (pool.length < spec.size) throw new RangeError(`node ${node.id} has too few positions`);
      const picked = shuffled(pool, rng).slice(0, spec.size);
      for (const p of picked) used.add(p);
      // Reserve the whole steps pool so no skip item is also a step position.
      if (spec.id === "read.steps") for (const p of pool) used.add(p);
      items = readItems(spec, node, picked);
    }
    stages.push({ id: spec.id, section: spec.section, nodeId: node.id, items });
  }
  return { stages };
}

/**
 * Next thing to present given the attempts so far (in presentation order). Early stops are applied:
 * a section stops after a stage scores available, and the diatonic stage is skipped unless 1-3-5 is
 * mastered. Pure: the same attempts always give the same step.
 */
export function nextPlacementStep(
  plan: PlacementPlan,
  attempts: readonly PlacementAttempt[],
): PlacementStep {
  const p = walk(attempts);
  if (p.current === null) {
    return { kind: "done", completed: p.completed, skippedStageIds: p.skipped.map((s) => s.id) };
  }
  const { spec, answered } = p.current;
  const item = plan.stages.find((s) => s.id === spec.id)?.items[answered];
  if (!item) throw new RangeError(`plan has no item ${String(answered)} for ${spec.id}`);
  return { kind: "item", item, stageStart: answered === 0, completed: p.completed };
}
