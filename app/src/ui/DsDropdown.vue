<script setup lang="ts">
import { ref, nextTick, onBeforeUnmount, watch } from 'vue';

export interface DsDropdownItem {
  value: string;
  label: string;
  disabled?: boolean;
}

const props = withDefaults(
  defineProps<{
    items: DsDropdownItem[];
    align?: 'start' | 'end';
  }>(),
  { align: 'start' },
);

const emit = defineEmits<{ select: [string] }>();

const open = ref(false);
const triggerRef = ref<HTMLElement | null>(null);
const menuRef = ref<HTMLElement | null>(null);
const activeIndex = ref(-1);
const pos = ref<{ top: number; left: number; minWidth: number }>({
  top: 0,
  left: 0,
  minWidth: 0,
});

const enabledIndexes = () =>
  props.items.map((it, i) => (it.disabled ? -1 : i)).filter((i) => i >= 0);

async function position() {
  const el = triggerRef.value;
  if (!el) return;
  const r = el.getBoundingClientRect();
  await nextTick();
  const menuW = menuRef.value?.offsetWidth ?? r.width;
  let left = props.align === 'end' ? r.right - menuW : r.left;
  left = Math.max(8, Math.min(left, window.innerWidth - menuW - 8));
  pos.value = { top: r.bottom + 4, left, minWidth: r.width };
}

async function toggle() {
  open.value = !open.value;
  if (open.value) {
    activeIndex.value = enabledIndexes()[0] ?? -1;
    await position();
  }
}

function close() {
  open.value = false;
  activeIndex.value = -1;
}

function choose(item: DsDropdownItem) {
  if (item.disabled) return;
  emit('select', item.value);
  close();
}

function moveActive(delta: number) {
  const enabled = enabledIndexes();
  if (enabled.length === 0) return;
  const cur = enabled.indexOf(activeIndex.value);
  const next = cur < 0 ? 0 : (cur + delta + enabled.length) % enabled.length;
  activeIndex.value = enabled[next];
}

function onTriggerKeydown(e: KeyboardEvent) {
  if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    if (!open.value) toggle();
  }
}

function onMenuKeydown(e: KeyboardEvent) {
  switch (e.key) {
    case 'ArrowDown':
      e.preventDefault();
      moveActive(1);
      break;
    case 'ArrowUp':
      e.preventDefault();
      moveActive(-1);
      break;
    case 'Enter':
      e.preventDefault();
      if (activeIndex.value >= 0) choose(props.items[activeIndex.value]);
      break;
    case 'Escape':
      e.preventDefault();
      close();
      triggerRef.value?.focus();
      break;
    case 'Tab':
      close();
      break;
  }
}

function onDocPointer(e: PointerEvent) {
  const t = e.target as Node;
  if (triggerRef.value?.contains(t) || menuRef.value?.contains(t)) return;
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
</script>

<template>
  <span class="ds-dropdown">
    <span
      ref="triggerRef"
      class="ds-dropdown__trigger"
      role="button"
      tabindex="0"
      :aria-expanded="open"
      aria-haspopup="menu"
      @click="toggle"
      @keydown="onTriggerKeydown"
    >
      <slot name="trigger" :open="open" />
    </span>

    <Teleport to="body">
      <ul
        v-if="open"
        ref="menuRef"
        class="ds-dropdown__menu"
        role="menu"
        tabindex="-1"
        :style="{
          top: `${pos.top}px`,
          left: `${pos.left}px`,
          minWidth: `${pos.minWidth}px`,
        }"
        @keydown="onMenuKeydown"
      >
        <li
          v-for="(it, i) in items"
          :key="it.value"
          class="ds-dropdown__item"
          :class="{
            'ds-dropdown__item--active': i === activeIndex,
            'ds-dropdown__item--disabled': it.disabled,
          }"
          role="menuitem"
          :aria-disabled="it.disabled || undefined"
          @mouseenter="!it.disabled && (activeIndex = i)"
          @click="choose(it)"
        >
          <slot name="item" :item="it">{{ it.label }}</slot>
        </li>
      </ul>
    </Teleport>
  </span>
</template>

<style scoped>
.ds-dropdown {
  display: inline-flex;
}
.ds-dropdown__trigger {
  display: inline-flex;
  border-radius: var(--r-md);
}
.ds-dropdown__trigger:focus-visible {
  outline: none;
  box-shadow: var(--ring);
}
</style>

<style>
/* Teleported to body, so menu styles are global but namespaced. */
.ds-dropdown__menu {
  position: fixed;
  z-index: var(--z-pop);
  margin: 0;
  padding: var(--sp-1);
  list-style: none;
  background: var(--bg-elev);
  border: 1px solid var(--border);
  border-radius: var(--r-md);
  box-shadow: var(--sh-pop);
  max-height: 60vh;
  overflow-y: auto;
}
.ds-dropdown__item {
  padding: var(--sp-2) var(--sp-3);
  border-radius: var(--r-sm);
  font-size: 13px;
  color: var(--text);
  cursor: pointer;
  white-space: nowrap;
}
.ds-dropdown__item--active {
  background: var(--bg-hover);
}
.ds-dropdown__item--disabled {
  color: var(--text-faint);
  cursor: default;
}
</style>
