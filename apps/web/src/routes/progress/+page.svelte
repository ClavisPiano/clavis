<script lang="ts">
  import { onMount } from "svelte";
  import { resolve } from "$app/paths";
  import { loadMilestones } from "@clavis/content";
  import {
    CALIBRATION_WINDOW_DAYS,
    calibration,
    fluencyTrends,
    learnerDay,
    milestones,
    practiceDays,
    upcomingMilestones,
    weeklyProgress,
    type LearningEvent,
  } from "@clavis/core";
  import { useLearner } from "../../lib/learner.svelte";
  import { deviceTzOffsetMin, effectiveSettings } from "../../lib/home";
  import {
    CALENDAR_WEEKS,
    STRAND_LABEL,
    calendarWeeks,
    percentLabel,
    secondsLabel,
    sparkline,
    weeklySeries,
  } from "../../lib/progress";

  const learner = useLearner();
  let events = $state.raw<LearningEvent[] | undefined>(undefined);
  let now = $state(Date.now());

  onMount(async () => {
    await learner.init();
    if (learner.status !== "ready") return;
    now = Date.now();
    try {
      events = await learner.ctx.store.list();
    } catch {
      events = [];
    }
  });

  const SPARK_W = 120;
  const SPARK_H = 36;
  const BAR_MAX_H = 48;

  const settings = $derived(effectiveSettings(learner.state?.settings ?? {}));
  const today = $derived(learnerDay(now, deviceTzOffsetMin()));
  const days = $derived(events ? practiceDays(events) : []);
  const columns = $derived(calendarWeeks(days, today, CALENDAR_WEEKS));
  const weekStarts = $derived(columns.map((c) => c[0]?.day ?? ""));
  const progress = $derived(weeklyProgress(days, settings.weeklyTargetDays, today, 1, 8));
  const trends = $derived(
    events && learner.status === "ready" ? fluencyTrends(events, learner.ctx.graph) : [],
  );
  const content = loadMilestones();
  const earned = $derived(
    learner.status === "ready" && learner.state
      ? milestones(learner.state, learner.ctx.graph, content).reverse()
      : [],
  );
  const upcoming = $derived(
    learner.status === "ready" && learner.state
      ? upcomingMilestones(learner.state, learner.ctx.graph, content, 3)
      : [],
  );
  const hasPractice = $derived(days.some((d) => d.practised));
  const calib = $derived(events ? calibration(events, today, CALENDAR_WEEKS) : undefined);
  const calibSpark = $derived(
    calib
      ? sparkline(
          calib.trend.map((w) => w.agreement),
          SPARK_W,
          SPARK_H,
          { min: 0, max: 1 },
        )
      : undefined,
  );
  const barScale = $derived(Math.max(7, settings.weeklyTargetDays));

  const strandRows = $derived(
    trends.map((t) => {
      const acc = weeklySeries(t.points, weekStarts, (p) => p.accuracy);
      const lat = weeklySeries(t.points, weekStarts, (p) => p.medianLatencyMs);
      const last = t.points[t.points.length - 1];
      const lastLatency = [...t.points]
        .reverse()
        .find((p) => p.medianLatencyMs !== undefined)?.medianLatencyMs;
      return {
        strand: t.strand,
        label: STRAND_LABEL[t.strand] ?? t.strand,
        accuracy: sparkline(acc, SPARK_W, SPARK_H, { min: 0, max: 1 }),
        latency: sparkline(lat, SPARK_W, SPARK_H),
        accuracyText: last ? percentLabel(last.accuracy) : "none yet",
        latencyText: lastLatency === undefined ? "none yet" : secondsLabel(lastLatency),
        weeks: t.points.length,
      };
    }),
  );
</script>

<svelte:head><title>Progress</title></svelte:head>

<h1>Progress</h1>

