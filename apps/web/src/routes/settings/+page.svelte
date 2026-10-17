<script lang="ts">
  import { onDestroy, onMount } from "svelte";
  import { resolve } from "$app/paths";
  import { MidiAdapter, isMidiSupported, type MidiDeviceInfo } from "@clavis/audio";
  import { createUlidGenerator } from "@clavis/core";
  import AccountSection from "../../lib/account/AccountSection.svelte";
  import { useLearner } from "../../lib/learner.svelte";
  import {
    AWAY_BUDGET_OPTIONS_MIN,
    BUDGET_OPTIONS_MIN,
    NEW_ITEMS_PER_DAY_MAX,
    NEW_ITEMS_PER_DAY_MIN,
    WEEKLY_TARGET_OPTIONS,
    clampNewItems,
    effectiveSettings,
    settingsDiff,
    type EffectiveSettings,
  } from "../../lib/home";
  import { INPUT_STORAGE_KEY, MIDI_INPUT_META_KEY, parseMidiInputId } from "../../lib/input";
  import { createTapCounter, devToolsEnabled, setDevToolsEnabled } from "../../lib/dev-tools";
  import pkg from "../../../package.json";
  import {
    AUTO_CONTINUE_DEFAULT_SEC,
    AUTO_CONTINUE_MAX_SEC,
    AUTO_CONTINUE_META_KEY,
    parseAutoContinueSec,
  } from "../../lib/auto-continue";

  import {
    CUE_META_KEY,
    DEFAULT_CUE,
    HABIT_MAX_CHARS,
    WEEKDAY_LABELS,
    cueError,
    disableCue,
    enableCue,
    isSignedIn,
    parseCueSettings,
    syncCue,
    type CueResult,
    type CueSettings,
    type CueSupport,
  } from "../../lib/practice-cue";
  import { browserCueDeps, readCueSupport } from "../../lib/practice-cue-browser";
  import { isSignedInHint } from "../../lib/sync/hint";

  type InputChoice = "auto" | "mic" | "tap" | "midi";
  const HEADPHONES_META_KEY = "headphones";

  const learner = useLearner();
  let draft = $state<EffectiveSettings | undefined>();
  let inputChoice = $state<InputChoice>("auto");
  /** Seconds before moving on after a correct answer; 0 is off. A device setting, not synced. */
  let autoContinueSec = $state(AUTO_CONTINUE_DEFAULT_SEC);
  let savedAutoContinueSec = AUTO_CONTINUE_DEFAULT_SEC;
  /** Web MIDI exists in this browser (not iOS Safari). Decided on mount, so it is false on the server. */
  let midiSupported = $state(false);
  /** The chosen MIDI input id; "" means every connected input. A device setting, not synced. */
  let midiDevice = $state("");
  let savedMidiDevice = "";
  let midiDevices = $state<MidiDeviceInfo[]>([]);
  let midiProbe: MidiAdapter | undefined;
  let midiProbed = $state(false);
  let saved = $state(false);
  let saveError = $state("");

  // Practice cue (T6.4). Device-local: stored in device meta, not synced.
  let cue = $state<CueSettings>({ ...DEFAULT_CUE });
  let cueSupport = $state<CueSupport>("ok");
  /** Undefined until `/api/me` has answered. */
  let signedIn = $state<boolean | undefined>();
  let permission = $state<NotificationPermission | "unsupported">("default");
  let cueBusy = $state(false);
  let cueMessage = $state("");
  let cueSaved = $state(false);

  /** List the connected keyboards (asks the browser for MIDI access the first time). */
  async function probeMidi(): Promise<void> {
    if (midiProbe || !midiSupported) return;
    const probe = new MidiAdapter({ getContext: () => undefined });
    midiProbe = probe;
    probe.onDevicesChanged((devices) => {
      midiDevices = devices;
    });
    await probe.start();
    midiProbed = probe.available;
  }

  function stopMidiProbe(): void {
    midiProbe?.stop();
    midiProbe = undefined;
  }

  function chooseInput(): void {
    touch();
    if (inputChoice === "midi") void probeMidi();
    else stopMidiProbe();
  }

  onDestroy(stopMidiProbe);

  onMount(async () => {
    midiSupported = isMidiSupported();
    try {
      const stored = localStorage.getItem(INPUT_STORAGE_KEY);
      if (stored === "mic" || stored === "tap") inputChoice = stored;
      if (stored === "midi" && midiSupported) inputChoice = "midi";
    } catch {
      // Storage unavailable: leave on Auto.
    }
    await learner.init();
    void loadCue();
    if (learner.state) draft = effectiveSettings(learner.state.settings);
    if (learner.status === "ready") {
      savedAutoContinueSec = parseAutoContinueSec(
        await learner.ctx.store.getMeta(AUTO_CONTINUE_META_KEY),
      );
      autoContinueSec = savedAutoContinueSec;
      savedMidiDevice =
        parseMidiInputId(await learner.ctx.store.getMeta(MIDI_INPUT_META_KEY)) ?? "";
      midiDevice = savedMidiDevice;
    }
    if (inputChoice === "midi") void probeMidi();
  });

  async function loadCue(): Promise<void> {
    cueSupport = readCueSupport();
    permission = "Notification" in window ? Notification.permission : "unsupported";
    if (learner.status !== "ready") return;
    cue = parseCueSettings(await learner.ctx.store.getMeta(CUE_META_KEY));
    const deps = browserCueDeps();
    signedIn = await isSignedIn(deps, isSignedInHint);
    // The time zone may have changed since the subscription was registered, so refresh the server copy.
    if (cue.enabled && signedIn && cueSupport === "ok" && permission === "granted") {
      void syncCue(deps, cue);
    }
  }

  async function persistCue(next: CueSettings): Promise<void> {
    await learner.ctx.store.setMeta(CUE_META_KEY, $state.snapshot(next));
  }

  function describeCueFailure(result: CueResult): string {
    switch (result.status) {
      case "signin-required":
        return "Reminders need an account, so they can be sent while the app is closed. Sign in first.";
      case "unavailable":
        return "This browser could not set up reminders. Try again in a moment, or open the installed app.";
      case "error":
        return `Could not set up the reminder: ${result.message}`;
      default:
        return "";
    }
  }

  async function toggleCue(on: boolean): Promise<void> {
    if (cueBusy || learner.status !== "ready") return;
    cueBusy = true;
    cueMessage = "";
    cueSaved = false;
    try {
      if (on) {
        const problem = cueError(cue);
        if (problem) {
          cueMessage = problem;
          return;
        }
        // Called straight from the click so the permission prompt keeps its user gesture.
        const result = await enableCue(browserCueDeps(), {
          ...$state.snapshot(cue),
          enabled: true,
        });
        permission = "Notification" in window ? Notification.permission : "unsupported";
        if (result.status === "ok") {
          cue.enabled = true;
          await persistCue(cue);
          cueSaved = true;
        } else {
          cueMessage = describeCueFailure(result);
        }
      } else {
        const result = await disableCue(browserCueDeps());
        cue.enabled = false;
        await persistCue(cue);
        cueSaved = result.status === "ok";
        if (result.status === "error") cueMessage = describeCueFailure(result);
      }
    } finally {
      cueBusy = false;
    }
  }

  async function saveCue(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    if (cueBusy || learner.status !== "ready") return;
    const problem = cueError(cue);
    if (problem) {
      cueMessage = problem;
      return;
    }
    cueBusy = true;
    cueMessage = "";
    cueSaved = false;
    try {
      cue.habit = cue.habit.trim();
      await persistCue(cue);
      if (cue.enabled) {
        const result = await syncCue(browserCueDeps(), $state.snapshot(cue));
        if (result.status !== "ok") {
          cueMessage =
            describeCueFailure(result) || "Saved on this device, but not yet sent to the server.";
          return;
        }
      }
      cueSaved = true;
    } finally {
      cueBusy = false;
    }
  }

  function toggleDay(day: number): void {
    cue.weekdays = cue.weekdays.includes(day)
      ? cue.weekdays.filter((d) => d !== day)
      : [...cue.weekdays, day].sort((a, b) => a - b);
    cueSaved = false;
    cueMessage = "";
  }

  const cueToggleDisabled = $derived(
    cueBusy ||
      learner.status !== "ready" ||
      (!cue.enabled && (cueSupport !== "ok" || signedIn !== true || permission === "denied")),
  );

  const current = $derived(learner.state ? effectiveSettings(learner.state.settings) : undefined);

  function touch(): void {
    saved = false;
    saveError = "";
  }

  async function save(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    if (!draft || !current) return;
    saveError = "";
    try {
      const patch = settingsDiff(current, draft);
      if (patch) {
        const { deviceId, store } = learner.ctx;
        const newId = createUlidGenerator({
          now: () => Date.now(),
          randomBytes: (n) => crypto.getRandomValues(new Uint8Array(n)),
        });
        await learner.append([
          { id: newId(), deviceId, at: Date.now(), type: "settings.changed", v: 2, patch },
        ]);
        // The session runner reads headphones from device meta first.
        if (patch.headphones !== undefined) {
          await store.setMeta(HEADPHONES_META_KEY, patch.headphones);
        }
      }
      if (autoContinueSec !== savedAutoContinueSec) {
        await learner.ctx.store.setMeta(AUTO_CONTINUE_META_KEY, autoContinueSec);
        savedAutoContinueSec = autoContinueSec;
      }
      if (midiDevice !== savedMidiDevice) {
        await learner.ctx.store.setMeta(MIDI_INPUT_META_KEY, midiDevice === "" ? null : midiDevice);
        savedMidiDevice = midiDevice;
      }
      try {
        if (inputChoice === "auto") localStorage.removeItem(INPUT_STORAGE_KEY);
        else localStorage.setItem(INPUT_STORAGE_KEY, inputChoice);
      } catch {
        // Best effort.
      }
      saved = true;
    } catch (e) {
      saveError = `Could not save: ${e instanceof Error ? e.message : String(e)}`;
    }
  }

  /** The commit this build came from and the day it was built, so a stale install is easy to spot. */
  const buildId = __BUILD_ID__;

  const contentVersion = $derived(
    learner.status === "ready" ? learner.ctx.graph.contentVersion : "",
  );

  // Seven quick taps on the version turn on a link to the dev pages (no address bar in a PWA).
  let devTools = $state(false);
  onMount(() => {
    devTools = devToolsEnabled();
  });
  const versionTaps = createTapCounter();
  function tapVersion(): void {
    if (devTools || !versionTaps.tap(performance.now())) return;
    setDevToolsEnabled(true);
    devTools = true;
  }
  function hideDevTools(): void {
    setDevToolsEnabled(false);
    devTools = false;
  }
