<script lang="ts">
  import { wallNow } from "../lib/clock";
  import { resolve } from "$app/paths";
  import { onMount } from "svelte";
  import { readInstallEnv, shouldShowIosInstallHint } from "../lib/pwa/ios";
  import { useLearner } from "../lib/learner.svelte";
  import {
    deviceTzOffsetMin,
    effectiveSettings,
    isFirstRun,
    lastDays,
    minutesLabel,
    todaySummary,
    weekProgress,
  } from "../lib/home";
  import { nextSteps, startWouldBeEmpty } from "../lib/next-steps";
  import PieceCard from "../lib/components/PieceCard.svelte";
  import { appPieces } from "../lib/pieces";
  import { pieceCard } from "../lib/piece-card";
  import { PLACEMENT_SKIPPED_META_KEY, shouldOfferPlacement } from "../lib/placement";
  import { benchmarkMonth, needsBenchmark } from "@clavis/core";
  import { makeBackupFile, saveFile } from "../lib/backup-file";
  import {
    readLastBackup,
    readNudgeDismissed,
    readPersistState,
    recordBackup,
    recordNudgeDismissed,
    shouldNudgeBackup,
    type PersistState,
  } from "../lib/backup-nudge";
  import { isSessionExpired, isSignedInHint } from "../lib/sync/hint";

  const learner = useLearner();
  let now = $state(wallNow());

  const HINT_DISMISSED_KEY = "clavis.install-hint-dismissed";
  let showHint = $state(false);
  /** The signed-in session ended (401), so sync is paused until the person signs in again. */
  let sessionExpired = $state(false);
  /** Undefined until the skip flag has been read, so the offer never flashes and vanishes. */
  let placementSkipped = $state<boolean | undefined>();

  /** T8.1: inputs for the backup card, read once from this device's localStorage. */
  let backupInputs = $state<
    | { persist: PersistState; signedIn: boolean; lastBackupAt?: number; dismissedAt?: number }
    | undefined
  >();
  let backupStatus = $state("");

  function localStore(): Storage | undefined {
    try {
      return localStorage;
    } catch {
      return undefined;
    }
  }

  onMount(() => {
    const local = localStore();
    const lastBackupAt = readLastBackup(local);
    const dismissedAt = readNudgeDismissed(local);
    backupInputs = {
      persist: readPersistState(local),
      signedIn: isSignedInHint(),
      ...(lastBackupAt === undefined ? {} : { lastBackupAt }),
      ...(dismissedAt === undefined ? {} : { dismissedAt }),
    };
    let dismissed = false;
    try {
      dismissed = localStorage.getItem(HINT_DISMISSED_KEY) !== null;
    } catch {
      // Storage unavailable: show the hint every time.
    }
    showHint = !dismissed && shouldShowIosInstallHint(readInstallEnv());
    sessionExpired = isSessionExpired();
    void learner.init().then(async () => {
      now = wallNow();
      try {
        placementSkipped = (await learner.ctx.store.getMeta(PLACEMENT_SKIPPED_META_KEY)) === true;
      } catch {
        placementSkipped = false;
      }
    });
  });

  const snap = $derived(learner.state);
  const settings = $derived(effectiveSettings(snap?.settings ?? {}));
  const firstRun = $derived(snap ? isFirstRun(snap) : false);
  const offerPlacement = $derived(
    snap && placementSkipped !== undefined ? shouldOfferPlacement(snap, placementSkipped) : false,
  );
  const today = $derived(snap ? todaySummary(snap, now, deviceTzOffsetMin()) : undefined);
  /** A plain Start session that would have no items is not promoted (it shows "Nothing is due"). */
  const startEmpty = $derived(
    snap && !firstRun && learner.status === "ready"
      ? startWouldBeEmpty({
          state: snap,
          graph: learner.ctx.graph,
          now,
          tzOffsetMin: deviceTzOffsetMin(),
          mode: "instrument",
          budgetSec: settings.budgetSec,
        })
      : false,
  );
  /** Once today's session is done, or nothing is due, Home promotes Keep going and Learn something new. */
  const steps = $derived(
    snap && (today?.completed === true || startEmpty) && learner.status === "ready"
      ? nextSteps({
          state: snap,
          graph: learner.ctx.graph,
          now,
          tzOffsetMin: deviceTzOffsetMin(),
          mode: "instrument",
          budgetSec: settings.budgetSec,
          elapsedSec: 0,
        })
      : undefined,
  );
  const afterSession = $derived(steps !== undefined && (steps.keepGoing || steps.learn));
  /** Pieces (MP): the current tune, what is played through, and what unlocks the rest. */
  const pieces = $derived(
    snap && !firstRun && learner.status === "ready"
      ? pieceCard(appPieces(snap), snap, learner.ctx.graph)
      : undefined,
  );
  /** Once a month (T6.5): prompt for a benchmark while this month has none. */
  const benchmarkDue = $derived(
    snap && !firstRun ? needsBenchmark(snap, benchmarkMonth(now, deviceTzOffsetMin())) : false,
  );
  const backupNudge = $derived(
    snap && backupInputs && !firstRun
      ? shouldNudgeBackup({
          now,
          signedIn: backupInputs.signedIn,
          persist: backupInputs.persist,
          eventCount: snap.eventCount,
          lastBackupAt: backupInputs.lastBackupAt,
          dismissedAt: backupInputs.dismissedAt,
        })
      : false,
  );
  const cells = $derived(snap ? lastDays(snap, now, deviceTzOffsetMin()) : []);
  const week = $derived(weekProgress(cells, settings.weeklyTargetDays));

  async function skipPlacement() {
    placementSkipped = true;
    try {
      await learner.ctx.store.setMeta(PLACEMENT_SKIPPED_META_KEY, true);
    } catch {
      // Best effort: the offer comes back next time.
    }
  }

  async function backUpNow() {
    backupStatus = "";
    try {
      const { store, deviceId, graph } = learner.ctx;
      const { file } = await makeBackupFile({
        store,
        deviceId,
        contentVersion: graph.contentVersion,
      });
      saveFile(file);
      const at = wallNow();
      recordBackup(localStore(), at);
      if (backupInputs) backupInputs = { ...backupInputs, lastBackupAt: at };
      now = at;
    } catch {
      backupStatus = "The backup could not be saved. Try again.";
    }
  }

  function snoozeBackup() {
    const at = wallNow();
    recordNudgeDismissed(localStore(), at);
    if (backupInputs) backupInputs = { ...backupInputs, dismissedAt: at };
    now = at;
  }

  function dismiss() {
    showHint = false;
    try {
      localStorage.setItem(HINT_DISMISSED_KEY, "1");
    } catch {
      // Best effort.
    }
  }
