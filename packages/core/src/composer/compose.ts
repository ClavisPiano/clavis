import { at } from "../theory/util.js";
import type { GeneratorId, SkillGraph, SkillNode, Strand } from "../graph/schema.js";
import { isNodeEnabled } from "../graph/validate.js";
import { itemId as makeItemId } from "../items/ids.js";
import { familyOfParams, keyForFamily, openFamilies } from "../items/family.js";
import { GENERATORS } from "../items/registry.js";
import type { Generator, ItemParams } from "../items/types.js";
import { learnerDay } from "../learning/day.js";
import { listPieces } from "../pieces/list.js";
import type { Piece } from "../pieces/schema.js";
import { createRng, type Rng } from "../random.js";
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

/**
 * Where a node's uncarded items rank among new items. Learning and being-introduced nodes come
 * first, then fluent nodes (which includes skills placed there, R19, that never got cards), then
 * mastered nodes as a last resort.
 */
const TIER_LEARNING = 0;
const TIER_FLUENT = 1;
const TIER_MASTERED = 2;

type Registry = Partial<Record<GeneratorId, Generator>>;

/** New piece phrases offered in one session (MP). Later phrases wait for the next one. */
export const APPLY_NEW_PHRASES_PER_SESSION = 2;

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
  /**
   * The items split into passes over the candidate list. A normal fill is one pass. A practice
   * fill (`cycle`) starts a new pass each time it wraps round to the weakest item again.
   */
  passes: PlannedItem[][];
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
  /**
   * Practice only: after the first pass keep cycling `due` (weakest first) until nothing more
   * fits, so the plan fills the block. The same item never follows itself while another exists.
   */
  cycle?: boolean;
  infos: Map<string, NodeInfo>;
  taken: Map<string, number>;
  state: LearnerState;
  graph: SkillGraph;
}): Fill {
  const out: Fill = { items: [], passes: [[]], newCount: 0, usedSec: 0 };
  const take = (c: Candidate, pass: PlannedItem[]): boolean => {
    const info = opts.infos.get(c.nodeId);
    if (!info) return false;
    const generator = chooseGenerator(info, opts.taken.get(c.nodeId) ?? 0);
    const seed = opts.graph.generators.find((g) => g.id === generator)?.seedDurationSec ?? 10;
    const estimatedSec = medianDurationSec(opts.state, generator, seed);
    const fits = out.usedSec + estimatedSec <= opts.blockSec;
    if (!fits && !(opts.forceFirst && out.items.length === 0)) return false;
    const planned: PlannedItem = {
      itemId: c.itemId,
      nodeId: c.nodeId,
      generator,
      params: c.params,
      isNew: c.isNew,
      estimatedSec,
      ...(c.fam !== undefined ? { fam: c.fam } : {}),
    };
    out.items.push(planned);
    pass.push(planned);
    out.usedSec += estimatedSec;
    if (c.isNew) out.newCount++;
    opts.taken.set(c.nodeId, (opts.taken.get(c.nodeId) ?? 0) + 1);
    return true;
  };
  for (const c of [...opts.due, ...opts.fresh]) {
    if (c.isNew && out.newCount >= opts.allowance) break;
    take(c, out.passes[0] ?? []);
  }
  if (opts.cycle && out.items.length > 0) {
    // Later passes: same order, skipping what no longer fits and an item that would directly
    // follow itself. A pass that adds nothing ends the fill.
    for (;;) {
      const pass: PlannedItem[] = [];
      for (const c of opts.due) {
        const last = out.items[out.items.length - 1];
        if (opts.due.length > 1 && last?.itemId === c.itemId) continue;
        take(c, pass);
      }
      if (pass.length === 0) break;
      out.passes.push(pass);
      // A pass of zero-length items (bad timing data) would never fill the block: stop.
      if (pass.every((x) => x.estimatedSec <= 0)) break;
    }
  }
  return out;
}

/**
 * Order a fill for presentation. A normal fill is interleaved as one block. A practice fill is
 * interleaved pass by pass, and the seam between passes is fixed so an item never follows itself.
 */
