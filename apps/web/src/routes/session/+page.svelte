<script lang="ts">
  import { onMount } from "svelte";
  import { page } from "$app/state";
  import { resolve } from "$app/paths";
  import NotationView from "../../lib/components/NotationView.svelte";
  import Keyboard from "../../lib/components/Keyboard.svelte";
  import ConceptCardView from "../../lib/components/ConceptCard.svelte";
  import { cardById, cardForNode, ORIENT_CARD_ID } from "@clavis/content";
  import type { ConceptCard, ExpectedResponse, StimulusSpec } from "@clavis/core";
  import { awayKeyboard } from "../../lib/keyboard";
  import { INPUT_STORAGE_KEY } from "../../lib/input";
  import { updateState } from "../../lib/pwa/update-state.svelte";
  import type { SessionState } from "../../lib/session/machine";
  import type { KeyNotes } from "../../lib/session/key-notes";
  import { parseSessionParams, type SessionParams } from "../../lib/session/params";
  import { createSessionRuntime, type SessionRuntime } from "../../lib/session/runtime";
  import { followUpSearch } from "../../lib/next-steps";
  import { minutesLabel } from "../../lib/home";

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
    view.kind !== "idle" &&
      view.kind !== "summary" &&
      view.kind !== "error" &&
      view.kind !== "nothing",
  );
  const timeLeft = $derived(
    machine && running ? Math.max(0, Math.round(machine.budgetSec - elapsed)) : undefined,
  );
  /** The piece a whole-piece run just finished (MP), for the summary. */
  const runResult = $derived.by(() => {
    if (view.kind !== "summary" || !view.summary.run) return undefined;
    const run = view.summary.run;
    return { ...run, title: runtime?.pieceTitle(run.pieceId) ?? "the piece" };
  });
  /** After the session, or on the Nothing-due screen: what else to offer today. */
  const steps = $derived(
    runtime && view.kind === "summary"
      ? runtime.nextSteps(view.summary.elapsedSec)
      : runtime && view.kind === "nothing"
        ? runtime.nextSteps(0)
        : undefined,
  );
  const keepGoingSearch = $derived(
    steps ? followUpSearch(page.url.searchParams, "practice", steps.keepGoingSec) : "",
  );
  const learnSearch = $derived(steps ? followUpSearch(page.url.searchParams, "learn") : "");
  // resolve() has no typed form for a query string, so the base path is resolved and the query is
  // appended. The links reload the page (data-sveltekit-reload) to start a fresh session.
  const keepGoingHref = $derived(resolve("/session") + keepGoingSearch);
  const learnHref = $derived(resolve("/session") + learnSearch);
  /** Buttons to answer a choice item (R21), in both modes. They replace the keyboard. */
  const choices = $derived(view.kind === "listening" ? view.item.choices : undefined);
  // The on-screen keyboard answers like the external one: it is the only input in Away mode, and an
  // extra one at the piano, so the learner can practise anywhere.
  const showKeyboard = $derived(
    runtime?.tap !== undefined &&
      view.kind === "listening" &&
      (params?.mode !== "away" || view.phase === "play" || view.practice) &&
      !choices,
  );
  const awayKeys = $derived(
    awayKeyboard(view.kind === "listening" ? view.item.inputRange : undefined),
  );
  const showPad = $derived(
    showKeyboard &&
      expected?.play?.kind === "rhythm" &&
      view.kind === "listening" &&
      !view.practice,
  );
  const practiceHelp = $derived(
    view.kind === "listening" && view.practice
      ? params?.mode === "away"
        ? "Work it out on the keyboard below. Nothing is marked until you press Ready."
        : "Work it out on your own piano; the app is not listening yet. Nothing is marked until you press Ready."
      : undefined,
  );

  /** The guide keyboard: home note and chord in the question, the answer after it. */
  const guideItem = $derived(
    view.kind === "presenting" || view.kind === "listening" || view.kind === "feedback"
      ? view.item
      : undefined,
  );
  const guideMarks = $derived.by(() => {
    const guide = guideItem?.guide;
    if (!guide) return undefined;
    const marks: Record<number, "tonic" | "chord" | "target" | "right" | "wrong"> = {};
    const answer = view.kind === "feedback" ? view.answerKeys : undefined;
    for (let midi = guide.low; midi <= guide.high; midi++) {
      const pc = midi % 12;
      if (answer) {
        if (answer.targetPcs.includes(pc)) marks[midi] = "target";
      } else if (pc === guide.tonicPc) {
        marks[midi] = "tonic";
      } else if (guide.chordPcs.includes(pc)) {
        marks[midi] = "chord";
      }
    }
    for (const midi of answer?.played ?? []) {
      marks[midi] = answer?.targetPcs.includes(midi % 12) ? "right" : "wrong";
    }
    return marks;
  });
  const guideNote = $derived(
    view.kind === "feedback"
      ? "Green: the note you were asked for. Red: a note you played that was not it."
      : "Gold: the home note, 1. Pale: the rest of the home chord.",
  );

  const orientCard = cardById(ORIENT_CARD_ID);
  /** Show the warm-up card in full the first time; read once so it stays up until Continue. */
  let firstOrient = $state(false);
  /** A card opened with "What's this?". The session is paused underneath while it is open. */
  let openCard = $state.raw<ConceptCard | undefined>();
  let pausedForCard = false;
  const introCard = $derived(view.kind === "intro" ? cardForNode(view.nodeId) : undefined);
  const itemCard = $derived("item" in view ? cardForNode(view.item.nodeId) : undefined);
  /** One line saying what to do, from the skill card's first "What you'll do" step. */
  const hint = $derived(itemCard?.howTo[0]);

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
        updateState.canUpdateNow =
          s.kind === "idle" || s.kind === "summary" || s.kind === "error" || s.kind === "nothing";
      });
      phase = "ready";
    });
    document.addEventListener("visibilitychange", onVisibility);
    // Closing the tab on the feedback screen still writes the attempt that was held back.
    function onPageHide(): void {
      current?.machine.commit();
    }
    window.addEventListener("pagehide", onPageHide);
    const timer = setInterval(() => {
      elapsed = current?.machine.elapsedSec() ?? 0;
    }, 1000);

    return () => {
      gone = true;
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pagehide", onPageHide);
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

  /** Finish asks first: the session pauses underneath until the learner chooses. */
  let confirmingFinish = $state(false);

  function askFinish(): void {
    if (!machine) return;
    machine.pause();
    if (machine.state.kind === "paused") confirmingFinish = true;
  }

  // A confirm left open must not reappear on a later background pause.
  $effect(() => {
    if (view.kind !== "paused") confirmingFinish = false;
  });

  function cancelFinish(): void {
    confirmingFinish = false;
    resume();
  }

  function confirmFinish(): void {
    confirmingFinish = false;
    machine?.finish();
  }
</script>

<svelte:head><title>Session</title></svelte:head>

{#snippet keyNotesLine(notes: KeyNotes)}
  <p class="key-notes" data-testid="key-notes">
    <strong>{notes.key}</strong>
    {#each notes.notes as n (n.label)}
      <span class="key-note"><span class="deg">{n.label}</span> {n.note}</span>
    {/each}
  </p>
{/snippet}

{#snippet nextStepLinks()}
  {#if steps && (steps.keepGoing || steps.learn)}
    <h2>Keep going?</h2>
    <!-- eslint-disable svelte/no-navigation-without-resolve -- the base path is resolved in keepGoingHref and learnHref; only the query string is added -->
    <div class="next-steps" data-testid="next-steps">
      {#if steps.keepGoing}
        <a
          class="button stacked"
          href={keepGoingHref}
          data-sveltekit-reload
          data-testid="keep-going"
        >
          <strong>Keep going</strong>
          <span>{minutesLabel(steps.keepGoingSec)} of extra practice</span>
        </a>
      {/if}
      {#if steps.learn}
        <a
          class="button secondary stacked"
          href={learnHref}
          data-sveltekit-reload
          data-testid="learn-more"
        >
          <strong>Learn something new</strong>
          <span>One more batch of new items</span>
        </a>
      {/if}
    </div>
    <!-- eslint-enable svelte/no-navigation-without-resolve -->
  {/if}
{/snippet}

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

    {#if "item" in view && (view.item.display !== undefined || view.item.showStaff === true || view.item.revealed === true)}
      <div class="notation-slot" data-testid="notation-slot" data-block={view.item.block}>
        {#if runtime}
          <NotationView port={runtime.notation} label="Music notation to read" />
        {/if}
      </div>
    {/if}

    {#if view.kind === "idle"}
      <h1>
        {params?.practice
          ? "Practise more"
          : params?.learn
            ? "Learn something new"
            : params?.mode === "away"
              ? "Away session"
              : "Session"}
      </h1>
      <p data-testid="session-intro">
        {#if params?.practice}
          Extra practice on skills you have started. This does not change your review schedule.
        {:else if params?.learn}
          One more batch of new material today, then the usual review.
        {:else if params?.mode === "away"}
          A short ear session with no piano. Headphones are best.
        {:else}
          A short daily session: warm up, then a few ear exercises.
        {/if}
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
        {#if view.item.keyNotes}
          <!-- eslint-disable-next-line @typescript-eslint/no-confusing-void-expression -- rendering a local snippet -->
          {@render keyNotesLine(view.item.keyNotes)}
        {/if}
        {#if hint}<p class="hint" data-testid="hint">{hint}</p>{/if}
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
        {#if view.item.keyNotes}
          <!-- eslint-disable-next-line @typescript-eslint/no-confusing-void-expression -- rendering a local snippet -->
          {@render keyNotesLine(view.item.keyNotes)}
        {/if}
        {#if hint}<p class="hint" data-testid="hint">{hint}</p>{/if}
        {#if practiceHelp}<p class="hint" data-testid="practice-help">{practiceHelp}</p>{/if}
        {#if view.canHear}
          <div class="row" role="group" aria-label="Hear it again">
            <button
              type="button"
              class="secondary"
              data-testid="hear-again"
              onclick={() => machine?.hear("full")}
            >
              {view.canHearNote ? "Hear it again" : "Replay"}
            </button>
            {#if view.canHearNote}
              <button
                type="button"
                class="secondary"
                data-testid="hear-note"
                onclick={() => machine?.hear("note")}
              >
                Hear the note
              </button>
            {/if}
          </div>
        {/if}
        {#if choices}
          <div class="choices" role="group" aria-label="Your answer">
            {#each choices as option (option.id)}
              <button
                type="button"
                class="primary"
                data-testid={`choice-${option.id}`}
                onclick={() => machine?.answerChoice(option.id)}
              >
                {option.label}
              </button>
            {/each}
          </div>
        {/if}
        <div class="row">
          {#if view.practice}
            <button
              type="button"
              class="primary"
              data-testid="ready"
              onclick={() => machine?.ready()}
            >
              Ready, mark my answer
            </button>
          {:else if !choices}
            <button
              type="button"
              class="primary"
              data-testid="done"
              onclick={() => machine?.answerDone()}
            >
              Done
            </button>
          {/if}
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
        {#if view.feedback.answer}
          <p class="answer" data-testid="answer">{view.feedback.answer}</p>
        {/if}
        {#if view.feedback.lines.length > 0}
          <ul class="issues" data-testid="issues">
            {#each view.feedback.lines as line (line)}<li>{line}</li>{/each}
          </ul>
        {/if}
        {#if view.feedback.tip}
          <div class="tip" data-testid="tip">
            <p>{view.feedback.tip}</p>
            {#if itemCard}
              <button
                type="button"
                class="link left"
                data-testid="tip-more"
                onclick={() => {
                  showCard(itemCard);
                }}
              >
                More about this
              </button>
            {/if}
          </div>
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
            {#if view.canRetry}
              <button
                type="button"
                class="secondary"
                data-testid="retry"
                onclick={() => machine?.retry()}
              >
                Try again
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
          {#if view.autoContinueMs}
            <p class="hint" data-testid="auto-continue-note">
              Moving on in {Math.round(view.autoContinueMs / 1000)}s. Replay or Try again to stay
              here. Change this in Settings.
            </p>
          {/if}
          {#if view.canRetry && !view.feedback.correct}
            <p class="hint">
              If your key presses were not heard, Try again asks it again without counting this go.
            </p>
          {/if}
          {#if itemCard && !view.feedback.tip}
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
    {:else if view.kind === "paused" && confirmingFinish}
      <section class="card" data-testid="finish-confirm">
        <h1>End the session?</h1>
        <p class="lead">Your answers so far are saved.</p>
        <div class="confirm-actions">
          <button type="button" class="primary" data-testid="finish-cancel" onclick={cancelFinish}>
            Keep going
          </button>
          <button type="button" data-testid="finish-end" onclick={confirmFinish}>End session</button
          >
        </div>
      </section>
    {:else if view.kind === "paused"}
      <section class="card" data-testid="paused">
        <h1>Paused</h1>
        <p class="lead">The session stopped while the app was in the background.</p>
        <button type="button" class="primary" data-testid="resume" onclick={resume}>Resume</button>
      </section>
    {:else if view.kind === "nothing"}
      <section class="card" data-testid="nothing">
        <h1>Nothing is due right now</h1>
        <p class="lead">
          There is nothing to review and no new material to add at the moment. Come back tomorrow.
        </p>
        <!-- eslint-disable-next-line @typescript-eslint/no-confusing-void-expression -- rendering a local snippet -->
        {@render nextStepLinks()}
        <a
          class="button"
          class:secondary={steps && (steps.keepGoing || steps.learn)}
          href={resolve("/")}
          data-testid="home"
        >
          {steps && (steps.keepGoing || steps.learn) ? "Done for today" : "Back to home"}
        </a>
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
        {#if runResult}
          <div
            class="moment"
            data-testid="piece-moment"
            data-complete={runResult.correctPhrases === runResult.phrases}
          >
            {#if runResult.correctPhrases === runResult.phrases}
              <h2>You played {runResult.title} through</h2>
              <p>Every phrase, start to finish.</p>
            {:else}
              <h2>
                {runResult.title}: {runResult.correctPhrases} of {runResult.phrases} phrases right
              </h2>
              <p>
                The phrases you missed come back in your next sessions. Play it through again when
                you are ready.
              </p>
            {/if}
          </div>
        {/if}
        {#if view.summary.nodeChanges.length > 0}
          <h2>Progress</h2>
          <ul class="issues" data-testid="node-changes">
            {#each view.summary.nodeChanges as c (c.nodeId)}
              <li>{c.title}: {c.from} to {c.to}</li>
            {/each}
          </ul>
        {/if}
        {#if view.summary.notes}
          <ul class="issues" data-testid="summary-notes">
            {#each view.summary.notes as note (note)}
              <li>{note}</li>
            {/each}
          </ul>
        {/if}
        <!-- eslint-disable-next-line @typescript-eslint/no-confusing-void-expression -- rendering a local snippet -->
        {@render nextStepLinks()}
        <a
          class="button"
          class:secondary={steps && (steps.keepGoing || steps.learn)}
          href={resolve("/")}
          data-testid="home"
        >
          {steps && (steps.keepGoing || steps.learn) ? "Done for today" : "Back to home"}
        </a>
      </section>
    {:else}
      <section class="card">
        <h1>Something went wrong</h1>
        <p role="alert" data-testid="error">{view.message}</p>
        <a class="button" href={resolve("/")}>Back to home</a>
      </section>
    {/if}

    {#if showKeyboard}
      <div class="keys" data-testid="live-keyboard">
        <Keyboard
          low={awayKeys.low}
          high={awayKeys.high}
          focusMidi={awayKeys.focus}
          labels="c-only"
          marks={guideMarks ?? {}}
          playSound={(midi: number) => runtime?.tone(midi)}
          onpress={(midi: number, ts: number) => runtime?.tap?.press(midi, ts)}
          onrelease={(midi: number, ts: number) => runtime?.tap?.release(midi, ts)}
        />
      </div>
    {/if}

    {#if !showKeyboard && guideItem?.guide && guideMarks}
      <div class="keys" data-testid="guide-keyboard">
        <Keyboard
          low={guideItem.guide.low}
          high={guideItem.guide.high}
          focusMidi={guideItem.guide.focus}
          labels="c-only"
          marks={guideMarks}
          readonly
        />
        <p class="hint" data-testid="guide-note">{guideNote}</p>
      </div>
    {/if}

    <!-- Nothing has started during the headphones prompt or while preparing, so Finish is hidden. -->
    {#if running && view.kind !== "paused" && view.kind !== "headphones" && view.kind !== "preparing"}
      <p class="finish">
        <button type="button" class="link" data-testid="finish" onclick={askFinish}>
          Finish session
        </button>
      </p>
    {/if}
  {/if}
</div>

<style>
  .choices {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-3);
  }
  .choices button {
    flex: 1 1 8rem;
    min-height: 3.5rem;
  }
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

  .key-notes {
    display: flex;
    flex-wrap: wrap;
    justify-content: center;
    gap: var(--space-2) var(--space-4);
    font-size: 1.15rem;
  }

  .key-note .deg {
    color: var(--color-text-muted);
    font-size: 0.9rem;
  }

  .answer {
    font-size: 1.15rem;
    text-align: center;
  }

  .hint {
    color: var(--color-text-muted);
    line-height: 1.5;
    text-align: center;
  }

  .notation-slot {
    min-height: 8rem;
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

  .next-steps {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    margin-bottom: var(--space-3);
  }

  .button.stacked {
    flex-direction: column;
    padding: var(--space-3) var(--space-4);
    font-weight: 400;
  }

  .button.stacked strong {
    font-weight: 700;
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

  .tip {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    padding: var(--space-3) var(--space-4);
    border-left: 3px solid var(--color-accent);
    background: var(--color-bg);
    border-radius: var(--radius-md);
  }

  .tip p {
    margin: 0;
    line-height: 1.5;
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

  .moment {
    padding: var(--space-3) var(--space-4);
    margin: var(--space-3) 0;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    background: color-mix(in srgb, var(--color-accent) 18%, var(--color-surface));
  }

  .moment[data-complete="false"] {
    background: var(--color-surface);
  }

  .moment h2 {
    margin: 0 0 var(--space-1);
  }

  .moment p {
    margin: 0;
  }

  .confirm-actions {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-3);
  }

  .status {
    text-align: center;
    color: var(--color-text-muted);
  }
</style>
