<script lang="ts">
  import { onMount } from "svelte";
  import { page } from "$app/state";
  import { resolve } from "$app/paths";
  import NotationView from "../../lib/components/NotationView.svelte";
  import { updateState } from "../../lib/pwa/update-state.svelte";
  import type { SessionState } from "../../lib/session/machine";
  import { parseSessionParams } from "../../lib/session/params";
  import { createSessionRuntime, type SessionRuntime } from "../../lib/session/runtime";

  /*
   * Placement (T3.16, R19): ear, then reading, at the instrument. The session machine runs in its
   * placement mode: no intro cards, a brief tick instead of feedback, and one stored event at the
   * end. Answers come from the microphone; the stored on-screen keyboard choice is ignored because
   * placement is for the instrument.
   */

  type Phase = "loading" | "failed" | "ready";

  let phase = $state<Phase>("loading");
  let failure = $state("");
  let runtime = $state.raw<SessionRuntime | undefined>();
  let view = $state.raw<SessionState>({ kind: "idle" });

  const machine = $derived(runtime?.machine);
  const running = $derived(
    view.kind !== "idle" && view.kind !== "summary" && view.kind !== "error",
  );

  onMount(() => {
    // `?input=` still applies (tests use fake input); the stored choice does not.
    const p = parseSessionParams(page.url.searchParams, null);
    let off: (() => void) | undefined;
    let current: SessionRuntime | undefined;
    let gone = false;

    function onVisibility(): void {
      if (document.visibilityState === "hidden") current?.machine.pause();
    }

    void createSessionRuntime(p, { placement: true }).then((result) => {
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
      off = result.runtime.machine.subscribe((s) => {
        view = s;
        updateState.canUpdateNow = s.kind === "idle" || s.kind === "summary" || s.kind === "error";
      });
      phase = "ready";
    });
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      gone = true;
      document.removeEventListener("visibilitychange", onVisibility);
      off?.();
      // Leaving mid-way abandons the placement and stores nothing.
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

  function sectionLabel(block: "ear" | "read"): string {
    return block === "ear" ? "Ear" : "Reading";
  }
</script>

<svelte:head><title>Placement</title></svelte:head>

<div class="placement" data-testid="placement" data-state={view.kind}>
  {#if phase === "loading"}
    <p>Loading...</p>
  {:else if phase === "failed"}
    <h1>Placement</h1>
    <p role="alert">{failure}</p>
    <p><a href={resolve("/")}>Back to home</a></p>
  {:else}
    {#if "item" in view && view.item.display}
      <div class="notation-slot" data-testid="notation-slot" data-block={view.item.block}>
        {#if runtime}
          <NotationView port={runtime.notation} label="Music notation to read" />
        {/if}
      </div>
    {/if}

    {#if view.kind === "idle"}
      <h1>Find your starting point</h1>
      <p data-testid="placement-intro">
        A few minutes at your piano. You will hear a key, then name notes by playing them, and then
        read some notes on the bass staff and play them. It stops by itself when things get hard,
        and it never takes progress away.
      </p>
      <button type="button" class="primary" data-testid="placement-start" onclick={start}>
        Start placement
      </button>
      <p><a href={resolve("/")}>Back to home</a></p>
    {:else if view.kind === "preparing" || view.kind === "headphones"}
      <p class="status" aria-live="polite">Getting ready...</p>
    {:else if view.kind === "presenting"}
      <section class="card" data-testid="presenting">
        <p class="eyebrow">{sectionLabel(view.item.block)}</p>
        <p class="prompt" aria-live="polite">{view.prompt}</p>
        <button type="button" class="secondary" data-testid="skip" onclick={() => machine?.skip()}>
          I don't know
        </button>
      </section>
    {:else if view.kind === "listening"}
      <section class="card" data-testid="listening">
        <p class="eyebrow">{sectionLabel(view.item.block)}</p>
        <p class="prompt" aria-live="polite" data-testid="prompt">{view.prompt}</p>
        <button type="button" class="secondary" data-testid="skip" onclick={() => machine?.skip()}>
          I don't know
        </button>
      </section>
    {:else if view.kind === "feedback"}
      <section class="card" data-testid="feedback" data-correct={view.feedback.correct}>
        <p class="result" class:good={view.feedback.correct} data-testid="result">
          {view.feedback.correct ? "Correct" : "Not quite"}
        </p>
      </section>
    {:else if view.kind === "paused"}
      <section class="card" data-testid="paused">
        <h1>Paused</h1>
        <p class="lead">Placement stopped while the app was in the background.</p>
        <button type="button" class="primary" data-testid="resume" onclick={resume}>Resume</button>
      </section>
    {:else if view.kind === "summary"}
      <section class="card" data-testid="placement-summary">
        {#if view.summary.reason === "completed"}
          <h1>Placement complete</h1>
          {#if view.summary.placed && view.summary.placed.length > 0}
            <ul class="placed" data-testid="placed">
              {#each view.summary.placed as node (node.nodeId)}
                <li data-testid="placed-node" data-node={node.nodeId} data-state={node.state}>
                  <span>{node.title}</span>
                  <strong>{node.state}</strong>
                </li>
              {/each}
            </ul>
          {:else}
            <p data-testid="placed-none">Nothing was placed. You will start from the beginning.</p>
          {/if}
        {:else}
          <h1>Placement stopped</h1>
          <p data-testid="placement-abandoned">Nothing was saved.</p>
        {/if}
        {#if view.summary.notes}
          <ul class="placed" data-testid="summary-notes">
            {#each view.summary.notes as note (note)}
              <li>{note}</li>
            {/each}
          </ul>
        {/if}
        <a class="button" href={resolve("/")} data-testid="placement-done">Done</a>
      </section>
    {:else if view.kind === "error"}
      <section class="card">
        <h1>Something went wrong</h1>
        <p role="alert" data-testid="error">{view.message}</p>
        <a class="button" href={resolve("/")}>Back to home</a>
      </section>
    {:else}
      <!-- Placement has no intro cards or warm-up; the machine never enters them. -->
      <p class="status" aria-live="polite">Getting ready...</p>
    {/if}

    {#if running && view.kind !== "paused"}
      <p class="finish">
        <button type="button" class="link" data-testid="finish" onclick={() => machine?.finish()}>
          Stop placement
        </button>
      </p>
    {/if}
  {/if}
</div>

<style>
  .placement {
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
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

  .placed {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .placed li {
    display: flex;
    justify-content: space-between;
    gap: var(--space-3);
    padding: var(--space-2) 0;
    border-bottom: 1px solid var(--color-border);
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

  .finish {
    margin: 0;
    text-align: center;
  }

  .status {
    text-align: center;
    color: var(--color-text-muted);
  }
</style>
