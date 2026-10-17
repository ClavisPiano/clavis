import {
  dayNumberToIso,
  isoToDayNumber,
  weekdayOfDayNumber,
  weekStartDayNumber,
  type LearnerDay,
  type PracticeDay,
  type TrendPoint,
} from "@clavis/core";

/*
 * View models for the Progress page (T6.1, spec 14). Calendar weeks start on Monday. Nothing here
 * counts a streak: a day without practice is an empty, neutral cell.
 */

export const CALENDAR_WEEKS = 12;
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

export interface CalendarCell {
  day: LearnerDay;
  weekday: string;
  /** Whole minutes, 0 when nothing was practised. */
  minutes: number;
  /** 0 = nothing (neutral), 1..3 = increasing time. Same bands as the Home row. */
  level: 0 | 1 | 2 | 3;
  /** After today: drawn as a gap, not as a miss. */
  future: boolean;
  isToday: boolean;
  /** Accessible text, also used as the tooltip. */
  label: string;
}

/** Shading band for the minutes practised in a day. Under a minute is not a practised day. */
export function levelForMinutes(minutes: number): 0 | 1 | 2 | 3 {
  if (minutes < 1) return 0;
  if (minutes < 5) return 1;
  if (minutes < 10) return 2;
  return 3;
}

export function cellLabel(day: LearnerDay, weekday: string, minutes: number, today: boolean) {
  const what = minutes > 0 ? `${String(minutes)} min practised` : "no practice";
  return `${weekday} ${day}: ${what}${today ? ", today" : ""}`;
}

/**
 * The last `weeks` calendar weeks as columns (oldest first), each with seven cells Monday to
 * Sunday, ending with the week that contains `today`.
 */
export function calendarWeeks(
  days: readonly PracticeDay[],
  today: LearnerDay,
  weeks: number = CALENDAR_WEEKS,
): CalendarCell[][] {
  const byDay = new Map(days.map((d) => [d.day, d] as const));
  const todayN = isoToDayNumber(today);
  const firstStart = weekStartDayNumber(todayN, 1) - 7 * (weeks - 1);
  const columns: CalendarCell[][] = [];
  for (let w = 0; w < weeks; w++) {
    const column: CalendarCell[] = [];
    for (let i = 0; i < 7; i++) {
      const n = firstStart + w * 7 + i;
      const day = dayNumberToIso(n);
      const weekday = WEEKDAYS[weekdayOfDayNumber(n)];
      const rec = byDay.get(day);
      const future = n > todayN;
      const practised = rec?.practised === true;
      const minutes = practised ? Math.max(1, Math.round(rec.minutes)) : 0;
      column.push({
        day,
        weekday,
        minutes,
        level: practised ? levelForMinutes(rec.minutes) : 0,
        future,
        isToday: n === todayN,
        label: future ? `${weekday} ${day}: later` : cellLabel(day, weekday, minutes, n === todayN),
      });
    }
    columns.push(column);
  }
  return columns;
}

export interface Spark {
  /** SVG path data: one subpath per run of consecutive weeks that have a value. */
  d: string;
  /** Every defined point, so a lone week still shows. */
  dots: { x: number; y: number; index: number }[];
}

/**
 * A sparkline over `values` (one slot per week, undefined for a week without data) in a
 * `width` x `height` box with `pad` around it. `domain` fixes the vertical range; otherwise it is
 * the data range. A flat series sits in the middle.
 */
export function sparkline(
  values: readonly (number | undefined)[],
  width: number,
  height: number,
  domain?: { min: number; max: number },
  pad = 3,
): Spark {
  const defined = values.filter((v): v is number => v !== undefined);
  const min = domain?.min ?? Math.min(...defined);
  const max = domain?.max ?? Math.max(...defined);
  const span = max - min;
  const step = values.length > 1 ? (width - 2 * pad) / (values.length - 1) : 0;
  const x = (i: number): number => (values.length > 1 ? pad + i * step : width / 2);
  const y = (v: number): number =>
    span <= 0 ? height / 2 : pad + (1 - (v - min) / span) * (height - 2 * pad);
  const dots: Spark["dots"] = [];
  let d = "";
  let open = false;
  values.forEach((v, i) => {
    if (v === undefined) {
      open = false;
      return;
    }
    const px = Math.round(x(i) * 10) / 10;
    const py = Math.round(y(v) * 10) / 10;
    dots.push({ x: px, y: py, index: i });
    d += `${open ? "L" : d === "" ? "M" : " M"}${String(px)} ${String(py)}`;
    open = true;
  });
  return { d, dots };
}

/** One value per calendar week (Monday dates, oldest first), undefined where there is no point. */
export function weeklySeries(
  points: readonly TrendPoint[],
  weekStarts: readonly LearnerDay[],
  pick: (p: TrendPoint) => number | undefined,
): (number | undefined)[] {
  const byWeek = new Map(points.map((p) => [p.week, p] as const));
  return weekStarts.map((w) => {
    const p = byWeek.get(w);
    return p ? pick(p) : undefined;
  });
}

export const STRAND_LABEL: Record<string, string> = {
  EAR: "Ear",
  READ: "Reading",
  HANDS: "Hands",
  BYEAR: "By ear",
  APPLY: "Pieces",
};

export function percentLabel(accuracy: number): string {
  return `${String(Math.round(accuracy * 100))}%`;
}

export function secondsLabel(ms: number): string {
  return `${(ms / 1000).toFixed(1)} s`;
}
