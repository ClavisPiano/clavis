import {
  DEFAULT_NEW_ITEM_CAP,
  dayNumberToIso,
  learnerDayNumber,
  type LearnerState,
  type SettingsPatch,
} from "@clavis/core";

/*
 * Pure helpers for Home and Settings (T2.10). "Day" is the learner day from R6: device timezone,
 * rolling over at 04:00 local time. Per spec 14 there is no streak: a missed day is just an empty
 * cell, and the only count shown is days practised against a weekly target.
 */

export const DEFAULT_BUDGET_SEC = 720;
export const DEFAULT_AWAY_BUDGET_SEC = 300;
export const DEFAULT_WEEKLY_TARGET_DAYS = 5;
export const NEW_ITEMS_PER_DAY_MIN = 3;
export const NEW_ITEMS_PER_DAY_MAX = 15;
export const DEFAULT_VOICE_LOW = 48;
export const DEFAULT_VOICE_HIGH = 72;

export const BUDGET_OPTIONS_MIN = [5, 8, 12, 15, 20] as const;
export const AWAY_BUDGET_OPTIONS_MIN = [3, 5, 8] as const;
export const WEEKLY_TARGET_OPTIONS = [3, 4, 5, 6, 7] as const;

/** A day counts as practised from one minute of session time. */
export const PRACTISED_MIN_SEC = 60;
export const WEEK_DAYS = 7;

export interface EffectiveSettings {
  budgetSec: number;
  awayBudgetSec: number;
  voiceRangeLow: number;
  voiceRangeHigh: number;
  /** Undefined until the learner has answered (the session asks once). */
  headphones: boolean | undefined;
  weeklyTargetDays: number;
  newItemsPerDay: number;
}

export function effectiveSettings(s: SettingsPatch): EffectiveSettings {
  return {
    budgetSec: s.budgetSec ?? DEFAULT_BUDGET_SEC,
    awayBudgetSec: s.awayBudgetSec ?? DEFAULT_AWAY_BUDGET_SEC,
    voiceRangeLow: s.voiceRangeLow ?? DEFAULT_VOICE_LOW,
    voiceRangeHigh: s.voiceRangeHigh ?? DEFAULT_VOICE_HIGH,
    headphones: s.headphones,
    weeklyTargetDays: s.weeklyTargetDays ?? DEFAULT_WEEKLY_TARGET_DAYS,
    newItemsPerDay: s.newItemsPerDay ?? DEFAULT_NEW_ITEM_CAP,
  };
}

export function minutesLabel(budgetSec: number): string {
  return `${String(Math.max(1, Math.round(budgetSec / 60)))} min`;
}

const NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"] as const;

/** MIDI 60 is C4. */
export function noteName(midi: number): string {
  const name = NAMES[((midi % 12) + 12) % 12] ?? "C";
  return `${name}${String(Math.floor(midi / 12) - 1)}`;
}

export interface RangePreset {
  id: "low" | "mid" | "high";
  label: string;
  low: number;
  high: number;
}

export const RANGE_PRESETS: readonly RangePreset[] = [
  { id: "low", label: "Low voice (E2-E4)", low: 40, high: 64 },
  { id: "mid", label: "Mid voice (A2-A4)", low: 45, high: 69 },
  { id: "high", label: "High voice (C3-C5)", low: 48, high: 72 },
];

/** The preset matching a range exactly, if any. */
export function presetFor(low: number, high: number): RangePreset | undefined {
  return RANGE_PRESETS.find((p) => p.low === low && p.high === high);
}

/** Notes offered by the range pickers: C1 to C6 covers any voice. */
export const PICKER_MIDI_MIN = 24;
export const PICKER_MIDI_MAX = 84;

export function rangeError(low: number, high: number): string | undefined {
  if (low >= high) return "The lowest note must be below the highest note.";
  return undefined;
}

