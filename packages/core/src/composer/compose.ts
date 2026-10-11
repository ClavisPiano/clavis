import { at } from "../theory/util.js";
import type { GeneratorId, SkillGraph, SkillNode, Strand } from "../graph/schema.js";
import { isNodeEnabled } from "../graph/validate.js";
import { itemId as makeItemId } from "../items/ids.js";
import { familyOfParams, keyForFamily, openFamilies } from "../items/family.js";
import { GENERATORS } from "../items/registry.js";
import type { Generator, ItemParams } from "../items/types.js";
import { learnerDay } from "../learning/day.js";
import { createRng } from "../random.js";
import { newItemAllowance } from "../scheduler/new-items.js";
import { rankDue } from "../scheduler/rank.js";
import type { CardState } from "../scheduler/card.js";
import { medianDurationSec } from "../state/reduce.js";
import type { LearnerState } from "../state/types.js";
import { allocate, DEFAULT_BUDGET_SEC, SCALE_ORIENT_SEC } from "./budget.js";
import { interleave } from "./interleave.js";
import { rankWeakest } from "./practice.js";
import { keyFamily, type KeyFamily } from "../theory/keys.js";
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
  /** Key family of the item, for key-dependent nodes (R15). */
  fam?: KeyFamily;
}

type Registry = Partial<Record<GeneratorId, Generator>>;

/** The READ node whose fluency ends the C-major-first rule (R15). */
const LANDMARKS_NODE = "read.bass.landmarks";
const FAMILY_ORDER: readonly KeyFamily[] = ["A", "B", "C"];

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

/**
 * A node is enabled when the graph marks one of its generators implemented and the (possibly
 * injected) registry has it. With the default registry this is the same as `isNodeEnabled`.
 */
function nodeEnabled(node: SkillNode, graph: SkillGraph, registry: Registry): boolean {
  return (
    isNodeEnabled(node, graph.generators) &&
    node.itemGenerators.some(
      (g) => registry[g] !== undefined && graph.generators.some((i) => i.id === g && i.implemented),
    )
  );
}

function usableGenerators(
  node: SkillNode,
  graph: SkillGraph,
  mode: ComposeInput["mode"],
  registry: Registry,
): GeneratorId[] {
  if (!nodeEnabled(node, graph, registry)) return [];
  return node.itemGenerators.filter((g) => {
    const info = graph.generators.find((i) => i.id === g);
    return (
      info !== undefined &&
      info.implemented &&
      registry[g] !== undefined &&
      (mode === "instrument" || info.awayEligible)
    );
  });
}

function buildInfo(
  node: SkillNode,
  graph: SkillGraph,
  mode: ComposeInput["mode"],
  registry: Registry,
) {
  const gens = usableGenerators(node, graph, mode, registry);
  const first = gens[0];
  if (first === undefined) return undefined;
  const gen = registry[first];
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
      ...(c.fam !== undefined ? { fam: c.fam } : {}),
    });
    out.usedSec += estimatedSec;
    if (c.isNew) out.newCount++;
    opts.taken.set(c.nodeId, (opts.taken.get(c.nodeId) ?? 0) + 1);
  }
  return out;
}

/**
 * Compose a session (spec 6, plan T2.8, T3.9). Pure and deterministic: the same input, including
 * the seed, always gives the same plan. Choices that are not obvious from the spec:
 *
 * - Cards are per item id and shared by all generators of a node (R14), so "new" means the item id
 *   has no card yet.
 * - Due items come first and may use the whole ear block, as in the spec's fill order; new items
 *   follow, so a deep backlog defers new material.
 * - New items of a non-key-dependent node come only from nodes in `learning` state, in graph
 *   order, then `listItems` order. For key-dependent nodes (READ) they come from every open key
 *   family of any node at `learning` or beyond, the key-of-the-day family first, then A, B, C
 *   (R15). Due items keep their stored params.
 * - Each strand (EAR, READ) may introduce a node when none of its own enabled nodes is learning
 *   (R16), but a session introduces at most one. When both have a candidate the strand whose most
 *   recent introduction is older wins, ties go to EAR. A node is introduced only when the daily
 *   allowance is above zero and at least one of its items fits; otherwise the introduction is
 *   dropped.
 * - When READ has new candidates it reserves floor(allowance / 2) new items, EAR gets the rest.
 * - Away has no Orient, uses only Away-eligible generators, and splits the budget 60/40 between
 *   Ear and Read when Read has content, else all Ear.
 * - Generators come from `input.generators` (default `GENERATORS`).
 * - Apply is always null (M5).
 */
