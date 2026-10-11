import { stimulusDurationSec, type Key, type StimulusSpec } from "@clavis/core";
import { cadenceSpec, scaleSpec } from "../stimulus-dev";

/** Pause between the scale and the cadence. */
export const ORIENT_GAP_SEC = 0.6;

/**
 * Orient block (spec 6.2): the key-of-the-day scale (when time allows) and then the I-IV-V-I
 * cadence. Unscored.
 */
export function orientSpec(key: Key, includeScale: boolean): StimulusSpec {
  const cadence = cadenceSpec(key);
  if (!includeScale) return cadence;
  const scale = scaleSpec(key);
  const offset = stimulusDurationSec(scale) + ORIENT_GAP_SEC;
  return {
    events: [...scale.events, ...cadence.events.map((e) => ({ ...e, atSec: e.atSec + offset }))],
    ...(cadence.tempoBpm === undefined ? {} : { tempoBpm: cadence.tempoBpm }),
  };
}
