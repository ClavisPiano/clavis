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
   * `?skills=a,b`: with `practice`, drill only these skills (node ids). Undefined means all.
   */
  skills: string[] | undefined;
  /**
   * `?learn=1`: "Learn something new" grants one more batch of new items beyond the daily cap for
   * this session only. Nothing is stored. Practice wins when both are set.
   */
  learn: boolean;
  /**
   * `?run=piece.<id>`: play that piece through, every phrase in order (MP). Instrument mode only;
   * anything else is ignored.
   */
  run: string | undefined;
}

export const MIN_BUDGET_SEC = 30;
export const MAX_BUDGET_SEC = 3600;

const NODE_ID = /^[A-Za-z0-9.-]{1,64}$/;
const MAX_SKILLS = 40;

/** `?skills=` as a list of well-formed node ids; undefined when absent or empty. */
export function parseSkills(raw: string | null): string[] | undefined {
  if (raw === null) return undefined;
  const ids = raw
    .split(",")
    .filter((id) => NODE_ID.test(id))
    .slice(0, MAX_SKILLS);
  return ids.length > 0 ? [...new Set(ids)] : undefined;
}

export function parseBudget(raw: string | null): number | undefined {
  if (raw === null || !/^\d+$/.test(raw)) return undefined;
  const n = Number(raw);
  return n >= MIN_BUDGET_SEC && n <= MAX_BUDGET_SEC ? n : undefined;
}

const PIECE_ID = /^piece\.[a-z0-9-]+$/;

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
    skills:
      searchParams.get("practice") === "1" ? parseSkills(searchParams.get("skills")) : undefined,
    learn: searchParams.get("practice") !== "1" && searchParams.get("learn") === "1",
    headphones: headphones ?? (inputKind === "fake" ? true : undefined),
    run:
      mode === "instrument" && PIECE_ID.test(searchParams.get("run") ?? "")
        ? (searchParams.get("run") ?? undefined)
        : undefined,
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
