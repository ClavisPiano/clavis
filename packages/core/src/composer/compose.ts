import { at } from "../theory/util.js";
import type { GeneratorId, SkillGraph, SkillNode, Strand } from "../graph/schema.js";
import { isNodeEnabled } from "../graph/validate.js";
import { itemId as makeItemId } from "../items/ids.js";
import { GENERATORS } from "../items/registry.js";
import type { ItemParams } from "../items/types.js";
import { learnerDay } from "../learning/day.js";
import { createRng } from "../random.js";
import { newItemAllowance } from "../scheduler/new-items.js";
import { rankDue } from "../scheduler/rank.js";
import type { CardState } from "../scheduler/card.js";
import { medianDurationSec } from "../state/reduce.js";
import type { LearnerState } from "../state/types.js";
import { allocate, DEFAULT_BUDGET_SEC, SCALE_ORIENT_SEC } from "./budget.js";
import { interleave } from "./interleave.js";
import { keyOfDay, NODE_RANK } from "./key.js";
import type { ComposeInput, PlannedItem, SessionPlan } from "./types.js";

interface NodeInfo {
  node: SkillNode;
  /** Implemented generators usable in this mode, in the node's own order (first is the default). */
  gens: GeneratorId[];
  /** Full item universe in `listItems` order. */
  universe: { itemId: string; params: ItemParams }[];
}

interface Candidate {
  itemId: string;
  nodeId: string;
  params: ItemParams;
  isNew: boolean;
  card?: CardState;
}

/** True when the node, or anything on a hard prerequisite chain below it, is a HANDS node. */
export function dependsOnHands(graph: SkillGraph, nodeId: string): boolean {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const seen = new Set<string>();
  const stack = [nodeId];
  while (stack.length > 0) {
    const id = at(stack, stack.length - 1);
    stack.pop();
    if (seen.has(id)) continue;
    seen.add(id);
    const n = byId.get(id);
    if (!n) continue;
    if (n.strand === "HANDS") return true;
    stack.push(...n.prerequisites);
  }
  return false;
}

function usableGenerators(
  node: SkillNode,
  graph: SkillGraph,
  mode: ComposeInput["mode"],
): GeneratorId[] {
  if (!isNodeEnabled(node, graph.generators)) return [];
  return node.itemGenerators.filter((g) => {
    const info = graph.generators.find((i) => i.id === g);
    return (
      info !== undefined &&
      info.implemented &&
      GENERATORS[g] !== undefined &&
      (mode === "instrument" || info.awayEligible)
    );
  });
}

function buildInfo(node: SkillNode, graph: SkillGraph, mode: ComposeInput["mode"]) {
  const gens = usableGenerators(node, graph, mode);
  const first = gens[0];
  if (first === undefined) return undefined;
  const gen = GENERATORS[first];
  if (!gen) return undefined;
  const info: NodeInfo = {
    node,
    gens,
    universe: gen.listItems(node).map((params) => ({
      itemId: makeItemId(node.id, params),
      params,
    })),
  };
  return info;
}

/**
 * Generator for the next item of a node (R14). The default is the node's first usable generator.
 * Degree nodes offer both `degreeSing` and `degreeId`; they alternate (sing first) with each item
 * the node contributes to the plan, so a block mixes production modes.
 */
function chooseGenerator(info: NodeInfo, taken: number): GeneratorId {
  const degree = info.gens.filter((g) => g === "degreeSing" || g === "degreeId");
  if (degree.length === 2) return degree[taken % 2] as GeneratorId;
  return at(info.gens, 0);
}

interface Fill {
  items: PlannedItem[];
  newCount: number;
  usedSec: number;
}

/**
 * Take due items first (most overdue first), then new items up to `allowance`, while they fit in
 * `blockSec`. An item that does not fit is skipped (a cheaper one later may). With `forceFirst`
 * the first candidate is taken even if it overruns, so a block is never empty when it has content.
 */
function fillBlock(opts: {
  blockSec: number;
  due: Candidate[];
  fresh: Candidate[];
  allowance: number;
  forceFirst: boolean;
  infos: Map<string, NodeInfo>;
  taken: Map<string, number>;
  state: LearnerState;
  graph: SkillGraph;
}): Fill {
  const out: Fill = { items: [], newCount: 0, usedSec: 0 };
  for (const c of [...opts.due, ...opts.fresh]) {
    if (c.isNew && out.newCount >= opts.allowance) break;
    const info = opts.infos.get(c.nodeId);
    if (!info) continue;
    const generator = chooseGenerator(info, opts.taken.get(c.nodeId) ?? 0);
    const seed = opts.graph.generators.find((g) => g.id === generator)?.seedDurationSec ?? 10;
    const estimatedSec = medianDurationSec(opts.state, generator, seed);
    const fits = out.usedSec + estimatedSec <= opts.blockSec;
    if (!fits && !(opts.forceFirst && out.items.length === 0)) continue;
    out.items.push({
      itemId: c.itemId,
      nodeId: c.nodeId,
      generator,
      params: c.params,
      isNew: c.isNew,
      estimatedSec,
    });
    out.usedSec += estimatedSec;
    if (c.isNew) out.newCount++;
    opts.taken.set(c.nodeId, (opts.taken.get(c.nodeId) ?? 0) + 1);
  }
  return out;
}

