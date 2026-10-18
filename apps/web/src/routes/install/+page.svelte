<script lang="ts">
  import { resolve } from "$app/paths";
</script>

<svelte:head><title>Install</title></svelte:head>

<h1>Install Clavis</h1>
<p>
  On iPhone and iPad, Clavis works best when added to your Home Screen. It then opens full screen
  and keeps working offline.
</p>

<ol>
  <li>Open Clavis in Safari.</li>
  <li>Tap the Share button (the square with an arrow pointing up).</li>
  <li>Choose <strong>Add to Home Screen</strong>, then tap <strong>Add</strong>.</li>
  <li>Open Clavis from the new Home Screen icon.</li>
</ol>

<h2>Why it matters</h2>
<ul>
  <li>
    Storage persistence: Safari can clear data for sites you rarely open in the browser. An
    installed app is far less likely to lose your practice history.
  </li>
  <li>Notifications: practice reminders only work for apps added to the Home Screen.</li>
</ul>

<p><a href={resolve("/")}>Back to home</a></p>
