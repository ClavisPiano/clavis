<script lang="ts">
  import { resolve } from "$app/paths";
  // Only the dev routes: `resolve` cannot take a union of every route in the app (TypeScript
  // gives up on more than 25 overloads).
  type DevRoute =
    | "/dev/events"
    | "/dev/input"
    | "/dev/pitch"
    | "/dev/transcribe"
    | "/dev/state"
    | "/dev/reset"
    | "/dev/stimulus"
    | "/dev/audio"
    | "/dev/record"
    | "/dev/notation";
  interface DevPage {
    readonly href: DevRoute;
    readonly label: string;
  }

  const devPages: readonly DevPage[] = [
    { href: "/dev/events", label: "Event log" },
    { href: "/dev/input", label: "Input adapters" },
    { href: "/dev/pitch", label: "Mic pitch" },
    { href: "/dev/transcribe", label: "Chords on the mic (review)" },
    { href: "/dev/state", label: "Learner state" },
    { href: "/dev/reset", label: "Reset progress or all data" },
    { href: "/dev/stimulus", label: "Stimulus player" },
    { href: "/dev/audio", label: "iOS audio spike" },
    { href: "/dev/record", label: "Record fixture" },
    { href: "/dev/notation", label: "Notation spike (Verovio)" },
  ];
</script>

<h1>Dev pages</h1>
{#if devPages.length === 0}
  <p>No dev pages yet.</p>
{:else}
  <ul>
    {#each devPages as devPage (devPage.href)}
      <li><a href={resolve(devPage.href)}>{devPage.label}</a></li>
    {/each}
  </ul>
{/if}