function arrange(fill: Fill, rng: Rng, practice: boolean): PlannedItem[] {
  if (!practice) return interleave(fill.items, rng);
  const out: PlannedItem[] = [];
  for (const pass of fill.passes) {
    const ordered = interleave(pass, rng);
    const last = out[out.length - 1];
    const first = ordered[0];
    if (first !== undefined && first.itemId === last?.itemId) {
      const second = ordered[1];
      if (second !== undefined) {
        ordered[0] = second;
        ordered[1] = first;
      } else {
        // A one-item pass cannot swap: move the item to the first gap whose neighbours differ
        // from it (the very front counts), so it never follows itself.
        const at = [...out.keys(), out.length].find(
          (i) => out[i - 1]?.itemId !== first.itemId && out[i]?.itemId !== first.itemId,
        );
        // With only one distinct item there is no such gap, and repeats are all there is.
        if (at !== undefined) out.splice(at, 0, first);
        else if (out.every((x) => x.itemId === first.itemId)) out.push(first);
        continue;
      }
    }
    out.push(...ordered);
  }
  return out;
}

/**
 * Due and new piece phrases for the Apply block (MP). Phrases with a card are due when FSRS says
 * so, most overdue first, whatever the state of their piece now. New phrases come from the current
 * piece only: the first unlocked piece that has not been played through, in phrase order.
 */
function applyCandidates(
  info: NodeInfo,
  pieces: readonly Piece[],
  state: LearnerState,
  now: number,
): { due: Candidate[]; fresh: Candidate[] } {
  const nodeId = info.node.id;
  const dueAll: (Candidate & { card: CardState })[] = [];
  for (const u of info.universe) {
    const card = state.cards[u.itemId];
    if (card?.nodeId === nodeId) {
      dueAll.push({ ...u, nodeId, isNew: false, card: card.card });
    }
  }
  const current = listPieces(pieces, state).find(
    (s) => s.unlocked && state.pieces[s.piece.id]?.completedAt === undefined,
  );
  const fresh: Candidate[] = [];
  if (current) {
    const unseen = info.universe
      .filter((u) => u.params.piece === current.piece.id && state.cards[u.itemId] === undefined)
      .sort((a, b) => Number(a.params.phrase) - Number(b.params.phrase));
    for (const u of unseen.slice(0, APPLY_NEW_PHRASES_PER_SESSION)) {
      fresh.push({ ...u, nodeId, isNew: true });
    }
  }
  return { due: rankDue(dueAll, now), fresh };
}

/**
 * A whole-piece run (MP): every phrase of `pieceId`, in order, as the Apply block of a session
 * that has nothing else in it. The runner writes `piece.completed` when the last phrase is done.
 * Throws when the piece is unknown or still locked, or the graph and registry cannot play pieces.
 * The budget is generous because a run is not a timed session.
 */
export function composePieceRun(input: {
  state: LearnerState;
  graph: SkillGraph;
  pieces: readonly Piece[];
  pieceId: string;
  now: number;
  tzOffsetMin: number;
  generators?: Partial<Record<GeneratorId, Generator>>;
}): SessionPlan {
  const { state, graph } = input;
  const registry: Registry = input.generators ?? GENERATORS;
  const node = graph.nodes.find((n) => n.strand === "APPLY" && nodeEnabled(n, graph, registry));
  const gen = registry.pieceLine;
  if (node === undefined || gen === undefined) {
    throw new RangeError("pieces are not enabled: no APPLY node with a pieceLine generator");
  }
  const status = listPieces(input.pieces, state).find((s) => s.piece.id === input.pieceId);
  if (status === undefined) throw new RangeError(`unknown piece ${input.pieceId}`);
  if (!status.unlocked) {
    throw new RangeError(`piece ${input.pieceId} is locked: ${status.missingNodeIds.join(", ")}`);
  }
  const seed = graph.generators.find((g) => g.id === "pieceLine")?.seedDurationSec ?? 25;
  const estimatedSec = medianDurationSec(state, "pieceLine", seed);
  const items: PlannedItem[] = gen
    .listItems(node)
    .filter((params) => params.piece === input.pieceId)
    .sort((a, b) => Number(a.phrase) - Number(b.phrase))
    .map((params) => {
      const id = makeItemId(node.id, params);
      return {
        itemId: id,
        nodeId: node.id,
        generator: "pieceLine" as const,
        params,
        isNew: state.cards[id] === undefined,
        estimatedSec,
      };
    });
  const total = items.reduce((sum, i) => sum + i.estimatedSec, 0);
  return {
    key: keyOfDay(state, graph, input.now, input.tzOffsetMin),
    mode: "instrument",
    budgetSec: Math.max(60, Math.ceil(total * 2)),
    estimatedSec: total,
    orient: null,
    blocks: { ear: [], read: [], apply: items },
    introductions: [],
    introductionKeyFamilies: {},
    run: { pieceId: input.pieceId },
    diagnostics: {
      dueCount: 0,
      newAllowance: 0,
      reallocatedSec: 0,
      notes: [`piece run: ${status.piece.title}`],
    },
  };
}

