<script lang="ts">
  import { SvelteMap } from "svelte/reactivity";
  import {
    DEFAULT_HIGH,
    DEFAULT_LOW,
    keySlots,
    noteName,
    normalizeRange,
    spokenNoteName,
  } from "../keyboard";

  interface Props {
    /** Lowest MIDI note. Default C3. */
    low?: number;
    /** Highest MIDI note. Widened so the keyboard spans at least two octaves. Default C5. */
    high?: number;
    highlight?: readonly number[];
    /** Coloured keys by MIDI note, for a guide: the home note, the home chord, the answer. */
    marks?: Readonly<Record<number, "tonic" | "chord" | "target" | "right" | "wrong">>;
    /** Display only: the keys do nothing when pressed. */
    readonly?: boolean;
    labels?: "none" | "c-only" | "all";
    disabled?: boolean;
    /** Scrolled into view (centered) whenever it changes. */
    focusMidi?: number;
    onpress?: (midi: number, timeStamp: number) => void;
    onrelease?: (midi: number, timeStamp: number) => void;
    /** Called on press for audible feedback, e.g. to trigger the piano instrument. */
    playSound?: (midi: number) => void;
  }

  let {
    low = DEFAULT_LOW,
    high = DEFAULT_HIGH,
    highlight = [],
    marks = {},
    readonly = false,
    labels = "c-only",
    disabled = false,
    focusMidi,
    onpress,
    onrelease,
    playSound,
  }: Props = $props();

  const range = $derived(normalizeRange(low, high));
  const slots = $derived(keySlots(range.low, range.high));
  const highlighted = $derived(new Set(highlight));

  /** Key press counts per MIDI note (two fingers can hold the same key). */
  const pressedCount = new SvelteMap<number, number>();
  /** pointerId -> midi. Only the counts above drive rendering. */
  const active = new SvelteMap<number, number>();

  let scroller: HTMLDivElement | undefined = $state();

  function showLabel(midi: number): boolean {
    if (labels === "all") return true;
    return labels === "c-only" && midi % 12 === 0;
  }

  function down(event: PointerEvent, midi: number): void {
    if (disabled || readonly || active.has(event.pointerId)) return;
    event.preventDefault();
    try {
      (event.currentTarget as Element).setPointerCapture(event.pointerId);
    } catch {
      // Capture can fail for synthetic pointers; the key still works without it.
    }
    active.set(event.pointerId, midi);
    pressedCount.set(midi, (pressedCount.get(midi) ?? 0) + 1);
    playSound?.(midi);
    onpress?.(midi, event.timeStamp);
  }

  function up(event: PointerEvent): void {
    const midi = active.get(event.pointerId);
    if (midi === undefined) return;
    active.delete(event.pointerId);
    const count = (pressedCount.get(midi) ?? 1) - 1;
    if (count <= 0) pressedCount.delete(midi);
    else pressedCount.set(midi, count);
    onrelease?.(midi, event.timeStamp);
  }

  $effect(() => {
    if (disabled) {
      for (const [pointerId, midi] of [...active]) {
        active.delete(pointerId);
        pressedCount.delete(midi);
        onrelease?.(midi, performance.now());
      }
    }
  });

  $effect(() => {
    const target = focusMidi;
    const el = scroller;
    // Reading `slots` re-centres when the range changes (a new item), not only the focus.
    if (target === undefined || !el || slots.length === 0) return;
    const key = el.querySelector<HTMLElement>(`[data-midi="${String(target)}"]`);
    if (!key) return;
    const slot = key.closest<HTMLElement>(".slot") ?? key;
    const left = slot.offsetLeft + slot.offsetWidth / 2 - el.clientWidth / 2;
    el.scrollLeft = Math.max(0, left);
  });
</script>

<div
  class="keyboard"
  class:disabled
  class:readonly
  bind:this={scroller}
  role="group"
  aria-label={readonly ? "Piano keyboard guide" : "Piano keyboard"}
