<script setup lang="ts">
import { ref, watch, nextTick, onMounted, onBeforeUnmount } from 'vue';

export interface DsTab {
  value: string;
  label: string;
  disabled?: boolean;
}

const props = defineProps<{
  modelValue: string;
  tabs: DsTab[];
}>();

const emit = defineEmits<{ 'update:modelValue': [string] }>();

const tablistRef = ref<HTMLElement | null>(null);

/* The segmented thumb is one element that slides between segments (spec §1:
 * "Thumb slides between segments (180 ms)"). It is measured from the active
 * button, so segments can have any width. `ready` stays false until the
 * first measurement so the thumb does not animate in from x=0 on mount. */
const thumb = ref<{ x: number; w: number } | null>(null);
const ready = ref(false);

function measure() {
  const list = tablistRef.value;
  if (!list) return;
  const btn = list.querySelector<HTMLElement>(`[data-tab="${CSS.escape(props.modelValue)}"]`);
  if (!btn) {
    thumb.value = null;
    return;
  }
  thumb.value = { x: btn.offsetLeft, w: btn.offsetWidth };
}

let ro: ResizeObserver | null = null;
onMounted(async () => {
  await nextTick();
  measure();
  requestAnimationFrame(() => (ready.value = true));
  if (typeof ResizeObserver !== 'undefined' && tablistRef.value) {
    ro = new ResizeObserver(() => measure());
    ro.observe(tablistRef.value);
  }
});
onBeforeUnmount(() => ro?.disconnect());
watch(
  () => [props.modelValue, props.tabs.map((t) => t.label).join('\u0000')],
  async () => {
    await nextTick();
    measure();
  },
);

function select(tab: DsTab) {
  if (tab.disabled) return;
  emit('update:modelValue', tab.value);
}

function onKeydown(e: KeyboardEvent) {
  if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft' && e.key !== 'Home' && e.key !== 'End')
    return;
  e.preventDefault();
  const enabled = props.tabs.filter((t) => !t.disabled);
  if (enabled.length === 0) return;
  const curIdx = enabled.findIndex((t) => t.value === props.modelValue);
  let next = curIdx;
  if (e.key === 'ArrowRight') next = (curIdx + 1) % enabled.length;
  else if (e.key === 'ArrowLeft') next = (curIdx - 1 + enabled.length) % enabled.length;
  else if (e.key === 'Home') next = 0;
  else if (e.key === 'End') next = enabled.length - 1;
  const target = enabled[next];
  emit('update:modelValue', target.value);
  requestAnimationFrame(() => {
    tablistRef.value
      ?.querySelector<HTMLElement>(`[data-tab="${CSS.escape(target.value)}"]`)
      ?.focus();
  });
}
</script>

<template>
  <div class="ds-tabs">
    <div ref="tablistRef" class="ds-tabs__list" role="tablist" @keydown="onKeydown">
      <span
        v-if="thumb"
        class="ds-tabs__thumb"
        :class="{ 'ds-tabs__thumb--ready': ready }"
        aria-hidden="true"
        :style="{ width: `${thumb.w}px`, transform: `translateX(${thumb.x}px)` }"
      />
      <button
        v-for="tab in tabs"
        :key="tab.value"
        class="ds-tabs__tab"
        :class="{ 'ds-tabs__tab--active': tab.value === modelValue }"
        type="button"
        role="tab"
        :data-tab="tab.value"
        :aria-selected="tab.value === modelValue"
        :tabindex="tab.value === modelValue ? 0 : -1"
        :disabled="tab.disabled"
        @click="select(tab)"
      >
        {{ tab.label }}
      </button>
    </div>
    <div v-if="$slots.default" class="ds-tabs__panel" role="tabpanel">
      <slot :active="modelValue" />
    </div>
  </div>
</template>

<style scoped>
/* 5.0 segmented control: --fill-1 track (radius 8), a --bg thumb (radius 6,
   --sh-thumb) that slides between segments in 180ms. */
.ds-tabs {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
}
.ds-tabs__list {
  position: relative;
  display: inline-flex;
  align-items: stretch;
  gap: 0;
  height: 28px;
  padding: 2px;
  box-sizing: border-box;
  background: var(--fill-1);
  border-radius: var(--r-md);
  isolation: isolate;
}
.ds-tabs__thumb {
  position: absolute;
  top: 2px;
  bottom: 2px;
  left: 0;
  z-index: 0;
  background: var(--bg);
  border-radius: var(--r-sm);
  box-shadow: var(--sh-thumb);
  pointer-events: none;
}
.ds-tabs__thumb--ready {
  transition: transform var(--dur) var(--ease-out), width var(--dur) var(--ease-out);
}
.ds-tabs__tab {
  position: relative;
  z-index: 1;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 56px;
  padding: 0 12px;
  background: transparent;
  border: 0;
  border-radius: var(--r-sm);
  font-family: var(--font-ui, inherit);
  font-size: 12px;
  font-weight: 500;
  color: var(--text-2);
  cursor: default;
  transition: color var(--dur-fast) var(--ease);
}
.ds-tabs__tab:hover:not(:disabled) {
  background: transparent;
  color: var(--text);
}
/* Same weight as the idle segments: a bolder label would change the segment's
   width under the sliding thumb. */
.ds-tabs__tab--active {
  color: var(--text);
}
.ds-tabs__tab:disabled {
  opacity: 0.45;
}
.ds-tabs__tab:focus-visible {
  outline: none;
  box-shadow: var(--ring);
}
.ds-tabs__panel {
  align-self: stretch;
  padding: var(--sp-4) 0;
}
@media (prefers-reduced-motion: reduce) {
  .ds-tabs__thumb--ready {
    transition: none;
  }
}
</style>