/**
 * Compose a session (spec 6, plan T2.8, T3.9). Pure and deterministic: the same input, including
 * the seed, always gives the same plan. Choices that are not obvious from the spec:
 *
 * - Cards are per item id and shared by all generators of a node (R14), so "new" means the item id
 *   has no card yet.
 * - Due items come first and may use the whole ear block, as in the spec's fill order; new items
 *   follow, so a deep backlog defers new material.
 * - New items are items without a card. They come from enabled nodes at `learning` or beyond,
 *   whatever route got them there, so a skill placed at `fluent` (R19) writes no cards but still
 *   feeds sessions. In EAR, learning (or introduced) and `fluent` nodes take turns, one item each
 *   per round with learning nodes first in a round; in READ, learning nodes come first, then
 *   `fluent`; graph order then `listItems` order within. Uncarded items of `mastered` nodes follow only when the
 *   strand has no other new candidate and no node it could introduce. For key-dependent nodes
 *   (READ) the items come from every open key family of any node at `learning` or beyond (R15),
 *   after the same learning-first ordering, the key-of-the-day family first, then A, B, C. Due
 *   items keep their stored params.
 * - Each strand (EAR, READ) may introduce a node when none of its own enabled nodes is learning
 *   (R16), but a session introduces at most one. When both have a candidate the strand whose most
 *   recent introduction is older wins, ties go to EAR. A node is introduced only when the daily
 *   allowance is above zero and at least one of its items fits; otherwise the introduction is
 *   dropped.
 * - When READ has new candidates it reserves floor(allowance / 2) new items, EAR gets the rest.
 * - Away has no Orient, uses only Away-eligible generators, and splits the budget 60/40 between
 *   Ear and Read when Read has content, else all Ear.
 * - Generators come from `input.generators` (default `GENERATORS`).
 * - Apply (MP) holds piece phrases: due ones, then up to `APPLY_NEW_PHRASES_PER_SESSION` new
 *   phrases of the current piece (the first unlocked piece not yet played through, see
 *   `listPieces`), when `input.pieces` and an enabled `pieceLine` generator are present. It is null
 *   in Away mode, in practice, and when it has nothing.
 * - `extraNewItems` raises the new-item allowance for this plan only (Learn something new). The
 *   introduction and strand rules are unchanged.
 * - A practice plan cycles the started items, weakest first, until the block budget is spent.
 *   Repeats are safe because practice attempts never move a card.
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
  const extraNew = Math.max(0, Math.floor(input.extraNewItems ?? 0));
  const newAllowance = input.practice
    ? 0
    : newItemAllowance({ introducedToday, cap: state.settings.newItemsPerDay }) + extraNew;
  const notes: string[] = [];

  const infos = new Map<string, NodeInfo>();
  const strands: Strand[] = ["EAR", "READ", "APPLY"];
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
    const fresh: (Candidate & { tier: number })[] = [];
    for (const [nodeId, info] of infos) {
      if (info.node.strand !== strand) continue;
      const rec = state.nodes[nodeId];
      const learning = rec?.state === "learning";
      const introducing = intro?.id === nodeId;
      if (stateOf(nodeId) < NODE_RANK.learning && !introducing) continue;
      const nodeRank = stateOf(nodeId);
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
          (fam !== undefined ? open.includes(fam) : nodeRank >= NODE_RANK.learning || introducing)
        ) {
          // Key-dependent nodes only offer items in open families (R15), which already follow
          // from their state, so they never need the mastered fallback.
          const tier =
            learning || introducing
              ? TIER_LEARNING
              : nodeRank >= NODE_RANK.mastered && fam === undefined
                ? TIER_MASTERED
                : TIER_FLUENT;
          fresh.push({ ...u, nodeId, isNew: true, tier, ...famPart });
        }
      }
    }
    const due = (
      input.practice ? rankWeakest(dueAll, input.now) : rankDue(dueAll, input.now)
    ) as Candidate[];
    // Mastered items are a last resort: only when nothing else can supply new material here.
    const fallbackOnly =
      !fresh.some((c) => c.tier !== TIER_MASTERED) &&
      (strand === "EAR" ? earIntro : readIntro) === undefined;
    const usable = fresh.filter((c) => c.tier !== TIER_MASTERED || fallbackOnly);
    // EAR: learning and fluent nodes take turns, one item each per round (learning first in a
    // round), so a large learning node cannot hold back a placed skill for days. READ keeps
    // learning first, then fluent, then the key-of-the-day family first, then A, B, C (R15).
    // Mastered items always come last. The sort is stable, so graph and item order hold.
    const round = new Map<Candidate, number>();
    const seen = new Map<string, number>();
    for (const c of usable) {
      const k = seen.get(c.nodeId) ?? 0;
      round.set(c, strand === "EAR" ? k : 0);
      seen.set(c.nodeId, k + 1);
    }
    const lastResort = (c: { tier: number }): number => (c.tier === TIER_MASTERED ? 1 : 0);
    usable.sort(
      (a, b) =>
        lastResort(a) - lastResort(b) ||
        (round.get(a) ?? 0) - (round.get(b) ?? 0) ||
        a.tier - b.tier ||
        famRank(a.fam) - famRank(b.fam),
    );
    return { due, fresh: usable as Candidate[] };
  };

  const ear = candidates("EAR");
  const read = candidates("READ");
  const readHasContent = read.due.length > 0 || (read.fresh.length > 0 && newAllowance > 0);

  // Apply: piece phrases (MP). Due phrases first, then the next new phrases of the current piece.
  const applyInfo =
    input.pieces !== undefined &&
    input.pieces.length > 0 &&
    mode === "instrument" &&
    !input.practice
      ? [...infos.values()].find((i) => i.node.strand === "APPLY")
      : undefined;
  const apply = applyInfo
    ? applyCandidates(applyInfo, input.pieces ?? [], state, input.now)
    : { due: [], fresh: [] };
  const applyHasContent =
    apply.due.length > 0 || (apply.fresh.length > 0 && Math.round(newAllowance / 3) > 0);

  const alloc = allocate({ budgetSec, mode, readHasContent, applyHasContent });
  notes.push(...alloc.notes);

  const readReserve = read.fresh.length > 0 ? Math.floor(newAllowance / 2) : 0;
  // New piece phrases get a small share of the daily allowance too, or the many new reading items
  // would always use it up first: about a third, and never more than the phrases on offer.
  const applyReserve = Math.min(apply.fresh.length, Math.round(newAllowance / 3));
  const taken = new Map<string, number>();
  const earFill = fillBlock({
    blockSec: alloc.earSec,
    due: ear.due,
    fresh: ear.fresh,
    allowance: newAllowance - readReserve - applyReserve,
    forceFirst: true,
    cycle: input.practice === true,
    infos,
    taken,
    state,
    graph,
  });
  const readFill = fillBlock({
    blockSec: alloc.readSec,
    due: read.due,
    fresh: read.fresh,
    allowance: newAllowance - applyReserve - earFill.newCount,
    forceFirst: false,
    cycle: input.practice === true,
    infos,
    taken,
    state,
    graph,
  });

  const applyFill = fillBlock({
    blockSec: alloc.applySec,
    due: apply.due,
    fresh: apply.fresh,
    allowance: newAllowance - earFill.newCount - readFill.newCount,
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

  const practice = input.practice === true;
  const earItems = withKey(arrange(earFill, createRng(input.seed), practice));
  const readItems = withKey(
    arrange(readFill, createRng((input.seed ^ 0x5bd1e995) >>> 0), practice),
  );

  const orient =
    mode === "away"
      ? null
      : {
          estimatedSec: alloc.orientSec,
          includeScale: alloc.orientSec >= SCALE_ORIENT_SEC,
        };
  const estimatedSec =
    (orient?.estimatedSec ?? 0) + earFill.usedSec + readFill.usedSec + applyFill.usedSec;

  return {
    key,
    mode,
    budgetSec,
    estimatedSec,
    orient,
    // Phrases keep their order: due ones most overdue first, then new ones in the piece's order.
    blocks: {
      ear: earItems,
      read: readItems,
      apply: applyFill.items.length > 0 ? applyFill.items : null,
    },
    introductions,
    introductionKeyFamilies,
    ...(input.practice ? { practice: true as const } : {}),
    diagnostics: {
      dueCount: ear.due.length + read.due.length + apply.due.length,
      newAllowance,
      reallocatedSec: alloc.reallocatedSec,
      notes,
    },
  };
}
