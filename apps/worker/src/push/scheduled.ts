import { learnerDay } from "@clavis/core";
import { d1Sql } from "../auth/sql";
import type { Env } from "../env";
import { CRON_INTERVAL_MIN, CUE_WINDOW_MIN, dueSubscriptions, minutesSinceCue } from "./due";
import { isAcceptableEndpoint } from "./endpoint";
import { createPushRepo, type PushSubscriptionRow } from "./repo";
import { sendWebPush, type VapidKeys } from "./webpush";

/**
 * Each push is one subrequest, and the free plan allows 50 per invocation (the D1 reads and the one
 * batched write count too). Anything over the cap is sent by the next run, because a cue stays due
 * for two runs (`CUE_WINDOW_MIN`). Raise this when moving to a paid plan.
 */
export const MAX_SENDS_PER_RUN = 40;

export const CUE_TITLE = "Time to practise";
export const CUE_DEFAULT_BODY = "Your short daily session is ready.";

export interface CueRunResult {
  due: number;
  sent: number;
  pruned: number;
  failed: number;
  /** Due cues left for the next run because this one hit `MAX_SENDS_PER_RUN`. */
  deferred: number;
  /** Deferred cues whose window closes before the next run, so they will never be sent. */
  dropped: number;
}

export interface CueRunOptions {
  nowMs: number;
  fetch?: typeof fetch;
}

/** Send today's practice cues that are due at `nowMs`. Called from the cron `scheduled` handler. */
export async function runPracticeCues(env: Env, options: CueRunOptions): Promise<CueRunResult> {
  const result: CueRunResult = { due: 0, sent: 0, pruned: 0, failed: 0, deferred: 0, dropped: 0 };
  if (!env.VAPID_PRIVATE_KEY || !env.VAPID_PUBLIC_KEY || !env.VAPID_SUBJECT) {
    console.warn("practice cue: VAPID keys are not configured, skipping");
    return result;
  }
  const keys: VapidKeys = {
    publicKey: env.VAPID_PUBLIC_KEY,
    privateKey: env.VAPID_PRIVATE_KEY,
    subject: env.VAPID_SUBJECT,
  };
  const repo = createPushRepo(d1Sql(env.DB));
  // Only rows near their cue time are read. Rows stored before the push service allowlist existed
  // are never sent to; they are dropped when they come up.
  const allowed: PushSubscriptionRow[] = [];
  const gone: string[] = [];
  for (const row of await repo.listNearDue(options.nowMs)) {
    if (isAcceptableEndpoint(row.endpoint)) allowed.push(row);
    else gone.push(row.endpoint);
  }
  const due = dueSubscriptions(allowed, options.nowMs);
  result.due = due.length;
  const batch = due.slice(0, MAX_SENDS_PER_RUN);
  const over = due.slice(MAX_SENDS_PER_RUN);
  result.deferred = over.length;
  result.dropped = over.filter(
    (row) => (minutesSinceCue(row, options.nowMs) ?? 0) + CRON_INTERVAL_MIN >= CUE_WINDOW_MIN,
  ).length;
  if (result.dropped > 0) {
    console.warn(`practice cue: ${String(result.dropped)} cues will miss their window (send cap)`);
  }
  const sent: { endpoint: string; day: string }[] = [];
  const outcomes = await Promise.all(
    batch.map((sub) =>
      sendWebPush(sub, { title: CUE_TITLE, body: sub.habit || CUE_DEFAULT_BODY, url: "/" }, keys, {
        nowMs: options.nowMs,
        ...(options.fetch ? { fetch: options.fetch } : {}),
      }),
    ),
  );
  batch.forEach((sub, i) => {
    const outcome = outcomes[i];
    if (outcome?.kind === "sent") {
      sent.push({ endpoint: sub.endpoint, day: learnerDay(options.nowMs, sub.tzOffsetMin) });
    } else if (outcome?.kind === "gone") {
      gone.push(sub.endpoint);
    } else {
      result.failed += 1;
    }
  });
  await repo.applySendResults(sent, gone);
  result.sent = sent.length;
  result.pruned = gone.length;
  return result;
}