>
  <div class="keys">
    {#each slots as slot (slot.white)}
      <div class="slot">
        <button
          type="button"
          class="key white"
          class:pressed={(pressedCount.get(slot.white) ?? 0) > 0}
          class:highlight={highlighted.has(slot.white)}
          data-mark={marks[slot.white]}
          data-midi={slot.white}
          aria-label={spokenNoteName(slot.white)}
          aria-pressed={(pressedCount.get(slot.white) ?? 0) > 0}
          {disabled}
          tabindex="-1"
          onpointerdown={(e) => {
            down(e, slot.white);
          }}
          onpointerup={up}
          onpointercancel={up}
          onlostpointercapture={up}
        >
          {#if showLabel(slot.white)}<span class="label">{noteName(slot.white)}</span>{/if}
        </button>
        {#if slot.black !== undefined}
          {@const black = slot.black}
          <button
            type="button"
            class="key black"
            class:pressed={(pressedCount.get(black) ?? 0) > 0}
            class:highlight={highlighted.has(black)}
            data-mark={marks[black]}
            data-midi={black}
            aria-label={spokenNoteName(black)}
            aria-pressed={(pressedCount.get(black) ?? 0) > 0}
            {disabled}
            tabindex="-1"
            onpointerdown={(e) => {
              down(e, black);
            }}
            onpointerup={up}
            onpointercancel={up}
            onlostpointercapture={up}
          >
            {#if labels === "all"}<span class="label">{noteName(black)}</span>{/if}
          </button>
        {/if}
      </div>
    {/each}
  </div>
</div>

<style>
  .keyboard {
    overflow-x: auto;
    overflow-y: hidden;
    -webkit-overflow-scrolling: touch;
    touch-action: manipulation;
    user-select: none;
    -webkit-user-select: none;
    -webkit-touch-callout: none;
    -webkit-tap-highlight-color: transparent;
    border: 1px solid #888;
    border-radius: 6px;
    background: #222;
  }
  .keys {
    display: flex;
    width: max-content;
    min-width: 100%;
    height: 11rem;
  }
  .slot {
    position: relative;
    flex: 0 0 auto;
    width: 48px;
    height: 100%;
  }
  .key {
    touch-action: manipulation;
    user-select: none;
    -webkit-user-select: none;
    font: inherit;
    padding: 0;
    cursor: pointer;
    display: flex;
    align-items: flex-end;
    justify-content: center;
  }
  .white {
    width: 100%;
    height: 100%;
    background: #fafafa;
    color: #333;
    border: 1px solid #555;
    border-radius: 0 0 5px 5px;
    padding-bottom: 0.4rem;
  }
  .black {
    position: absolute;
    top: 0;
    left: calc(100% - 15px);
    width: 30px;
    height: 62%;
    z-index: 2;
    background: #111;
    color: #eee;
    border: 1px solid #000;
    border-radius: 0 0 4px 4px;
    padding-bottom: 0.3rem;
    font-size: 0.65rem;
  }
  .white.highlight {
    background: #ffe9a8;
  }
  .black.highlight {
    background: #b8860b;
  }
  .white.pressed {
    background: #8ec5ff;
  }
  .black.pressed {
    background: #1f6fd1;
  }
  .readonly .key {
    cursor: default;
  }
  .white[data-mark="tonic"] {
    background: #f6b73c;
  }
  .black[data-mark="tonic"] {
    background: #c07d00;
  }
  .white[data-mark="chord"] {
    background: #ffe9a8;
  }
  .black[data-mark="chord"] {
    background: #b8860b;
  }
  .white[data-mark="target"],
  .white[data-mark="right"] {
    background: #8fd9a0;
  }
  .black[data-mark="target"],
  .black[data-mark="right"] {
    background: #1d8a3b;
  }
  .white[data-mark="wrong"] {
    background: #f19999;
  }
  .black[data-mark="wrong"] {
    background: #b52a2a;
  }
  .disabled .key {
    opacity: 0.5;
    cursor: not-allowed;
  }
  .label {
    pointer-events: none;
    font-size: 0.75rem;
  }
</style>
