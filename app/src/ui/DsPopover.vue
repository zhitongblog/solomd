<script setup lang="ts">
import { ref, nextTick, watch, onBeforeUnmount } from 'vue';

const props = withDefaults(
  defineProps<{
    align?: 'start' | 'end';
  }>(),
  { align: 'start' },
);

const open = ref(false);
const triggerRef = ref<HTMLElement | null>(null);
const popRef = ref<HTMLElement | null>(null);
const pos = ref<{ top: number; left: number }>({ top: 0, left: 0 });

async function position() {
  const el = triggerRef.value;
  if (!el) return;
  const r = el.getBoundingClientRect();
  await nextTick();
  const w = popRef.value?.offsetWidth ?? r.width;
  let left = props.align === 'end' ? r.right - w : r.left;
  left = Math.max(8, Math.min(left, window.innerWidth - w - 8));
  pos.value = { top: r.bottom + 6, left };
}

async function toggle() {
  open.value = !open.value;
  if (open.value) await position();
}

function close() {
  open.value = false;
}

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape') {
    e.preventDefault();
    close();
    triggerRef.value?.focus();
  }
}

function onDocPointer(e: PointerEvent) {
  const t = e.target as Node;
  if (triggerRef.value?.contains(t) || popRef.value?.contains(t)) return;
  close();
}

watch(open, (v) => {
  if (v) {
    document.addEventListener('pointerdown', onDocPointer, true);
    window.addEventListener('resize', close);
    window.addEventListener('scroll', close, true);
  } else {
    document.removeEventListener('pointerdown', onDocPointer, true);
    window.removeEventListener('resize', close);
    window.removeEventListener('scroll', close, true);
  }
});

onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', onDocPointer, true);
  window.removeEventListener('resize', close);
  window.removeEventListener('scroll', close, true);
});

defineExpose({ close });
</script>

<template>
  <span class="ds-popover">
    <span
      ref="triggerRef"
      class="ds-popover__trigger"
      role="button"
      tabindex="0"
      :aria-expanded="open"
      aria-haspopup="dialog"
      @click="toggle"
      @keydown.enter.prevent="toggle"
      @keydown.space.prevent="toggle"
    >
      <slot name="trigger" :open="open" />
    </span>

    <Teleport to="body">
      <div
        v-if="open"
        ref="popRef"
        class="ds-popover__panel"
        role="dialog"
        tabindex="-1"
        :style="{ top: `${pos.top}px`, left: `${pos.left}px` }"
        @keydown="onKeydown"
      >
        <slot :close="close" />
      </div>
    </Teleport>
  </span>
</template>

<style scoped>
.ds-popover {
  display: inline-flex;
}
.ds-popover__trigger {
  display: inline-flex;
  border-radius: var(--r-md);
}
.ds-popover__trigger:focus-visible {
  outline: none;
  box-shadow: var(--ring);
}
</style>

<style>
.ds-popover__panel {
  position: fixed;
  z-index: var(--z-pop);
  padding: var(--sp-3);
  background: var(--bg-elev);
  border: 1px solid var(--border);
  border-radius: var(--r-md);
  box-shadow: var(--sh-pop);
  color: var(--text);
  font-size: 13px;
}
.ds-popover__panel:focus-visible {
  outline: none;
}
</style>
