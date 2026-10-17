<script lang="ts">
  import { onDestroy, onMount } from "svelte";
  import { resolve } from "$app/paths";
  import { MidiAdapter, isMidiSupported, type MidiDeviceInfo } from "@clavis/audio";
  import { createUlidGenerator } from "@clavis/core";
  import { useLearner } from "../../lib/learner.svelte";
  import {
    AWAY_BUDGET_OPTIONS_MIN,
    BUDGET_OPTIONS_MIN,
    PICKER_MIDI_MAX,
    PICKER_MIDI_MIN,
    RANGE_PRESETS,
    NEW_ITEMS_PER_DAY_MAX,
    NEW_ITEMS_PER_DAY_MIN,
    WEEKLY_TARGET_OPTIONS,
    clampNewItems,
    effectiveSettings,
    noteName,
    presetFor,
    rangeError,
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

  const notes = Array.from(
    { length: PICKER_MIDI_MAX - PICKER_MIDI_MIN + 1 },
    (_, i) => PICKER_MIDI_MIN + i,
  );

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

  const current = $derived(learner.state ? effectiveSettings(learner.state.settings) : undefined);
  const error = $derived(draft ? rangeError(draft.voiceRangeLow, draft.voiceRangeHigh) : undefined);
  const preset = $derived(draft ? presetFor(draft.voiceRangeLow, draft.voiceRangeHigh) : undefined);

  function touch(): void {
    saved = false;
    saveError = "";
  }

  function applyPreset(id: string): void {
    const p = RANGE_PRESETS.find((r) => r.id === id);
    if (!p || !draft) return;
    draft.voiceRangeLow = p.low;
    draft.voiceRangeHigh = p.high;
    touch();
  }

  async function save(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    if (!draft || !current || error) return;
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
      <legend>Voice range</legend>
      <label>
        Preset
        <select
          data-testid="range-preset"
          value={preset?.id ?? "custom"}
          onchange={(e) => {
            applyPreset(e.currentTarget.value);
          }}
        >
          {#each RANGE_PRESETS as p (p.id)}
            <option value={p.id}>{p.label}</option>
          {/each}
          {#if !preset}<option value="custom">Custom</option>{/if}
        </select>
      </label>
      <label>
        Lowest note
        <select
          data-testid="range-low"
          value={String(draft.voiceRangeLow)}
          onchange={(e) => {
            if (draft) draft.voiceRangeLow = Number(e.currentTarget.value);
            touch();
          }}
        >
          {#each notes as n (n)}
            <option value={String(n)}>{noteName(n)}</option>
          {/each}
        </select>
      </label>
      <label>
        Highest note
        <select
          data-testid="range-high"
          value={String(draft.voiceRangeHigh)}
          onchange={(e) => {
            if (draft) draft.voiceRangeHigh = Number(e.currentTarget.value);
            touch();
          }}
        >
          {#each notes as n (n)}
            <option value={String(n)}>{noteName(n)}</option>
          {/each}
        </select>
      </label>
      {#if error}
        <p role="alert" class="error" data-testid="range-error">{error}</p>
      {/if}
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
            Played answers use this keyboard. Singing still uses the microphone, and the on-screen
            keys keep working. No latency calibration is needed.
          {/if}
        </p>
      {/if}
    </fieldset>

    <div class="save-row">
      <button type="submit" class="button" data-testid="save" disabled={error !== undefined}>
        Save
      </button>
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
  input[type="number"] {
    min-height: var(--touch-target);
    padding: 0 var(--space-3);
    font: inherit;
    color: var(--color-text);
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-sm);
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
