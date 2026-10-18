<script lang="ts">
  import { resolve } from "$app/paths";
  import { parsePrivacy } from "../../lib/privacy-text";
  import policy from "../../../../../docs/privacy.md?raw";

  const blocks = parsePrivacy(policy);
</script>

<svelte:head>
  <title>Privacy - Clavis</title>
</svelte:head>

<article data-testid="privacy">
  {#each blocks as block, i (i)}
    {#if block.kind === "title"}
      <h1>{block.text}</h1>
    {:else if block.kind === "heading"}
      <h2>{block.text}</h2>
    {:else if block.kind === "list"}
      <ul>
        {#each block.items as item (item)}
          <li>{item}</li>
        {/each}
      </ul>
    {:else}
      <p>{block.text}</p>
    {/if}
  {/each}
  <p><a href={resolve("/settings")}>Back to Settings</a></p>
</article>
