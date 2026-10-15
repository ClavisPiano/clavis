<script lang="ts">
  import { onMount } from "svelte";
  import { resolve } from "$app/paths";
  import { useLearner } from "../../lib/learner.svelte";
  import { practiceSearch, practiceSkills, type PracticeSkill } from "../../lib/practice-skills";

  const STRAND_LABEL: Record<string, string> = {
    EAR: "Ear",
    READ: "Reading",
    HANDS: "Hands",
    BYEAR: "By ear",
    APPLY: "Pieces",
  };

  const learner = useLearner();
  let chosen = $state<string[]>([]);
  let away = $state(false);

  onMount(async () => {
    await learner.init();
  });

  const skills = $derived<PracticeSkill[]>(
    learner.status === "ready" && learner.state
      ? practiceSkills(learner.state, learner.ctx.graph)
      : [],
  );
  const groups = $derived(
    [...new Set(skills.map((s) => s.strand))].map((strand) => ({
      strand,
      label: STRAND_LABEL[strand] ?? strand,
      skills: skills.filter((s) => s.strand === strand),
    })),
  );
  // The link resolves the base path; only the query string is added.
  const href = $derived(resolve("/session") + practiceSearch(chosen, away ? { mode: "away" } : {}));

  function toggle(nodeId: string, on: boolean): void {
    chosen = on ? [...chosen, nodeId] : chosen.filter((id) => id !== nodeId);
  }
</script>

<svelte:head><title>Practise</title></svelte:head>

<h1>Practise</h1>

{#if learner.status === "failed"}
  <p role="alert">Local storage is unavailable, so there is nothing to practise from.</p>
{:else if learner.status === "loading"}
  <p>Loading...</p>
{:else if skills.length === 0}
  <p data-testid="practice-empty">
    Nothing to practise yet. Finish a regular session first, then come back.
  </p>
  <p><a href={resolve("/")}>Back to home</a></p>
{:else}
  <p class="lead">
    Pick what to drill. Practice repeats exercises you have already answered, and your review
    schedule stays as it is. Choose nothing to practise everything.
  </p>

  <form class="skills" data-testid="practice-skills">
    {#each groups as group (group.strand)}
      <fieldset>
        <legend>{group.label}</legend>
        {#each group.skills as skill (skill.nodeId)}
          <label class="skill">
            <input
              type="checkbox"
              data-testid="practice-skill"
              data-node={skill.nodeId}
              checked={chosen.includes(skill.nodeId)}
              onchange={(e) => {
                toggle(skill.nodeId, e.currentTarget.checked);
              }}
            />
            <span>{skill.title}</span>
            <span class="muted">{skill.items} {skill.items === 1 ? "exercise" : "exercises"}</span>
          </label>
        {/each}
      </fieldset>
    {/each}

    <label class="skill away">
      <input
        type="checkbox"
        data-testid="practice-away"
        checked={away}
        onchange={(e) => {
          away = e.currentTarget.checked;
        }}
      />
      <span>Away: no piano, tap the on-screen keyboard</span>
    </label>
  </form>

  <!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- the base path is resolved in href; only the query string is added -->
  <a class="button primary" {href} data-sveltekit-reload data-testid="practice-start">
    <strong
      >Practise {chosen.length === 0 ? "everything" : `${String(chosen.length)} selected`}</strong
    >
  </a>
  <p><a href={resolve("/")}>Back to home</a></p>
{/if}

<style>
  .lead {
    line-height: 1.5;
  }

  .skills {
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
    margin: var(--space-4) 0;
  }

  fieldset {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    padding: var(--space-3) var(--space-4);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-lg);
  }

  .skill {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    min-height: var(--touch-target);
  }

  .skill span:nth-of-type(1) {
    flex: 1;
  }

  .muted {
    color: var(--color-text-muted);
    font-size: 0.9rem;
  }

  .away {
    padding: 0 var(--space-4);
  }
</style>
