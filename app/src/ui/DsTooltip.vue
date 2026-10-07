<script setup lang="ts">
import { ref, nextTick, onBeforeUnmount } from 'vue';

const props = withDefaults(
  defineProps<{
    label: string;
    placement?: 'top' | 'bottom';
    delay?: number;
  }>(),
  { placement: 'top', delay: 300 },
);

const visible = ref(false);
const anchorRef = ref<HTMLElement | null>(null);
const tipRef = ref<HTMLElement | null>(null);
const pos = ref<{ top: number; left: number }>({ top: 0, left: 0 });
let timer: ReturnType<typeof setTimeout> | null = null;

async function place() {
  const el = anchorRef.value;
  if (!el) return;
  const r = el.getBoundingClientRect();
  await nextTick();
  const tw = tipRef.value?.offsetWidth ?? 0;
  const th = tipRef.value?.offsetHeight ?? 0;
  let left = r.left + r.width / 2 - tw / 2;
  left = Math.max(8, Math.min(left, window.innerWidth - tw - 8));
  const top =
    props.placement === 'top' ? r.top - th - 6 : r.bottom + 6;
  pos.value = { top, left };
}

function show() {
  if (timer) clearTimeout(timer);
  timer = setTimeout(async () => {
    visible.value = true;
    await place();
  }, props.delay);
}

function hide() {
  if (timer) clearTimeout(timer);
  timer = null;
  visible.value = false;
}

onBeforeUnmount(() => {
  if (timer) clearTimeout(timer);
});
</script>

<template>
  <span
    ref="anchorRef"
    class="ds-tooltip__anchor"
    @mouseenter="show"
    @mouseleave="hide"
    @focusin="show"
    @focusout="hide"
  >
    <slot />
    <Teleport to="body">
      <span
        v-if="visible"
        ref="tipRef"
        class="ds-tooltip"
        role="tooltip"
        :style="{ top: `${pos.top}px`, left: `${pos.left}px` }"
      >{{ label }}</span>
    </Teleport>
  </span>
</template>

<style scoped>
.ds-tooltip__anchor {
  display: inline-flex;
}
</style>

<style>
/* Teleported to <body>, so global but namespaced. 5.0: a small pop surface,
   not an inverted chip — --text on --bg-pop, radius 6, 12px. */
.ds-tooltip {
  position: fixed;
  z-index: var(--z-toast);
  padding: 4px 8px;
  background: var(--bg-pop);
  color: var(--text);
  border: var(--bd-hair);
  border-radius: var(--r-sm);
  box-shadow: var(--sh-pop);
  font-family: var(--font-ui, inherit);
  font-size: 12px;
  line-height: 1.35;
  pointer-events: none;
  white-space: nowrap;
  animation: ds-tip-in var(--dur-fast) var(--ease-out);
}
@keyframes ds-tip-in {
  from {
    opacity: 0;
  }
}
@media (prefers-reduced-motion: reduce) {
  .ds-tooltip {
    animation: none;
  }
}
</style>
