<script lang="ts">
  import { resolve } from "$app/paths";
  import type { RouteId } from "$app/types";
  interface DevPage {
    readonly href: RouteId;
    readonly label: string;
  }

  const devPages: readonly DevPage[] = [
    { href: "/dev/events", label: "Event log" },
    { href: "/dev/stimulus", label: "Stimulus player" },
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