/** Only the keys whose value differs from the current effective settings. */
export function settingsDiff(
  current: EffectiveSettings,
  draft: EffectiveSettings,
): SettingsPatch | undefined {
  const patch: SettingsPatch = {};
  if (draft.budgetSec !== current.budgetSec) patch.budgetSec = draft.budgetSec;
  if (draft.awayBudgetSec !== current.awayBudgetSec) patch.awayBudgetSec = draft.awayBudgetSec;
  if (draft.voiceRangeLow !== current.voiceRangeLow) patch.voiceRangeLow = draft.voiceRangeLow;
  if (draft.voiceRangeHigh !== current.voiceRangeHigh) patch.voiceRangeHigh = draft.voiceRangeHigh;
  if (draft.headphones !== undefined && draft.headphones !== current.headphones) {
    patch.headphones = draft.headphones;
  }
  if (draft.weeklyTargetDays !== current.weeklyTargetDays) {
    patch.weeklyTargetDays = draft.weeklyTargetDays;
  }
  if (draft.newItemsPerDay !== current.newItemsPerDay) {
    patch.newItemsPerDay = draft.newItemsPerDay;
  }
  return Object.keys(patch).length === 0 ? undefined : patch;
}

/** Minutes east of UTC (R6), the opposite sign of `getTimezoneOffset()`. */
export function deviceTzOffsetMin(date: Date = new Date()): number {
  return -date.getTimezoneOffset() || 0;
}

export interface TodaySummary {
  day: string;
  minutes: number;
  completed: boolean;
  /** A session started today that has not ended. */
  hasOpenSession: boolean;
}

export function todaySummary(
  state: LearnerState,
  nowMs: number,
  tzOffsetMin: number,
): TodaySummary {
  const day = dayNumberToIso(learnerDayNumber(nowMs, tzOffsetMin));
  const sessions = Object.values(state.sessions).filter((s) => s.day === day);
  return {
    day,
    minutes: Math.round((state.daily[day]?.practiceSec ?? 0) / 60),
    completed: sessions.some((s) => s.endedAt !== undefined),
    hasOpenSession: sessions.some((s) => s.endedAt === undefined),
  };
}

export interface DayCell {
  day: string;
  /** Short weekday label from the learner day itself, so it is timezone independent. */
  weekday: string;
  minutes: number;
  practised: boolean;
  /** 0 = nothing (neutral), 1..3 = increasing time. */
  level: 0 | 1 | 2 | 3;
  isToday: boolean;
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

function levelFor(sec: number): 0 | 1 | 2 | 3 {
  if (sec < PRACTISED_MIN_SEC) return 0;
  if (sec < 5 * 60) return 1;
  if (sec < 10 * 60) return 2;
  return 3;
}

/** The last `count` learner days, oldest first, ending with today. */
export function lastDays(
  state: LearnerState,
  nowMs: number,
  tzOffsetMin: number,
  count: number = WEEK_DAYS,
): DayCell[] {
  const today = learnerDayNumber(nowMs, tzOffsetMin);
  const cells: DayCell[] = [];
  for (let n = today - count + 1; n <= today; n++) {
    const day = dayNumberToIso(n);
    const sec = state.daily[day]?.practiceSec ?? 0;
    cells.push({
      day,
      // Day numbers count days since the epoch; 1970-01-01 was a Thursday.
      weekday: WEEKDAYS[(((n + 4) % 7) + 7) % 7] ?? "",
      minutes: Math.round(sec / 60),
      practised: sec >= PRACTISED_MIN_SEC,
      level: levelFor(sec),
      isToday: n === today,
    });
  }
  return cells;
}

export interface WeekProgress {
  daysPractised: number;
  target: number;
  met: boolean;
}

/** "This week" is the rolling window of the last 7 learner days, the same days the row shows. */
export function weekProgress(cells: readonly DayCell[], target: number): WeekProgress {
  const daysPractised = cells.filter((c) => c.practised).length;
  return { daysPractised, target, met: daysPractised >= target };
}

/** Practise more needs at least one item that has been answered before (it has a card). */
export function hasStartedItems(state: LearnerState): boolean {
  return Object.keys(state.cards).length > 0;
}

/** Clamp a typed value to the allowed new-items range; non-numbers fall back to the default. */
export function clampNewItems(raw: number): number {
  if (!Number.isFinite(raw)) return DEFAULT_NEW_ITEM_CAP;
  return Math.min(NEW_ITEMS_PER_DAY_MAX, Math.max(NEW_ITEMS_PER_DAY_MIN, Math.round(raw)));
}

/** No session has ever been started: show the welcome. */
export function isFirstRun(state: LearnerState): boolean {
  return Object.keys(state.sessions).length === 0;
}
