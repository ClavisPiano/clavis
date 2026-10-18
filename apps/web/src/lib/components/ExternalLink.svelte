<script lang="ts">
  import type { Snippet } from "svelte";

  let { href, testid, children }: { href: string; testid?: string; children: Snippet } = $props();
</script>

<!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- external https links, not app routes -->
<a {href} target="_blank" rel="noopener noreferrer" data-testid={testid}>{@render children()}</a>
