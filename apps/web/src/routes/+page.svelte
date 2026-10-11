<script lang="ts">
  import { resolve } from "$app/paths";
</script>

<h1>Clavis</h1>
<p>Piano and ear training, a few focused minutes a day.</p>
<div class="actions">
  <a class="button" href={resolve("/session")}>Start session</a>
  <a class="button secondary" href={resolve("/session?mode=away")}>Away session</a>
</div>

<style>
  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-3);
  }
</style>
