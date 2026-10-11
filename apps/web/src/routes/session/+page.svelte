<script lang="ts">
  import { onMount } from "svelte";
  import { page } from "$app/state";
  import { resolve } from "$app/paths";
  import Keyboard from "../../lib/components/Keyboard.svelte";
  import ConceptCardView from "../../lib/components/ConceptCard.svelte";
  import { cardById, cardForNode, ORIENT_CARD_ID } from "@clavis/content";
  import type { ConceptCard, ExpectedResponse, StimulusSpec } from "@clavis/core";
  import { INPUT_STORAGE_KEY } from "../../lib/input";
  import { updateState } from "../../lib/pwa/update-state.svelte";
  import type { SessionState } from "../../lib/session/machine";
  import { parseSessionParams, type SessionParams } from "../../lib/session/params";
  import { createSessionRuntime, type SessionRuntime } from "../../lib/session/runtime";

  type Phase = "loading" | "failed" | "ready";

  let phase = $state<Phase>("loading");
  let failure = $state("");
  let params = $state<SessionParams | undefined>();
  let runtime = $state.raw<SessionRuntime | undefined>();
  let view = $state.raw<SessionState>({ kind: "idle" });
  /** Seconds into the session, re-read every second so "time left" ticks. */
  let elapsed = $state(0);
  let expected = $state.raw<ExpectedResponse | undefined>();

  const machine = $derived(runtime?.machine);
  const plan = $derived(view.kind === "idle" ? undefined : machine?.plan);
  const running = $derived(
    view.kind !== "idle" && view.kind !== "summary" && view.kind !== "error",
  );
  const timeLeft = $derived(
    machine && running ? Math.max(0, Math.round(machine.budgetSec - elapsed)) : undefined,
  );
  const showKeyboard = $derived(
    params?.mode === "away" && view.kind === "listening" && view.phase === "play",
  );
  const showPad = $derived(showKeyboard && expected?.play?.kind === "rhythm");

  const orientCard = cardById(ORIENT_CARD_ID);
  /** Show the warm-up card in full the first time; read once so it stays up until Continue. */
  let firstOrient = $state(false);
  /** A card opened with "What's this?". The session is paused underneath while it is open. */
  let openCard = $state.raw<ConceptCard | undefined>();
  let pausedForCard = false;
  const introCard = $derived(view.kind === "intro" ? cardForNode(view.nodeId) : undefined);
  const itemCard = $derived("item" in view ? cardForNode(view.item.nodeId) : undefined);

  function playExample(spec: StimulusSpec): void {
    runtime?.playExample(spec);
  }

  function showCard(card: ConceptCard | undefined): void {
    if (!card || !machine) return;
    if (view.kind !== "paused") {
      machine.pause();
      pausedForCard = true;
    }
    openCard = card;
  }

  function closeCard(): void {
    openCard = undefined;
    if (pausedForCard) {
      pausedForCard = false;
      resume();
    }
  }

  function continueFromOrient(): void {
    runtime?.markOrientCardSeen();
    machine?.next();
  }

  function clock(seconds: number): string {
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return `${String(m)}:${String(s).padStart(2, "0")}`;
  }

  function percent(x: number): string {
    return `${String(Math.round(x * 100))}%`;
  }

  onMount(() => {
    let stored: string | null = null;
    try {
      stored = window.localStorage.getItem(INPUT_STORAGE_KEY);
    } catch {
      // Storage can be blocked; the mode default applies.
    }
    const p = parseSessionParams(page.url.searchParams, stored);
    params = p;

    let off: (() => void) | undefined;
    let current: SessionRuntime | undefined;
    let gone = false;

    function onVisibility(): void {
      if (document.visibilityState === "hidden") current?.machine.pause();
    }

    void createSessionRuntime(p).then((result) => {
      if (gone) {
        if (result.ok) result.runtime.teardown();
        return;
      }
      if (!result.ok) {
        failure = result.message;
        phase = "failed";
        return;
      }
      current = result.runtime;
      runtime = result.runtime;
      firstOrient = !result.runtime.orientCardSeen;
      const m = result.runtime.machine;
      off = m.subscribe((s) => {
        view = s;
        elapsed = m.elapsedSec();
        expected = s.kind === "listening" ? m.debug().expected : undefined;
        // Never swap the app version while a session is open.
        updateState.canUpdateNow = s.kind === "idle" || s.kind === "summary" || s.kind === "error";
      });
      phase = "ready";
    });
    document.addEventListener("visibilitychange", onVisibility);
    const timer = setInterval(() => {
      elapsed = current?.machine.elapsedSec() ?? 0;
    }, 1000);

    return () => {
      gone = true;
      document.removeEventListener("visibilitychange", onVisibility);
      clearInterval(timer);
      off?.();
      current?.teardown();
      updateState.canUpdateNow = true;
    };
  });

  function start(): void {
    // The audio context must be unlocked inside this click handler.
    void runtime?.unlock();
    void machine?.start();
  }

  function resume(): void {
    void runtime?.unlock();
    machine?.resume();
  }