export function composeSession(input: ComposeInput): SessionPlan {
  const { state, graph, mode } = input;
  const registry: Registry = input.generators ?? GENERATORS;
  const today = learnerDay(input.now, input.tzOffsetMin);
  const settingsBudget = mode === "away" ? state.settings.awayBudgetSec : state.settings.budgetSec;
  const budgetSec = input.budgetSec ?? settingsBudget ?? DEFAULT_BUDGET_SEC[mode];
  if (!Number.isFinite(budgetSec) || budgetSec <= 0) {
    throw new RangeError(`budgetSec must be positive, got ${String(budgetSec)}`);
  }

  const key = keyOfDay(state, graph, input.now, input.tzOffsetMin);
  const dayFamily = keyFamily(key);
  const introducedToday = state.daily[today]?.newItems ?? 0;
  const newAllowance = input.practice
    ? 0
    : newItemAllowance({ introducedToday, cap: state.settings.newItemsPerDay });
  const notes: string[] = [];

  const infos = new Map<string, NodeInfo>();
  const strands: Strand[] = ["EAR", "READ"];
  for (const node of graph.nodes) {
    if (!strands.includes(node.strand)) continue;
    const info = buildInfo(node, graph, mode, registry);
    if (info) infos.set(node.id, info);
  }
  const stateOf = (id: string) => NODE_RANK[state.nodes[id]?.state ?? "locked"];

  // One introduction at most, and each strand only while none of its own nodes is mid-learning
  // (spec 13, R16).
  const introCandidate = (strand: Strand): SkillNode | undefined => {
    const learning = graph.nodes.some(
      (n) =>
        n.strand === strand &&
        nodeEnabled(n, graph, registry) &&
        state.nodes[n.id]?.state === "learning",
    );
    if (learning || input.practice) return undefined;
    return graph.nodes
      .map((node, order) => ({ node, order }))
      .filter(
        ({ node }) =>
          node.strand === strand &&
          infos.has(node.id) &&
          state.nodes[node.id]?.state === "available" &&
          (mode === "instrument" || !dependsOnHands(graph, node.id)),
      )
      .sort(
        (a, b) => a.node.prerequisites.length - b.node.prerequisites.length || a.order - b.order,
      )[0]?.node;
  };
  const lastIntroduction = (strand: Strand): number =>
    graph.nodes.reduce(
      (latest, n) =>
        n.strand === strand
          ? Math.max(latest, state.nodes[n.id]?.introducedAt ?? -Infinity)
          : latest,
      -Infinity,
    );

  let intro: SkillNode | undefined;
  const earIntro = introCandidate("EAR");
  const readIntro = introCandidate("READ");
  const chosen =
    earIntro && readIntro
      ? lastIntroduction("READ") < lastIntroduction("EAR")
        ? readIntro
        : earIntro
      : (earIntro ?? readIntro);
  if (chosen) {
    if (newAllowance > 0) intro = chosen;
    else notes.push("daily new-item cap reached: introduction deferred");
  }

  const famRank = (fam: KeyFamily | undefined): number =>
    fam === undefined || fam === dayFamily ? 0 : 1 + FAMILY_ORDER.indexOf(fam);

  const candidates = (strand: Strand) => {
    const dueAll: (Candidate & { card: CardState })[] = [];
    const fresh: Candidate[] = [];
    for (const [nodeId, info] of infos) {
      if (info.node.strand !== strand) continue;
      const rec = state.nodes[nodeId];
      const learning = rec?.state === "learning";
      const introducing = intro?.id === nodeId;
      if (stateOf(nodeId) < NODE_RANK.learning && !introducing) continue;
      const keyDependent = info.node.keyDependent;
      // Families that may supply new items (R15). A node being introduced opens family A.
      const open: KeyFamily[] = !keyDependent
        ? []
        : introducing
          ? ["A"]
          : openFamilies(rec ?? { state: "locked" });
      for (const u of info.universe) {
        const fam = keyDependent ? (familyOfParams(u.params) ?? "A") : undefined;
        const famPart = fam !== undefined ? { fam } : {};
        const card = state.cards[u.itemId];
        if (card) {
          if (card.nodeId === nodeId)
            dueAll.push({ ...u, nodeId, isNew: false, card: card.card, ...famPart });
        } else if (
          // Practice (T2.15) drills items that already have cards only.
          !input.practice &&
          (fam !== undefined ? open.includes(fam) : learning || introducing)
        ) {
          fresh.push({ ...u, nodeId, isNew: true, ...famPart });
        }
      }
    }
    const due = (
      input.practice ? rankWeakest(dueAll, input.now) : rankDue(dueAll, input.now)
    ) as Candidate[];
    // Stable sort: key-of-the-day family first, then A, B, C; graph and item order within.
    fresh.sort((a, b) => famRank(a.fam) - famRank(b.fam));
    return { due, fresh };
  };

  const ear = candidates("EAR");
  const read = candidates("READ");
  const readHasContent = read.due.length > 0 || (read.fresh.length > 0 && newAllowance > 0);

  const alloc = allocate({ budgetSec, mode, readHasContent, applyHasContent: false });
  notes.push(...alloc.notes);

  const readReserve = read.fresh.length > 0 ? Math.floor(newAllowance / 2) : 0;
  const taken = new Map<string, number>();
  const earFill = fillBlock({
    blockSec: alloc.earSec,
    due: ear.due,
    fresh: ear.fresh,
    allowance: newAllowance - readReserve,
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

  const introduced =
    intro !== undefined && [...earFill.items, ...readFill.items].some((i) => i.nodeId === intro.id);
  const introductions = intro && introduced ? [intro.id] : [];
  const introductionKeyFamilies: Record<string, KeyFamily> =
    intro && introduced && intro.keyDependent ? { [intro.id]: "A" } : {};
  if (intro && !introduced) notes.push(`introduction of ${intro.id} dropped: no fit`);

  // Key per key-dependent item (R15): the key of the day when it is in the item's family, else a
  // seeded pick. Until bass landmarks are fluent, family A means C major (A minor) only.
  const keyRng = createRng((input.seed ^ 0x2545f491) >>> 0);
  const cMajorFirst = stateOf(LANDMARKS_NODE) < NODE_RANK.fluent;
  const withKey = (items: PlannedItem[]): PlannedItem[] =>
    items.map((item) => {
      if (item.fam === undefined) return item;
      const itemMode = infos.get(item.nodeId)?.node.params.mode === "minor" ? "minor" : "major";
      return { ...item, key: keyForFamily(item.fam, itemMode, key, keyRng, { cMajorFirst }) };
    });

  const earItems = withKey(interleave(earFill.items, createRng(input.seed)));
  const readItems = withKey(interleave(readFill.items, createRng((input.seed ^ 0x5bd1e995) >>> 0)));

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
    introductionKeyFamilies,
    ...(input.practice ? { practice: true as const } : {}),
    diagnostics: {
      dueCount: ear.due.length + read.due.length,
      newAllowance,
      reallocatedSec: alloc.reallocatedSec,
      notes,
    },
  };
}
