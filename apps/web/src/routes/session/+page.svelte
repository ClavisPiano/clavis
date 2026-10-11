<script lang="ts">
  import { page } from "$app/state";
  import { parseSessionMode } from "../../lib/session-mode";

  const mode = $derived(parseSessionMode(page.url.searchParams));
</script>

<h1>Session</h1>
<p>Mode: <strong data-testid="session-mode">{mode}</strong></p>
<p>Session content arrives in a later task.</p>
