import type { JsonValue } from "../json.js";
import type { ItemParams } from "./types.js";

function canonicalValue(key: string, v: JsonValue): string {
  if (Array.isArray(v)) {
    return v
      .map((x) => {
        if (x !== null && typeof x === "object")
          throw new TypeError(`item param ${key} has a nested value`);
        return String(x);
      })
      .join("-");
  }
  if (v !== null && typeof v === "object") throw new TypeError(`item param ${key} is an object`);
  return String(v);
}

/**
 * Canonical item id (R1): `nodeId|k=v|k=v` with keys sorted. Arrays are joined with `-`.
 * Never includes the key/tonic or the generator (R14).
 */
export function itemId(nodeId: string, params: ItemParams): string {
  const parts = Object.keys(params)
    .sort()
    .map((k) => `${k}=${canonicalValue(k, params[k] as JsonValue)}`);
  return [nodeId, ...parts].join("|");
}
