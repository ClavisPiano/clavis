import { stimulusDurationSec } from "@clavis/core";
import { describe, expect, it } from "vitest";
import { DEV_KEYS, cadenceSpec, scaleSpec } from "./stimulus-dev";

describe("stimulus-dev", () => {
  it("builds a four-chord cadence for every key, one chord per beat", () => {
    for (const { key } of DEV_KEYS) {
      const spec = cadenceSpec(key);
      expect(spec.events).toHaveLength(4);
      spec.events.forEach((e, i) => {
        expect(e.atSec).toBeCloseTo((i * 2) / 3);
      });
      expect(spec.events.every((e) => e.midi.length === 4)).toBe(true);
    }
  });

  it("builds an eight-note scale", () => {
    const spec = scaleSpec({ tonic: "C", mode: "major" });
    expect(spec.events.map((e) => e.midi[0])).toEqual([60, 62, 64, 65, 67, 69, 71, 72]);
    expect(stimulusDurationSec(spec)).toBeGreaterThan(4.5);
  });
});
