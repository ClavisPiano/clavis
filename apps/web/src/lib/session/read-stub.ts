import {
  FIXTURE_BASS_F3_G_MAJOR,
  itemId,
  type Generator,
  type GeneratorId,
  type ItemParams,
  type SkillGraph,
} from "@clavis/core";
import type { NotationPort } from "../notation/port";

/*
 * Test seam for reading items (T3.11). The real `bassNoteRead` is not registered until T3.15, so
 * Playwright cannot get a READ item into a session. `?readstub=1` (honoured only together with
 * `?audio=silent`, so it is never reached by a normal install) swaps in this one-item generator,
 * marks `bassNoteRead` implemented in the session's graph, and supplies a notation port that paints
 * nothing. Remove it when T3.15 lands and the real generator and renderer are wired.
 */

/** F3 in G major sounds F#3. */
export const STUB_READ_TARGET_MIDI = 54;
/** Bass register, the same shape `bassNoteRead` will set. */
export const STUB_READ_RANGE = { low: 36, high: 60 } as const;

export const STUB_BASS_NOTE_READ: Generator = {
  id: "bassNoteRead",
  listItems(): ItemParams[] {
    return (["A", "B", "C"] as const).map((fam) => ({ fam, pos: "F3" }));
  },
  generate(node, params) {
    const fam = typeof params.fam === "string" ? params.fam : "A";
    return {
      itemId: itemId(node.id, params),
      nodeId: node.id,
      generator: "bassNoteRead",
      params,
      presentation: { tonic: "G", mode: "major", pos: "F3", fam },
      stimulus: { events: [] },
      expected: {
        play: { kind: "exactPitch", targetMidi: STUB_READ_TARGET_MIDI },
        responseWindowMs: 6000,
      },
      display: FIXTURE_BASS_F3_G_MAJOR,
      inputRange: { ...STUB_READ_RANGE },
    };
  },
};

/** Only this generator is enabled, so the composer plans nothing but the stub read items. */
export const STUB_READ_REGISTRY: Partial<Record<GeneratorId, Generator>> = {
  bassNoteRead: STUB_BASS_NOTE_READ,
};

export function withStubReadImplemented(graph: SkillGraph): SkillGraph {
  return {
    ...graph,
    generators: graph.generators.map((g) =>
      g.id === "bassNoteRead" ? { ...g, implemented: true } : g,
    ),
  };
}

export const STUB_NOTATION: NotationPort = {
  preload: () => Promise.resolve(),
  show: () => Promise.resolve(),
  highlight: () => undefined,
  hide: () => undefined,
};
