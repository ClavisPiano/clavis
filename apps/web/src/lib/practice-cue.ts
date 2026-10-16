/**
 * Practice cue (spec 14, T6.4): a daily push notification at a time the learner picks, tied to an
 * existing habit (an implementation intention).
 *
 * The cue settings are DEVICE-LOCAL (device meta, never synced as `settings.changed`). A push
 * subscription belongs to one browser on one device, and the time of day and habit that suit a
 * phone need not suit a laptop, so each device keeps its own cue. Synced settings would also
 * force a new `settings.changed` version for something other devices could not act on. The
 * Worker stores a copy of the settings with the subscription so it can decide when to send.
 *
 * Everything here takes its browser dependencies as arguments so it can be tested without a
 * browser. The real wiring is in `practice-cue-browser.ts`.
 */
import { learnerDay, type LearnerState } from "@clavis/core";
import { PRACTISED_MIN_SEC } from "./home";
import { isIos, isStandalone, type InstallEnv } from "./pwa/ios";

export const CUE_META_KEY = "practiceCue";
/** Learner day (YYYY-MM-DD) last reported to the Worker as practised. Device-local. */
export const CUE_REPORTED_META_KEY = "practiceCueReportedDay";
export const HABIT_MAX_CHARS = 60;

export interface CueSettings {
  enabled: boolean;
  /** Local time "HH:MM". */
  time: string;
  /** 0 = Sunday ... 6 = Saturday. Sorted, unique. */
  weekdays: number[];
  habit: string;
}

export const DEFAULT_CUE: CueSettings = {
  enabled: false,
  time: "08:00",
  weekdays: [0, 1, 2, 3, 4, 5, 6],
  habit: "",
};

export const WEEKDAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

/** A stored value, or the defaults for anything missing or invalid. Never throws. */
export function parseCueSettings(raw: unknown): CueSettings {
  if (typeof raw !== "object" || raw === null) return { ...DEFAULT_CUE };
  const r = raw as Record<string, unknown>;
  const days = Array.isArray(r.weekdays)
    ? [...new Set(r.weekdays.filter((d): d is number => Number.isInteger(d) && d >= 0 && d <= 6))]
    : DEFAULT_CUE.weekdays;
  return {
    enabled: r.enabled === true,
    time: typeof r.time === "string" && TIME_RE.test(r.time) ? r.time : DEFAULT_CUE.time,
    weekdays: days.sort((a, b) => a - b),
    habit: typeof r.habit === "string" ? r.habit.trim().slice(0, HABIT_MAX_CHARS) : "",
  };
}

/** A message for the first thing wrong with the settings, or undefined when they are valid. */
export function cueError(cue: CueSettings): string | undefined {
  if (!TIME_RE.test(cue.time)) return "Choose a time for the reminder.";
  if (cue.weekdays.length === 0) return "Choose at least one day.";
  if (cue.habit.trim().length > HABIT_MAX_CHARS) {
    return `Keep the habit to ${String(HABIT_MAX_CHARS)} characters or fewer.`;
  }
  return undefined;
}

export type CueSupport = "ok" | "needs-install" | "unsupported";

export interface SupportEnv {
  hasServiceWorker: boolean;
  hasPushManager: boolean;
  hasNotification: boolean;
  install: InstallEnv;
}

/**
 * iOS only delivers web push to an app installed to the home screen, and a Safari tab has no
 * `PushManager` at all, so check for that case first and explain it rather than saying "unsupported".
 */
export function cueSupport(env: SupportEnv): CueSupport {
  if (isIos(env.install) && !isStandalone(env.install)) return "needs-install";
  if (!env.hasServiceWorker || !env.hasPushManager || !env.hasNotification) return "unsupported";
  return "ok";
}

export interface PushSubscriptionLike {
  endpoint: string;
  toJSON(): { endpoint?: string | undefined; keys?: Record<string, string> | undefined };
  unsubscribe(): Promise<boolean>;
}

export interface PushRegistrationLike {
  pushManager: {
    getSubscription(): Promise<PushSubscriptionLike | null>;
    subscribe(options: {
      userVisibleOnly: boolean;
      applicationServerKey: Uint8Array<ArrayBuffer>;
    }): Promise<PushSubscriptionLike>;
  };
}

export interface CueDeps {
  fetch: typeof fetch;
  /** The service worker registration, or undefined when there is none. */
  getRegistration(): Promise<PushRegistrationLike | undefined>;
  permission(): NotificationPermission;
  requestPermission(): Promise<NotificationPermission>;
  /** Minutes east of UTC (R6). */
  tzOffsetMin(): number;
}

export type CueResult =
  | { status: "ok" }
  /** Notification permission is denied (now, or earlier). The browser will not ask again. */
  | { status: "blocked" }
  /** No session: reminders need an account. */
  | { status: "signin-required" }
  | { status: "unavailable" }
  | { status: "error"; message: string };

