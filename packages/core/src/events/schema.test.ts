import { describe, expect, it } from "vitest";
import { eventRegistry, parseEvent } from "./schema.js";

const base = {
  id: "01ARYZ6S410000000000000000",
  deviceId: "dev1",
  at: 1_700_000_000_000,
  v: 1,
};
const device = { ...base, type: "device.registered", platform: "web" };
const settings = { ...base, type: "settings.changed", patch: { budgetSec: 600 } };

function code(input: unknown): string {
  const r = parseEvent(input);
  return r.ok ? "ok" : r.error.code;
}

describe("parseEvent", () => {
  it("accepts valid events", () => {
    expect(parseEvent(device)).toEqual({ ok: true, event: device });
    expect(parseEvent({ ...device, userAgent: "UA" }).ok).toBe(true);
    expect(parseEvent(settings)).toEqual({ ok: true, event: settings });
    expect(parseEvent({ ...settings, patch: {} }).ok).toBe(true);
  });

  it("rejects non-objects and missing type/version", () => {
    for (const input of [null, undefined, 3, "x", [], {}, { type: "device.registered" }]) {
      expect(code(input)).toBe("malformed");
    }
  });

  it("rejects a missing id", () => {
    const noId = omit(device, "id");
    expect(code(noId)).toBe("invalid");
  });

  it("rejects bad ULIDs", () => {
    for (const id of ["", "abc", "01ARYZ6S41000000000000000I", "81ARYZ6S410000000000000000"]) {
      expect(code({ ...device, id })).toBe("invalid");
    }
  });

  it("rejects bad envelope fields", () => {
    expect(code({ ...device, deviceId: "" })).toBe("invalid");
    expect(code({ ...device, at: 1.5 })).toBe("invalid");
    expect(code({ ...device, at: "1" })).toBe("invalid");
  });

  it("rejects unknown types and versions without throwing", () => {
    expect(code({ ...device, type: "nope" })).toBe("unknown_type");
    expect(code({ ...device, type: "__proto__" })).toBe("unknown_type");
    expect(code({ ...device, v: 2 })).toBe("unknown_version");
    expect(code({ ...device, v: 0 })).toBe("malformed");
  });

  it("rejects wrong payloads", () => {
    expect(code({ ...device, platform: 5 })).toBe("invalid");
    const noPlatform = omit(device, "platform");
    expect(code(noPlatform)).toBe("invalid");
    expect(code({ ...settings, patch: { budgetSec: 59 } })).toBe("invalid");
    expect(code({ ...settings, patch: { budgetSec: 3601 } })).toBe("invalid");
    expect(code({ ...settings, patch: { awayBudgetSec: 1801 } })).toBe("invalid");
    expect(code({ ...settings, patch: { voiceRangeLow: 20 } })).toBe("invalid");
    expect(code({ ...settings, patch: { voiceRangeHigh: 109 } })).toBe("invalid");
    expect(code({ ...settings, patch: { headphones: "yes" } })).toBe("invalid");
    expect(code({ ...settings, patch: undefined })).toBe("invalid");
  });

  it("rejects extra keys in the settings patch", () => {
    expect(code({ ...settings, patch: { budgetSec: 600, volume: 3 } })).toBe("invalid");
  });

  it("rejects userId and other extra top-level keys (R7)", () => {
    expect(code({ ...device, userId: "u1" })).toBe("invalid");
    expect(code({ ...settings, extra: true })).toBe("invalid");
  });

  it("has a registry entry for every type, with a version-1 schema", () => {
    for (const entry of Object.values(eventRegistry)) {
      expect(Object.keys(entry.versions)).toContain("1");
    }
  });
});

function omit(obj: Record<string, unknown>, key: string): Record<string, unknown> {
  return Object.fromEntries(Object.entries(obj).filter(([k]) => k !== key));
}