</script>

<h1>Settings</h1>

{#if learner.status === "failed"}
  <p role="alert">Local storage is unavailable, so settings cannot be saved on this device.</p>
{/if}

{#if draft}
  <form onsubmit={save} data-testid="settings-form">
    <fieldset>
      <legend>Sessions</legend>
      <label>
        Daily session length
        <select
          data-testid="budget"
          value={String(draft.budgetSec / 60)}
          onchange={(e) => {
            if (draft) draft.budgetSec = Number(e.currentTarget.value) * 60;
            touch();
          }}
        >
          {#each BUDGET_OPTIONS_MIN as m (m)}
            <option value={String(m)}>{m} min</option>
          {/each}
        </select>
      </label>
      <label>
        Away session length
        <select
          data-testid="away-budget"
          value={String(draft.awayBudgetSec / 60)}
          onchange={(e) => {
            if (draft) draft.awayBudgetSec = Number(e.currentTarget.value) * 60;
            touch();
          }}
        >
          {#each AWAY_BUDGET_OPTIONS_MIN as m (m)}
            <option value={String(m)}>{m} min</option>
          {/each}
        </select>
      </label>
      <label>
        Weekly target
        <select
          data-testid="weekly-target"
          value={String(draft.weeklyTargetDays)}
          onchange={(e) => {
            if (draft) draft.weeklyTargetDays = Number(e.currentTarget.value);
            touch();
          }}
        >
          {#each WEEKLY_TARGET_OPTIONS as d (d)}
            <option value={String(d)}
              >{d === 1 ? "1 day a week" : `${String(d)} days a week`}</option
            >
          {/each}
        </select>
      </label>
      <label>
        New items per day
        <input
          type="number"
          inputmode="numeric"
          data-testid="new-items-per-day"
          min={NEW_ITEMS_PER_DAY_MIN}
          max={NEW_ITEMS_PER_DAY_MAX}
          step="1"
          value={draft.newItemsPerDay}
          aria-describedby="new-items-help"
          onchange={(e) => {
            if (draft) draft.newItemsPerDay = clampNewItems(e.currentTarget.valueAsNumber);
            e.currentTarget.value = String(draft?.newItemsPerDay ?? "");
            touch();
          }}
        />
      </label>
      <p class="muted" id="new-items-help">
        More new items means faster progress but more to review later.
      </p>
    </fieldset>

    <fieldset>
      <legend>After a correct answer</legend>
      <label>
        Move on to the next exercise
        <select
          data-testid="auto-continue"
          value={String(autoContinueSec)}
          onchange={(e) => {
            autoContinueSec = parseAutoContinueSec(Number(e.currentTarget.value));
            touch();
          }}
        >
          <option value="0">Never, I will tap Next</option>
          {#each Array.from({ length: AUTO_CONTINUE_MAX_SEC }, (_, i) => i + 1) as n (n)}
            <option value={String(n)}>After {n} {n === 1 ? "second" : "seconds"}</option>
          {/each}
        </select>
      </label>
      <p class="muted">A wrong answer always waits for you, so you can read what went wrong.</p>
    </fieldset>

    <fieldset>
      <legend>Audio and input</legend>
      <div class="choice" role="radiogroup" aria-label="Headphones">
        <span>Headphones</span>
        <label class="inline">
          <input
            type="radio"
            name="headphones"
            data-testid="headphones-yes"
            checked={draft.headphones === true}
            onchange={() => {
              if (draft) draft.headphones = true;
              touch();
            }}
          />
          Yes
        </label>
        <label class="inline">
          <input
            type="radio"
            name="headphones"
            data-testid="headphones-no"
            checked={draft.headphones === false}
            onchange={() => {
              if (draft) draft.headphones = false;
              touch();
            }}
          />
          No
        </label>
      </div>
      <label>
        Input
        <select data-testid="input-mode" bind:value={inputChoice} onchange={chooseInput}>
          <option value="auto">Auto</option>
          <option value="mic">Microphone</option>
          <option value="tap">On-screen keyboard</option>
          {#if midiSupported}
            <option value="midi">MIDI keyboard</option>
          {/if}
        </select>
      </label>
      {#if midiSupported && inputChoice === "midi"}
        <label>
          MIDI keyboard
          <select data-testid="midi-device" bind:value={midiDevice} onchange={touch}>
            <option value="">All connected keyboards</option>
            {#each midiDevices as device (device.id)}
              <option value={device.id}>{device.name}</option>
            {/each}
            {#if midiDevice !== "" && !midiDevices.some((d) => d.id === midiDevice)}
              <option value={midiDevice}>Saved keyboard (not connected)</option>
            {/if}
          </select>
        </label>
        <p class="muted" data-testid="midi-help">
          {#if midiProbed && midiDevices.length === 0}
            No MIDI keyboard found. Plug one in and it will appear here.
          {:else if !midiProbed}
            Allow MIDI access in the browser to list your keyboards.
          {:else}
            Played answers use this keyboard, and the on-screen keys keep working. No latency
            calibration is needed.
          {/if}
        </p>
      {/if}
    </fieldset>

    <div class="save-row">
      <button type="submit" class="button" data-testid="save"> Save </button>
      {#if saved}
        <span role="status" data-testid="saved">Saved</span>
      {/if}
      {#if saveError}
        <span role="alert" class="error">{saveError}</span>
      {/if}
    </div>
  </form>
{:else if learner.status === "loading"}
  <p>Loading...</p>
{/if}

<AccountSection />

<section aria-labelledby="cue-heading" data-testid="practice-cue">
  <h2 id="cue-heading">Practice reminder</h2>
  <p class="muted">
    Pick a time and attach practice to something you already do, for example "After my morning
    coffee". We send one notification then, and skip it on days you have already practised. This is
    set per device.
  </p>
  {#if cueSupport === "needs-install"}
    <p data-testid="cue-install-hint">
      On iPhone and iPad, reminders only work once Clavis is added to your Home Screen. In Safari
      tap Share, then Add to Home Screen, then open Clavis from the new icon and come back here.
    </p>
  {:else if cueSupport === "unsupported"}
    <p data-testid="cue-unsupported">This browser does not support notifications for web apps.</p>
  {:else}
    {#if signedIn === false && !cue.enabled}
      <p data-testid="cue-signin">
        Reminders need an account, so they can reach you while the app is closed. Sign in to turn
        them on.
      </p>
    {/if}
    {#if permission === "denied"}
      <p role="alert" class="error" data-testid="cue-blocked">
        Notifications are blocked. Allow them for Clavis in your browser or device settings, then
        come back to turn reminders on.
      </p>
    {/if}
    <form onsubmit={saveCue} class="cue-form">
      <label class="inline">
        <input
          type="checkbox"
          data-testid="cue-enabled"
          checked={cue.enabled}
          disabled={cueToggleDisabled}
          onchange={(e) => {
            void toggleCue(e.currentTarget.checked);
          }}
        />
        Remind me to practise
      </label>
      <label>
        Time
        <input
          type="time"
          data-testid="cue-time"
          value={cue.time}
          onchange={(e) => {
            cue.time = e.currentTarget.value;
            cueSaved = false;
          }}
        />
      </label>
      <fieldset class="days">
        <legend>Days</legend>
        <div class="choice">
          {#each WEEKDAY_LABELS as label, day (day)}
            <label class="inline">
              <input
                type="checkbox"
                data-testid={`cue-day-${String(day)}`}
                checked={cue.weekdays.includes(day)}
                onchange={() => {
                  toggleDay(day);
                }}
              />
              {label}
            </label>
          {/each}
        </div>
      </fieldset>
      <label>
        Habit to attach it to
        <input
          type="text"
          data-testid="cue-habit"
          maxlength={HABIT_MAX_CHARS}
          placeholder="After my morning coffee"
          value={cue.habit}
          oninput={(e) => {
            cue.habit = e.currentTarget.value;
            cueSaved = false;
          }}
        />
      </label>
      <div class="save-row">
        <button type="submit" class="button" data-testid="cue-save" disabled={cueBusy}>
          Save reminder
        </button>
        {#if cueSaved}
          <span role="status" data-testid="cue-saved">Saved</span>
        {/if}
        {#if cueMessage}
          <span role="alert" class="error" data-testid="cue-message">{cueMessage}</span>
        {/if}
      </div>
    </form>
  {/if}
</section>

<h2>Tools</h2>
<ul>
  <li><a href={resolve("/settings/latency")}>Latency calibration</a></li>
  <li>
    <a href={resolve("/placement")} data-testid="rerun-placement">Run placement again</a>
    (only ever raises what you have already reached)
  </li>
  <li><a href={resolve("/dev/state")}>Backup and restore (export or import your data)</a></li>
  {#if devTools}
    <li>
      <a href={resolve("/dev")} data-testid="dev-tools-link">Developer tools</a>
      <button type="button" class="link" data-testid="dev-tools-off" onclick={hideDevTools}>
        Hide
      </button>
    </li>
  {/if}
</ul>

<h2>About</h2>
<p class="muted">
  Clavis version
  <button type="button" class="version" data-testid="app-version" onclick={tapVersion}>
    {pkg.version}
  </button>
  <br />Build <span data-testid="build-id">{buildId}</span>
  {#if contentVersion}
    <br />Content version <span data-testid="content-version">{contentVersion}</span>
  {/if}
</p>

<style>
  .version,
  .link {
    padding: 0;
    border: 0;
    background: none;
    color: inherit;
    font: inherit;
    cursor: pointer;
  }

  .link {
    margin-left: var(--space-2);
    color: var(--color-accent);
    text-decoration: underline;
  }

  fieldset {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    margin: 0 0 var(--space-4);
    padding: var(--space-4);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
  }

  legend {
    padding: 0 var(--space-2);
    font-weight: 700;
  }

  label {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
  }

  label.inline {
    flex-direction: row;
    align-items: center;
    gap: var(--space-2);
    min-height: var(--touch-target);
  }

  .choice {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: var(--space-4);
  }

  select,
  input[type="number"],
  input[type="time"],
  input[type="text"] {
    min-height: var(--touch-target);
    padding: 0 var(--space-3);
    font: inherit;
    color: var(--color-text);
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-sm);
  }

  .cue-form {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    margin-bottom: var(--space-5);
  }

  .days {
    margin: 0;
  }

  .save-row {
    display: flex;
    align-items: center;
    gap: var(--space-4);
    margin-bottom: var(--space-5);
  }

  button.button:disabled {
    opacity: 0.5;
  }

  .error {
    color: var(--color-danger);
    margin: 0;
  }

  .muted {
    color: var(--color-text-muted);
  }
</style>