</script>

<svelte:head><title>Clavis</title></svelte:head>

{#if showHint}
  <aside class="hint" aria-label="Install hint">
    <p>
      Add Clavis to your Home Screen for reliable offline use.
      <a href={resolve("/install")}>How to install</a>
    </p>
    <button type="button" onclick={dismiss}>Dismiss</button>
  </aside>
{/if}

<h1>Clavis</h1>

{#if sessionExpired}
  <section class="card" data-testid="session-expired" aria-labelledby="expired-h">
    <h2 id="expired-h">Sync is paused</h2>
    <p>
      Your sign-in has expired, so practice is no longer being backed up. It is still saved on this
      device. <a href={resolve("/settings")}>Sign in to resume sync</a>.
    </p>
  </section>
{/if}

{#if firstRun}
  <section class="card" data-testid="welcome" aria-labelledby="welcome-h">
    <h2 id="welcome-h">Welcome</h2>
    <p>
      A session is a short, focused run of ear and piano exercises. You listen, then play it back.
      Clavis checks what you played and picks what to practise next. A few minutes a day is enough.
    </p>
    <p>
      Choose how you play (a MIDI keyboard, the microphone or the on-screen keys) in
      <a href={resolve("/settings")}>Settings</a>.
    </p>
  </section>
{/if}

{#if offerPlacement}
  <section class="card" data-testid="placement-offer" aria-labelledby="placement-h">
    <h2 id="placement-h">Find your starting point</h2>
    <p>
      A placement of about five minutes at your piano sets where you start, so you skip what you
      already know. You can run it later from Settings.
    </p>
    <div class="offer-actions">
      <a class="button primary" href={resolve("/placement")} data-testid="placement-begin">
        <strong>Start placement</strong>
      </a>
      <button
        type="button"
        class="skip-offer"
        data-testid="placement-skip"
        onclick={() => void skipPlacement()}
      >
        Skip for now
      </button>
    </div>
  </section>
{/if}

<div class="actions">
  {#if afterSession && steps}
    {#if steps.keepGoing}
      <a class="button primary" href={resolve("/session?practice=1")} data-testid="keep-going">
        <strong>Keep going</strong>
        <span
          >{minutesLabel(steps.keepGoingSec)} of extra practice, your review schedule stays as it is</span
        >
      </a>
    {/if}
    {#if steps.learn}
      <a
        class="button"
        class:primary={!steps.keepGoing}
        class:secondary={steps.keepGoing}
        href={resolve("/session?learn=1")}
        data-testid="learn-more"
      >
        <strong>Learn something new</strong>
        <span>One more batch of new items</span>
      </a>
    {/if}
  {/if}
  <a
    class="button"
    class:primary={!afterSession}
    class:secondary={afterSession}
    href={resolve("/session")}
    data-testid="start-session"
  >
    <strong>Start session</strong>
    <span>{startEmpty ? "Nothing is due right now" : minutesLabel(settings.budgetSec)}</span>
  </a>
  <a class="button secondary" href={resolve("/session?mode=away")} data-testid="start-away">
    <strong>Away session</strong>
    <span>{minutesLabel(settings.awayBudgetSec)}, no piano needed</span>
  </a>
  {#if !firstRun}
    <a class="button secondary" href={resolve("/practice")} data-testid="choose-practice">
      <strong>Practise a skill</strong>
      <span>Choose what to drill</span>
    </a>
    <a class="button secondary" href={resolve("/keyboard")} data-testid="open-keyboard">
      <strong>Keyboard</strong>
      <span>Play and hear the key of the day, any time</span>
    </a>
  {/if}
</div>

{#if pieces}
  <PieceCard card={pieces} />
{/if}

{#if benchmarkDue}
  <section class="card" data-testid="benchmark-prompt" aria-labelledby="benchmark-h">
    <h2 id="benchmark-h">Monthly benchmark</h2>
    <p>
      Record yourself playing one piece, start to finish. Next to earlier months, you can hear how
      far you have come.
    </p>
    <a href={resolve("/progress/benchmarks/record")} data-testid="benchmark-record-link"
      >Record this month's benchmark</a
    >
  </section>
{/if}

{#if backupNudge}
  <section class="card" data-testid="backup-nudge" aria-labelledby="backup-h">
    <h2 id="backup-h">Back up your practice</h2>
    <p>
      Your practice is stored only in this browser, which can clear it without warning. Save a
      backup file, or <a href={resolve("/settings")}>create an account</a> to keep a copy online.
    </p>
    <div class="offer-actions">
      <button
        type="button"
        class="button primary"
        data-testid="backup-now"
        onclick={() => void backUpNow()}
      >
        <strong>Save a backup</strong>
      </button>
      <button type="button" class="skip-offer" data-testid="backup-snooze" onclick={snoozeBackup}>
        Not now
      </button>
    </div>
    {#if backupStatus}<p role="status">{backupStatus}</p>{/if}
  </section>
{/if}

{#if snap && today && !firstRun}
  <section class="card" aria-labelledby="today-h">
    <h2 id="today-h">Today</h2>
    <p data-testid="today-status">
      {#if today.completed}
        Session done today.
      {:else}
        No session finished yet today.
      {/if}
      {today.minutes} min practised.
    </p>
    {#if today.hasOpenSession}
      <p data-testid="resume-note">
        A session was started but not finished.
        <a href={resolve("/session")}>Resume or start fresh</a>
      </p>
    {/if}
  </section>

  <section class="card" aria-labelledby="week-h">
    <h2 id="week-h">Last 7 days</h2>
    <ol class="days" data-testid="days">
      {#each cells as cell (cell.day)}
        <li
          class="day level-{cell.level}"
          class:today={cell.isToday}
          data-testid="day-cell"
          data-level={cell.level}
          aria-label="{cell.weekday} {cell.day}: {cell.minutes} min{cell.isToday ? ', today' : ''}"
        >
          <span class="wd">{cell.weekday}</span>
          <span class="min">{cell.minutes > 0 ? cell.minutes : ""}</span>
        </li>
      {/each}
    </ol>
    <p class="muted" data-testid="week-progress">
      This week: {week.daysPractised} of {week.target} days
    </p>
    <p>
      <a href={resolve("/progress")} data-testid="see-progress">See your progress</a>
    </p>
  </section>
{/if}

<style>
  .hint {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    padding: var(--space-3) var(--space-4);
    margin-bottom: var(--space-5);
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
  }

  .hint p {
    flex: 1;
    margin: 0;
  }

  .hint button {
    min-height: var(--touch-target);
    padding: 0 var(--space-4);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    background: transparent;
    color: var(--color-text);
    font: inherit;
  }

  .actions {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    margin-bottom: var(--space-5);
  }

  .button {
    flex-direction: column;
    padding: var(--space-3) var(--space-4);
    font-weight: 400;
  }

  .button strong {
    font-weight: 700;
  }

  .button.primary {
    font-size: 1.125rem;
  }

  .offer-actions {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-3);
    margin-top: var(--space-3);
  }

  .skip-offer {
    min-height: var(--touch-target);
    padding: 0 var(--space-4);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    background: transparent;
    color: var(--color-text);
    font: inherit;
  }

  .card {
    padding: var(--space-4);
    margin-bottom: var(--space-4);
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
  }

  .card h2 {
    font-size: 1.125rem;
  }

  .card p:last-child {
    margin-bottom: 0;
  }

  .muted {
    color: var(--color-text-muted);
  }

  .days {
    display: grid;
    grid-template-columns: repeat(7, 1fr);
    gap: var(--space-1);
    list-style: none;
    padding: 0;
    margin: 0 0 var(--space-3);
  }

  .day {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: space-between;
    min-height: 3.5rem;
    padding: var(--space-1);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-sm);
    font-size: 0.75rem;
    color: var(--color-text-muted);
  }

  .day.today {
    border-color: var(--color-text);
  }

  /* The muted text colour is too faint on a tinted day (contrast fails in dark mode). */
  .day.level-1 {
    background: color-mix(in srgb, var(--color-accent) 25%, var(--color-surface));
    color: var(--color-text);
  }

  .day.level-2 {
    background: color-mix(in srgb, var(--color-accent) 55%, var(--color-surface));
    color: var(--color-text);
  }

  .day.level-3 {
    background: var(--color-accent);
    color: var(--color-accent-contrast);
  }

  .day .min {
    font-weight: 700;
    min-height: 1em;
  }
</style>