{#if learner.status === "failed"}
  <p role="alert">Local storage is unavailable, so there is no progress to show.</p>
{:else if learner.status === "loading" || events === undefined}
  <p>Loading...</p>
{:else}
  <p class="map-link">
    <a href={resolve("/progress/map")} data-testid="skill-map-link">See your skill map</a>
  </p>

  <section class="card" aria-labelledby="ms-h">
    <h2 id="ms-h">Milestones</h2>
    {#if earned.length === 0}
      <p class="muted" data-testid="milestones-empty">
        Nothing yet. When you master a skill, a plain statement of what you can now do appears here.
      </p>
    {:else}
      <ol class="milestones" data-testid="milestones">
        {#each earned as m (m.nodeId)}
          <li data-testid="milestone" data-node={m.nodeId}>
            <span class="ms-text">{m.statement}</span>
            <span class="ms-date muted">{m.day}</span>
          </li>
        {/each}
      </ol>
    {/if}
    {#if upcoming.length > 0}
      <h3 class="ms-next-h">Within reach</h3>
      <ul class="milestones upcoming" data-testid="milestones-upcoming">
        {#each upcoming as m (m.nodeId)}
          <li data-testid="milestone-upcoming" data-node={m.nodeId}>
            <span class="ms-text">{m.statement}</span>
            <span class="ms-date">{m.state === "fluent" ? "Fluent" : "Learning"}</span>
          </li>
        {/each}
      </ul>
    {/if}
  </section>

  <section class="card" aria-labelledby="week-h">
    <h2 id="week-h">This week</h2>
    <p class="big" data-testid="weekly-target">
      {progress.thisWeek.daysPractised} of {progress.target} days this week
    </p>
    {#if progress.thisWeek.met}
      <p class="muted" data-testid="weekly-met">Target reached. Anything more is a bonus.</p>
    {:else}
      <p class="muted">
        A missed day changes nothing else. You can change the target in
        <a href={resolve("/settings")}>Settings</a>.
      </p>
    {/if}
    <ol class="bars" data-testid="week-bars" aria-label="Days practised in recent weeks">
      {#each progress.recent as w (w.start)}
        <li
          class="bar-col"
          class:current={w.current}
          data-testid="week-bar"
          data-days={w.daysPractised}
          data-met={w.met}
        >
          <span
            class="bar-wrap"
            role="img"
            aria-label="Week of {w.start}: {w.daysPractised} of {progress.target} days{w.met
              ? ', target met'
              : ''}"
            title="Week of {w.start}: {w.daysPractised} of {progress.target} days"
          >
            <span
              class="bar"
              class:met={w.met}
              style:height="{(w.daysPractised / barScale) * BAR_MAX_H}px"
            ></span>
            <span class="target-line" style:bottom="{(progress.target / barScale) * BAR_MAX_H}px"
            ></span>
          </span>
          <span class="bar-label">{w.start.slice(5)}</span>
        </li>
      {/each}
    </ol>
  </section>

  <section class="card" aria-labelledby="cal-h">
    <h2 id="cal-h">Last {CALENDAR_WEEKS} weeks</h2>
    {#if !hasPractice}
      <p class="muted" data-testid="calendar-empty">
        Nothing to show yet. Practised days will fill in here, shaded by minutes.
      </p>
    {/if}
    <div class="calendar-scroll">
      <div class="calendar" data-testid="calendar" role="list" aria-label="Practice calendar">
        {#each columns as column (column[0]?.day)}
          <div class="col" role="presentation">
            {#each column as cell (cell.day)}
              <div
                role="listitem"
                class="cell level-{cell.level}"
                class:future={cell.future}
                class:today={cell.isToday}
                data-testid="calendar-cell"
                data-day={cell.day}
                data-level={cell.level}
                data-minutes={cell.minutes}
                aria-label={cell.label}
                title={cell.label}
              ></div>
            {/each}
          </div>
        {/each}
      </div>
    </div>
    <p class="legend muted" aria-hidden="true">
      Less
      <span class="swatch level-0"></span>
      <span class="swatch level-1"></span>
      <span class="swatch level-2"></span>
      <span class="swatch level-3"></span>
      More. Weeks start on Monday.
    </p>
  </section>

  <section class="card" aria-labelledby="trend-h">
    <h2 id="trend-h">Fluency by skill area</h2>
    {#if strandRows.length === 0}
      <p class="muted" data-testid="trends-empty">
        Accuracy and speed trends appear after your first answered items.
      </p>
    {:else}
      <p class="muted">
        Each point is one week. Speed is the median time to a correct answer, so lower is faster.
      </p>
      <ul class="trends" data-testid="trends">
        {#each strandRows as row (row.strand)}
          <li class="trend" data-testid="trend-row" data-strand={row.strand}>
            <h3>{row.label}</h3>
            <div class="spark-pair">
              <figure>
                <svg
                  class="spark"
                  viewBox="0 0 {SPARK_W} {SPARK_H}"
                  role="img"
                  aria-label="{row.label} accuracy by week, latest {row.accuracyText}"
                  data-testid="spark-accuracy"
                >
                  <path d={row.accuracy.d} fill="none" />
                  {#each row.accuracy.dots as dot (dot.index)}
                    <circle cx={dot.x} cy={dot.y} r="2" />
                  {/each}
                </svg>
                <figcaption>Accuracy <strong>{row.accuracyText}</strong></figcaption>
              </figure>
              <figure>
                <svg
                  class="spark"
                  viewBox="0 0 {SPARK_W} {SPARK_H}"
                  role="img"
                  aria-label="{row.label} median latency by week, latest {row.latencyText}"
                  data-testid="spark-latency"
                >
                  <path d={row.latency.d} fill="none" />
                  {#each row.latency.dots as dot (dot.index)}
                    <circle cx={dot.x} cy={dot.y} r="2" />
                  {/each}
                </svg>
                <figcaption>Speed <strong>{row.latencyText}</strong></figcaption>
              </figure>
            </div>
          </li>
        {/each}
      </ul>
    {/if}
  </section>

  {#if calib?.enough && calibSpark}
    <section class="card" aria-labelledby="calib-h" data-testid="calibration">
      <h2 id="calib-h">Knowing when you are right</h2>
      <p class="big" data-testid="calibration-agreement">
        Your call matched the result {percentLabel(calib.agreement ?? 0)} of the time
      </p>
      <p class="muted">
        From the {calib.attempts} answers you judged yourself in the last {CALIBRATION_WINDOW_DAYS} days,
        before seeing the result.
      </p>
      <ul class="calib-counts">
        <li data-testid="calibration-over">
          Said right, but it was wrong: <strong>{calib.overconfident}</strong>
        </li>
        <li data-testid="calibration-under">
          Said wrong, but it was right: <strong>{calib.underconfident}</strong>
        </li>
      </ul>
      <figure>
        <svg
          class="spark"
          viewBox="0 0 {SPARK_W} {SPARK_H}"
          role="img"
          aria-label="How often your call matched the result, by week"
          data-testid="spark-calibration"
        >
          <path d={calibSpark.d} fill="none" />
          {#each calibSpark.dots as dot (dot.index)}
            <circle cx={dot.x} cy={dot.y} r="2" />
          {/each}
        </svg>
        <figcaption>By week, over the last {CALENDAR_WEEKS} weeks</figcaption>
      </figure>
    </section>
  {/if}
{/if}

<style>
  .map-link {
    margin: 0 0 var(--space-4);
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

  .milestones {
    list-style: none;
    padding: 0;
    margin: 0;
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }

  .milestones li {
    display: flex;
    flex-wrap: wrap;
    justify-content: space-between;
    gap: var(--space-1) var(--space-3);
    padding: var(--space-2) var(--space-3);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-sm);
    background: color-mix(in srgb, var(--color-accent) 12%, var(--color-surface));
  }

  .milestones.upcoming li {
    background: transparent;
    color: var(--color-text-muted);
  }

  .ms-text {
    flex: 1 1 14rem;
    min-width: 0;
  }

  .ms-date {
    font-size: 0.85rem;
    white-space: nowrap;
  }

  .ms-next-h {
    font-size: 1rem;
    margin: var(--space-4) 0 var(--space-2);
  }

  .big {
    font-size: 1.25rem;
    font-weight: 700;
    margin: 0 0 var(--space-2);
  }

  .bars {
    display: flex;
    align-items: flex-end;
    gap: var(--space-2);
    list-style: none;
    padding: 0;
    margin: var(--space-3) 0 0;
  }

  .bar-col {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: var(--space-1);
    min-width: 0;
  }

  .bar-wrap {
    position: relative;
    display: flex;
    align-items: flex-end;
    justify-content: center;
    width: 100%;
    height: 48px;
  }

  .bar {
    display: block;
    width: 70%;
    min-height: 2px;
    border-radius: var(--radius-sm) var(--radius-sm) 0 0;
    background: color-mix(in srgb, var(--color-accent) 45%, var(--color-surface));
  }

  .bar.met {
    background: var(--color-accent);
  }

  .target-line {
    position: absolute;
    left: 0;
    right: 0;
    border-top: 1px dashed var(--color-text-muted);
  }

  .bar-label {
    font-size: 0.7rem;
    color: var(--color-text-muted);
  }

  .current .bar-label {
    color: var(--color-text);
    font-weight: 700;
  }

  .calendar-scroll {
    overflow-x: auto;
  }

  .calendar {
    display: grid;
    grid-auto-flow: column;
    grid-auto-columns: minmax(14px, 1fr);
    gap: 3px;
  }

  .col {
    display: grid;
    grid-template-rows: repeat(7, 1fr);
    gap: 3px;
  }

  .cell {
    aspect-ratio: 1;
    min-height: 14px;
    border: 1px solid var(--color-border);
    border-radius: 3px;
    background: transparent;
  }

  .cell.future {
    border-style: dotted;
    opacity: 0.4;
  }

  .cell.today {
    border-color: var(--color-text);
  }

  .level-1 {
    background: color-mix(in srgb, var(--color-accent) 25%, var(--color-surface));
  }

  .level-2 {
    background: color-mix(in srgb, var(--color-accent) 55%, var(--color-surface));
  }

  .level-3 {
    background: var(--color-accent);
  }

  .legend {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: var(--space-1);
    margin: var(--space-3) 0 0;
    font-size: 0.8rem;
  }

  .swatch {
    display: inline-block;
    width: 12px;
    height: 12px;
    border: 1px solid var(--color-border);
    border-radius: 3px;
  }

  .trends {
    list-style: none;
    padding: 0;
    margin: 0;
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
  }

  .trend h3 {
    font-size: 1rem;
    margin: 0 0 var(--space-2);
  }

  .spark-pair {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: var(--space-3);
  }

  figure {
    margin: 0;
    min-width: 0;
  }

  figcaption {
    font-size: 0.85rem;
    color: var(--color-text-muted);
  }

  figcaption strong {
    color: var(--color-text);
  }

  .calib-counts {
    margin: 0 0 var(--space-3);
    padding-left: var(--space-4);
  }

  .spark {
    display: block;
    width: 100%;
    height: auto;
    max-height: 48px;
    border-bottom: 1px solid var(--color-border);
  }

  .spark path {
    stroke: var(--color-accent);
    stroke-width: 2;
    stroke-linejoin: round;
    stroke-linecap: round;
  }

  .spark circle {
    fill: var(--color-accent);
  }
</style>
