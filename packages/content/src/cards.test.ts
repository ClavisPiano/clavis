import { describe, expect, it } from "vitest";
import { cardWordCount, isNodeEnabled } from "@clavis/core";
import { CARDS_V1 } from "./cards/v1";
import { cardById, cardForNode, loadCards, loadGraph, ORIENT_CARD_ID, parseCards } from "./index";

/** Spec 13 targets about 120 words; cards here also carry "what you'll do". */
const MAX_BODY_WORDS = 150;
const MAX_HOWTO_WORDS = 90;

describe("concept cards v1", () => {
  const cards = loadCards();
  const graph = loadGraph();

  it("parses", () => {
    expect(cards.length).toBe(CARDS_V1.length);
  });

  it("has unique ids", () => {
    expect(new Set(cards.map((c) => c.id)).size).toBe(cards.length);
  });

  it("only references nodes in the graph, and each node has at most one card", () => {
    const ids = new Set(graph.nodes.map((n) => n.id));
    const seen = new Set<string>();
    for (const card of cards) {
      for (const nodeId of card.nodeIds) {
        expect(ids.has(nodeId), `${card.id} -> ${nodeId}`).toBe(true);
        expect(seen.has(nodeId), `${nodeId} has two cards`).toBe(false);
        seen.add(nodeId);
      }
    }
  });

  it("covers every enabled node", () => {
    const missing = graph.nodes
      .filter((n) => isNodeEnabled(n, graph.generators))
      .filter((n) => cardForNode(n.id) === undefined)
      .map((n) => n.id);
    expect(missing).toEqual([]);
  });

  it("has the warm-up card, tied to no node", () => {
    expect(cardById(ORIENT_CARD_ID)?.nodeIds).toEqual([]);
  });

  it.each(cards.map((c) => [c.id, c] as const))("%s stays within the length budget", (_id, c) => {
    const words = cardWordCount(c);
    expect(words.body).toBeLessThanOrEqual(MAX_BODY_WORDS);
    expect(words.howTo).toBeLessThanOrEqual(MAX_HOWTO_WORDS);
  });

  it.each(cards.map((c) => [c.id, c] as const))(
    "%s follows the prose rules (no em dashes, plain quotes)",
    (_id, c) => {
      const text = [c.title, ...c.body, ...c.howTo, ...c.examples.map((e) => e.label)].join(" ");
      expect(text).not.toMatch(/[—“”‘’]/);
    },
  );
});

describe("parseCards", () => {
  it("names the failing card and path", () => {
    expect(() => parseCards([{ id: "bad" }])).toThrow(/index 0[\s\S]*id/);
  });
});
