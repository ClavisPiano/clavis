<script lang="ts">
  import type { ScoreSpec } from "@clavis/core";
  import { getNotationClient } from "../notation/shared";
  import { createNotationViewPort } from "../notation/view-port";
  import NotationView from "./NotationView.svelte";

  interface Props {
    score: ScoreSpec;
    label: string;
  }

  let { score, label }: Props = $props();

  // One port per staff example. A load failure leaves the example as a plain play button.
  const port = createNotationViewPort(getNotationClient());

  $effect(() => {
    void port.show(score).catch(() => undefined);
    return () => {
      port.hide();
    };
  });
</script>

<NotationView {port} {label} maxWidth="16rem" />