/**
 * Compose a session (spec 6, plan T2.8). Pure and deterministic: the same input, including the
 * seed, always gives the same plan. Choices that are not obvious from the spec:
 *
 * - Cards are per item id and shared by all generators of a node (R14), so "new" means the item id
 *   has no card yet.
 * - Due items come first and may use the whole ear block, as in the spec's fill order; new items
 *   follow, so a deep backlog defers new material.
 * - New items come only from nodes in `learning` state, in graph order, then `listItems` order.
 * - A node is introduced only when no enabled EAR node is learning, the daily allowance is above
 *   zero and at least one of its items fits; the introduction is dropped otherwise.
 * - Read is filled with the same rules but never introduces nodes (READ recognition arrives in M3).
 * - Apply is always null (M5).
 */
export function composeSession(input: ComposeInput): SessionPlan {
  const { state, graph, mode } = input;
  const today = learnerDay(input.now, input.tzOffsetMin);
  const settingsBudget = mode === "away" ? state.settings.awayBudgetSec : state.settings.budgetSec;
  const budgetSec = input.budgetSec ?? settingsBudget ?? DEFAULT_BUDGET_SEC[mode];
  if (!Number.isFinite(budgetSec) || budgetSec <= 0) {
    throw new RangeError(`budgetSec must be positive, got ${String(budgetSec)}`);
  }

  const key = keyOfDay(state, graph, input.now, input.tzOffsetMin);
  const introducedToday = state.daily[today]?.newItems ?? 0;
  const newAllowance = newItemAllowance({ introducedToday });
  const notes: string[] = [];

  const infos = new Map<string, NodeInfo>();
  const strands: Strand[] = mode === "away" ? ["EAR"] : ["EAR", "READ"];
  for (const node of graph.nodes) {
    if (!strands.includes(node.strand)) continue;
    const info = buildInfo(node, graph, mode);
    if (info) infos.set(node.id, info);
  }
  const stateOf = (id: string) => NODE_RANK[state.nodes[id]?.state ?? "locked"];

  // One introduction at most, and only while no EAR node is mid-learning (spec 13).
  let intro: SkillNode | undefined;
  const earLearning = graph.nodes.some(
    (n) =>
      n.strand === "EAR" &&
      isNodeEnabled(n, graph.generators) &&
      state.nodes[n.id]?.state === "learning",
  );
  if (!earLearning) {
    const available = graph.nodes
      .map((node, order) => ({ node, order }))
      .filter(
        ({ node }) =>
          node.strand === "EAR" &&
          infos.has(node.id) &&
          state.nodes[node.id]?.state === "available" &&
          (mode === "instrument" || !dependsOnHands(graph, node.id)),
      )
      .sort(
        (a, b) => a.node.prerequisites.length - b.node.prerequisites.length || a.order - b.order,
      );
    if (available[0]) {
      if (newAllowance > 0) intro = available[0].node;
      else notes.push("daily new-item cap reached: introduction deferred");
    }
  }

  const candidates = (strand: Strand, withIntro: boolean) => {
    const dueAll: (Candidate & { card: CardState })[] = [];
    const fresh: Candidate[] = [];
    for (const [nodeId, info] of infos) {
      if (info.node.strand !== strand) continue;
      const rank = stateOf(nodeId);
      const learning = state.nodes[nodeId]?.state === "learning";
      const introducing = withIntro && intro?.id === nodeId;
      if (rank < NODE_RANK.learning && !introducing) continue;
      for (const u of info.universe) {
        const rec = state.cards[u.itemId];
        if (rec) {
          if (rec.nodeId === nodeId) dueAll.push({ ...u, nodeId, isNew: false, card: rec.card });
        } else if (learning || introducing) {
          fresh.push({ ...u, nodeId, isNew: true });
        }
      }
    }
    const due = rankDue(dueAll, input.now) as Candidate[];
    return { due, fresh };
  };

  const ear = candidates("EAR", true);
  const read = mode === "away" ? { due: [], fresh: [] } : candidates("READ", false);
  const readHasContent = read.due.length > 0 || (read.fresh.length > 0 && newAllowance > 0);

  const alloc = allocate({ budgetSec, mode, readHasContent, applyHasContent: false });
  notes.push(...alloc.notes);

  const taken = new Map<string, number>();
  const earFill = fillBlock({
    blockSec: alloc.earSec,
    due: ear.due,
    fresh: ear.fresh,
    allowance: newAllowance,
    forceFirst: true,
    infos,
    taken,
    state,
    graph,
  });
  const readFill = fillBlock({
    blockSec: alloc.readSec,
    due: read.due,
    fresh: read.fresh,
    allowance: newAllowance - earFill.newCount,
    forceFirst: false,
    infos,
    taken,
    state,
    graph,
  });

  const introductions = intro && earFill.items.some((i) => i.nodeId === intro.id) ? [intro.id] : [];
  if (intro && introductions.length === 0)
    notes.push(`introduction of ${intro.id} dropped: no fit`);

  const earItems = interleave(earFill.items, createRng(input.seed));
  const readItems = interleave(readFill.items, createRng((input.seed ^ 0x5bd1e995) >>> 0));

  const orient =
    mode === "away"
      ? null
      : {
          estimatedSec: alloc.orientSec,
          includeScale: alloc.orientSec >= SCALE_ORIENT_SEC,
        };
  const estimatedSec = (orient?.estimatedSec ?? 0) + earFill.usedSec + readFill.usedSec;

  return {
    key,
    mode,
    budgetSec,
    estimatedSec,
    orient,
    blocks: { ear: earItems, read: readItems, apply: null },
    introductions,
    diagnostics: {
      dueCount: ear.due.length + read.due.length,
      newAllowance,
      reallocatedSec: alloc.reallocatedSec,
      notes,
    },
  };
}