function base64UrlToBytes(text: string): Uint8Array<ArrayBuffer> {
  const padded =
    text.replaceAll("-", "+").replaceAll("_", "/") + "=".repeat((4 - (text.length % 4)) % 4);
  const bin = atob(padded);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

const JSON_HEADERS = { "content-type": "application/json" };

async function send(deps: CueDeps, method: string, path: string, body: unknown): Promise<Response> {
  return deps.fetch(path, { method, headers: JSON_HEADERS, body: JSON.stringify(body) });
}

/** True when a session exists (`GET /api/me`). Network failure counts as not known, so false. */
export async function isSignedIn(deps: Pick<CueDeps, "fetch">): Promise<boolean> {
  try {
    return (await deps.fetch("/api/me")).ok;
  } catch {
    return false;
  }
}

/** Send the subscription, cue settings and time zone offset to the Worker. */
async function upload(
  deps: CueDeps,
  subscription: PushSubscriptionLike,
  cue: CueSettings,
): Promise<CueResult> {
  const json = subscription.toJSON();
  const keys = json.keys;
  if (!keys?.p256dh || !keys.auth) return { status: "unavailable" };
  const res = await send(deps, "PUT", "/api/push/subscription", {
    subscription: {
      endpoint: subscription.endpoint,
      keys: { p256dh: keys.p256dh, auth: keys.auth },
    },
    cue: { time: cue.time, weekdays: cue.weekdays, habit: cue.habit.trim() },
    tzOffsetMin: deps.tzOffsetMin(),
  });
  if (res.status === 401) return { status: "signin-required" };
  if (!res.ok)
    return { status: "error", message: `The server refused the reminder (${String(res.status)}).` };
  return { status: "ok" };
}

/**
 * Turn the cue on: ask for notification permission, subscribe this browser to push, and register
 * the subscription with the Worker. Call it straight from the click handler so the permission
 * prompt keeps its user gesture (iOS requires that).
 */
export async function enableCue(deps: CueDeps, cue: CueSettings): Promise<CueResult> {
  try {
    let permission = deps.permission();
    if (permission === "default") permission = await deps.requestPermission();
    if (permission !== "granted") return { status: "blocked" };

    const registration = await deps.getRegistration();
    if (!registration) return { status: "unavailable" };

    let subscription = await registration.pushManager.getSubscription();
    if (!subscription) {
      const keyRes = await deps.fetch("/api/push/key");
      if (!keyRes.ok) return { status: "unavailable" };
      const { publicKey } = (await keyRes.json()) as { publicKey?: unknown };
      if (typeof publicKey !== "string") return { status: "unavailable" };
      subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: base64UrlToBytes(publicKey),
      });
    }
    return await upload(deps, subscription, cue);
  } catch (e) {
    return { status: "error", message: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Re-send the current settings (changed time, days or habit, or a new time zone) for an existing
 * subscription. Does nothing when this browser has no subscription or permission.
 */
export async function syncCue(deps: CueDeps, cue: CueSettings): Promise<CueResult> {
  try {
    if (deps.permission() !== "granted") return { status: "blocked" };
    const subscription = await (await deps.getRegistration())?.pushManager.getSubscription();
    if (!subscription) return { status: "unavailable" };
    return await upload(deps, subscription, cue);
  } catch (e) {
    return { status: "error", message: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Turn the cue off: tell the Worker to forget this device, then unsubscribe locally. The local
 * unsubscribe happens even when the Worker cannot be reached (it will prune the dead endpoint on
 * its next send).
 */
export async function disableCue(deps: CueDeps): Promise<CueResult> {
  try {
    const subscription = await (await deps.getRegistration())?.pushManager.getSubscription();
    if (!subscription) return { status: "ok" };
    try {
      await send(deps, "DELETE", "/api/push/subscription", { endpoint: subscription.endpoint });
    } catch {
      // Offline: the Worker prunes the endpoint once the push service reports it gone.
    }
    await subscription.unsubscribe();
    return { status: "ok" };
  } catch (e) {
    return { status: "error", message: e instanceof Error ? e.message : String(e) };
  }
}

/** The learner day when it counts as practised (at least a minute of session time), else undefined. */
export function practisedDay(
  state: Pick<LearnerState, "daily">,
  nowMs: number,
  tzOffsetMin: number,
): string | undefined {
  const day = learnerDay(nowMs, tzOffsetMin);
  return (state.daily[day]?.practiceSec ?? 0) >= PRACTISED_MIN_SEC ? day : undefined;
}

export interface ReportDeps {
  fetch: typeof fetch;
  getMeta(key: string): Promise<unknown>;
  setMeta(key: string, value: unknown): Promise<void>;
  tzOffsetMin(): number;
}

export type ReportOutcome = "reported" | "skipped" | "failed";

/**
 * Tell the Worker the learner practised today so today's cue is skipped. Only runs when this
 * device has the cue enabled and today counts as practised, and reports each day once (a failed
 * report, for example offline, is retried the next time this is called).
 */
export async function reportPractisedIfNeeded(
  deps: ReportDeps,
  state: Pick<LearnerState, "daily">,
  nowMs: number,
): Promise<ReportOutcome> {
  const day = practisedDay(state, nowMs, deps.tzOffsetMin());
  if (day === undefined) return "skipped";
  try {
    if (!parseCueSettings(await deps.getMeta(CUE_META_KEY)).enabled) return "skipped";
    if ((await deps.getMeta(CUE_REPORTED_META_KEY)) === day) return "skipped";
    const res = await deps.fetch("/api/push/practised", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ day }),
    });
    // 401 means signed out: nothing to skip server side, so do not keep retrying today.
    if (!res.ok && res.status !== 401) return "failed";
    await deps.setMeta(CUE_REPORTED_META_KEY, day);
    return res.ok ? "reported" : "skipped";
  } catch {
    return "failed";
  }
}
