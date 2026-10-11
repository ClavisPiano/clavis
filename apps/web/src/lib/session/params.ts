import { resolveInputKind, type InputKind } from "../input";
import { parseSessionMode, type SessionMode } from "../session-mode";

export interface SessionParams {
  mode: SessionMode;
  /** `?budget=` override in seconds (tests and quick sessions). */
  budgetSec: number | undefined;
  inputKind: InputKind;
  /** Fake instrument: no samples, no sound. Set by `?audio=silent`, and implied by fake input. */
  silent: boolean;
  /**
   * `?headphones=yes|no|ask`. Fake input defaults to "yes" so tests are not interrupted; "ask"
   * forces the prompt. Undefined means: use the remembered answer, else ask.
   */
  headphones: boolean | "ask" | undefined;
  /** `?practice=1`: extra practice on started items (T2.15). Cards and schedule stay untouched. */
  practice: boolean;
  /**
   * `?readstub=1` with silent audio: test-only seam that plans a stub READ item, because the real
   * reading generators are not registered yet (T3.15). See `read-stub.ts`.
   */
  readStub: boolean;
}

export const MIN_BUDGET_SEC = 30;
export const MAX_BUDGET_SEC = 3600;

export function parseBudget(raw: string | null): number | undefined {
  if (raw === null || !/^\d+$/.test(raw)) return undefined;
  const n = Number(raw);
  return n >= MIN_BUDGET_SEC && n <= MAX_BUDGET_SEC ? n : undefined;
}

export function parseSessionParams(
  searchParams: { get(name: string): string | null },
  storedInput?: string | null,
): SessionParams {
  const mode = parseSessionMode(searchParams);
  const inputKind = resolveInputKind(mode, searchParams, storedInput);
  const raw = searchParams.get("headphones");
  const headphones: SessionParams["headphones"] =
    raw === "yes" ? true : raw === "no" ? false : raw === "ask" ? "ask" : undefined;
  const silent = searchParams.get("audio") === "silent" || inputKind === "fake";
  return {
    mode,
    budgetSec: parseBudget(searchParams.get("budget")),
    inputKind,
    silent,
    practice: searchParams.get("practice") === "1",
    headphones: headphones ?? (inputKind === "fake" ? true : undefined),
    readStub: silent && searchParams.get("readstub") === "1",
  };
}

/** Latency calibration written by the calibration screen (device meta "latency"). */
export function parseLatency(raw: unknown): { tapMs?: number; micMs?: number } {
  if (raw === null || typeof raw !== "object") return {};
  const out: { tapMs?: number; micMs?: number } = {};
  const r = raw as Record<string, unknown>;
  if (typeof r.tapMs === "number" && Number.isFinite(r.tapMs)) out.tapMs = r.tapMs;
  if (typeof r.micMs === "number" && Number.isFinite(r.micMs)) out.micMs = r.micMs;
  return out;
}