</script>

<svelte:head><title>Session</title></svelte:head>

<div class="session" data-testid="session" data-state={view.kind}>
  {#if phase === "loading"}
    <p>Loading...</p>
  {:else if phase === "failed"}
    <h1>Session</h1>
    <p role="alert">{failure}</p>
  {:else}
    {#if running && machine}
      <header class="bar" aria-label="Session progress">
        <span class="key" data-testid="key">
          {#if plan}Key of the day: <strong>{plan.key.tonic} {plan.key.mode}</strong>{/if}
        </span>
        {#if "item" in view}
          <span data-testid="progress">Item {view.item.position} of {view.item.total}</span>
        {/if}
        {#if timeLeft !== undefined}
          <span data-testid="time-left">{clock(timeLeft)} left</span>
        {/if}
      </header>
    {/if}

    {#if view.kind === "idle"}
      <h1>{params?.mode === "away" ? "Away session" : "Session"}</h1>
      <p>
        {params?.mode === "away"
          ? "A short ear session with no piano. Headphones are best."
          : "A short daily session: warm up, then a few ear exercises."}
      </p>
      <button type="button" class="primary" data-testid="start" onclick={start}>
        Start session
      </button>
      <p><a href={resolve("/")}>Back to home</a></p>
    {:else if view.kind === "headphones"}
      <h1>Using headphones?</h1>
      <p>Headphones keep the piano out of the microphone, so your answers are heard cleanly.</p>
      <div class="stack">
        <button
          type="button"
          class="primary"
          data-testid="headphones-yes"
          onclick={() => machine?.answerHeadphones(true)}>Yes</button
        >
        <button
          type="button"
          class="secondary"
          data-testid="headphones-no"
          onclick={() => machine?.answerHeadphones(false)}>No</button
        >
      </div>
    {:else if view.kind === "preparing"}
      <p class="status" aria-live="polite">Getting ready...</p>
    {:else if openCard && plan}
      <section class="card" data-testid="card-overlay">
        <p class="eyebrow">About this skill</p>
        <ConceptCardView card={openCard} keyOfDay={plan.key} onplay={playExample} />
        <button type="button" class="primary" data-testid="card-close" onclick={closeCard}>
          Back to the session
        </button>
      </section>
    {:else if view.kind === "intro"}
      <section class="card" data-testid="intro">
        <p class="eyebrow">New skill</p>
        {#if introCard && plan}
          <ConceptCardView card={introCard} keyOfDay={plan.key} onplay={playExample} />
        {:else}
          <h1>{view.title}</h1>
          {#if view.description}<p class="lead">{view.description}</p>{/if}
        {/if}
        <button
          type="button"
          class="primary"
          data-testid="continue"
          onclick={() => machine?.next()}
        >
          Continue
        </button>
      </section>
    {:else if view.kind === "orient"}
      <section class="card" data-testid="orient">
        <p class="eyebrow">Warm up</p>
        <h1>Listen to the key</h1>
        <p class="lead">
          {view.playing ? "Hear the key of the day. Settle in." : "Ready when you are."}
        </p>
        {#if firstOrient && orientCard && plan}
          <ConceptCardView card={orientCard} keyOfDay={plan.key} onplay={playExample} />
        {:else if orientCard}
          <button
            type="button"
            class="link left"
            data-testid="whats-this"
            onclick={() => {
              showCard(orientCard);
            }}
          >
            What's this?
          </button>
        {/if}
        <button type="button" class="primary" data-testid="continue" onclick={continueFromOrient}>
          Continue
        </button>
      </section>
    {:else if view.kind === "presenting"}
      <section class="card" data-testid="presenting">
        <p class="prompt" aria-live="polite">{view.prompt}</p>
        <button type="button" class="secondary" data-testid="skip" onclick={() => machine?.skip()}>
          Skip
        </button>
        {#if itemCard}
          <button
            type="button"
            class="link left"
            data-testid="whats-this"
            onclick={() => {
              showCard(itemCard);
            }}
          >
            About this skill
          </button>
        {/if}
      </section>
    {:else if view.kind === "listening"}
      <section class="card" data-testid="listening">
        {#if view.phaseCount > 1}
          <p class="eyebrow">Step {view.phaseIndex + 1} of {view.phaseCount}</p>
        {/if}
        <p class="prompt" aria-live="polite" data-testid="prompt">{view.prompt}</p>
        {#if showPad}
          <button
            type="button"
            class="pad"
            data-testid="tap-pad"
            onpointerdown={(e) => {
              e.preventDefault();
              runtime?.tap?.press(
                expected?.play?.kind === "rhythm" ? (expected.play.pitch ?? 60) : 60,
                e.timeStamp,
              );
            }}>Tap</button
          >
        {/if}
        <div class="row">
          <button
            type="button"
            class="primary"
            data-testid="done"
            onclick={() => machine?.answerDone()}
          >
            Done
          </button>
          <button
            type="button"
            class="secondary"
            data-testid="skip"
            onclick={() => machine?.skip()}
          >
            Skip
          </button>
        </div>
        {#if itemCard}
          <button
            type="button"
            class="link left"
            data-testid="whats-this"
            onclick={() => {
              showCard(itemCard);
            }}
          >
            About this skill
          </button>
        {/if}
      </section>
    {:else if view.kind === "feedback"}
      <section class="card" data-testid="feedback" data-correct={view.feedback.correct}>
        <p class="result" class:good={view.feedback.correct} data-testid="result">
          {view.feedback.correct ? "Correct" : "Not quite"}
        </p>
        {#if view.feedback.lines.length > 0}
          <ul class="issues" data-testid="issues">
            {#each view.feedback.lines as line (line)}<li>{line}</li>{/each}
          </ul>
        {/if}
        {#if !view.feedback.autoAdvance}
          <div class="row">
            {#if view.canReplay}
              <button
                type="button"
                class="secondary"
                data-testid="replay"
                onclick={() => machine?.replay()}
              >
                Replay
              </button>
            {/if}
            <button
              type="button"
              class="primary"
              data-testid="next"
              onclick={() => machine?.next()}
            >
              Next
            </button>
          </div>
          {#if itemCard}
            <button
              type="button"
              class="link left"
              data-testid="whats-this"
              onclick={() => {
                showCard(itemCard);
              }}
            >
              About this skill
            </button>
          {/if}
        {/if}
      </section>
    {:else if view.kind === "paused"}
      <section class="card" data-testid="paused">
        <h1>Paused</h1>
        <p class="lead">The session stopped while the app was in the background.</p>
        <button type="button" class="primary" data-testid="resume" onclick={resume}>Resume</button>
      </section>
    {:else if view.kind === "summary"}
      <section class="card" data-testid="summary">
        <h1>{view.summary.reason === "completed" ? "Session complete" : "Session ended"}</h1>
        <dl class="stats">
          <div>
            <dt>Items</dt>
            <dd data-testid="summary-items">{view.summary.items}</dd>
          </div>
          <div>
            <dt>Accuracy</dt>
            <dd data-testid="summary-accuracy">{percent(view.summary.accuracy)}</dd>
          </div>
          <div>
            <dt>Time</dt>
            <dd data-testid="summary-time">{clock(view.summary.elapsedSec)}</dd>
          </div>
        </dl>
        {#if view.summary.nodeChanges.length > 0}
          <h2>Progress</h2>
          <ul class="issues" data-testid="node-changes">
            {#each view.summary.nodeChanges as c (c.nodeId)}
              <li>{c.title}: {c.from} to {c.to}</li>
            {/each}
          </ul>
        {/if}
        <a class="button" href={resolve("/")} data-testid="home">Back to home</a>
      </section>
    {:else}
      <section class="card">
        <h1>Something went wrong</h1>
        <p role="alert" data-testid="error">{view.message}</p>
        <a class="button" href={resolve("/")}>Back to home</a>
      </section>
    {/if}

    {#if showKeyboard}
      <div class="keys">
        <Keyboard
          low={48}
          high={84}
          focusMidi={60}
          labels="c-only"
          playSound={(midi: number) => runtime?.tone(midi)}
          onpress={(midi: number, ts: number) => runtime?.tap?.press(midi, ts)}
          onrelease={(midi: number, ts: number) => runtime?.tap?.release(midi, ts)}
        />
      </div>
    {/if}

    {#if running && view.kind !== "paused"}
      <p class="finish">
        <button type="button" class="link" data-testid="finish" onclick={() => machine?.finish()}>
          Finish session
        </button>
      </p>
    {/if}
  {/if}
</div>

<style>
  .session {
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
  }

  .bar {
    display: flex;
    flex-wrap: wrap;
    justify-content: space-between;
    gap: var(--space-2) var(--space-4);
    color: var(--color-text-muted);
    font-size: 0.9rem;
  }

  .card {
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
    padding: var(--space-5) var(--space-4);
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-lg);
  }

  .card h1,
  .card h2,
  .card p {
    margin: 0;
  }

  .eyebrow {
    color: var(--color-text-muted);
    font-size: 0.85rem;
    text-transform: uppercase;
    letter-spacing: 0.06em;
  }

  .lead {
    font-size: 1.15rem;
  }

  .prompt {
    font-size: clamp(1.75rem, 8vw, 2.5rem);
    font-weight: 700;
    line-height: 1.15;
    text-align: center;
    padding: var(--space-5) 0;
  }

  .result {
    font-size: 1.75rem;
    font-weight: 700;
    text-align: center;
  }

  .result.good {
    color: var(--color-accent);
  }

  .issues {
    margin: 0;
    padding-left: var(--space-5);
    font-size: 1.1rem;
  }

  .row {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-3);
  }

  .row button {
    flex: 1 1 8rem;
  }

  .stack {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
  }

  button,
  .button {
    min-height: 52px;
    padding: 0 var(--space-5);
    border-radius: var(--radius-md);
    font: inherit;
    font-weight: 600;
    cursor: pointer;
  }

  button.primary {
    border: 1px solid var(--color-accent);
    background: var(--color-accent);
    color: var(--color-accent-contrast);
  }

  button.secondary {
    border: 1px solid var(--color-accent);
    background: transparent;
    color: var(--color-accent);
  }

  button.link {
    min-height: var(--touch-target);
    border: 0;
    background: transparent;
    color: var(--color-text-muted);
    text-decoration: underline;
  }

  button.link.left {
    align-self: flex-start;
    padding: 0;
  }

  .pad {
    min-height: 9rem;
    border: 2px solid var(--color-accent);
    background: var(--color-bg);
    color: var(--color-accent);
    font-size: 1.5rem;
    touch-action: manipulation;
    user-select: none;
    -webkit-user-select: none;
  }

  .stats {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: var(--space-3);
    margin: 0;
    text-align: center;
  }

  .stats dt {
    color: var(--color-text-muted);
    font-size: 0.85rem;
  }

  .stats dd {
    margin: 0;
    font-size: 1.5rem;
    font-weight: 700;
  }

  .finish {
    margin: 0;
    text-align: center;
  }

  .status {
    text-align: center;
    color: var(--color-text-muted);
  }
</style>
