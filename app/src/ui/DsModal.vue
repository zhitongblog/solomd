<script setup lang="ts">
import { ref, watch, nextTick, onBeforeUnmount } from 'vue';

const props = withDefaults(
  defineProps<{
    modelValue: boolean;
    title?: string;
    closeOnBackdrop?: boolean;
    width?: string;
    /**
     * Whether to teleport the modal to <body>. Defaults to true (the modal
     * self-teleports, so callers don't need their own <Teleport> wrapper).
     * Pass `false` when the caller is already inside a <Teleport to="body">
     * (e.g. a dialog mounted under an existing teleport in App.vue) to avoid
     * a redundant nested teleport.
     */
    teleport?: boolean;
  }>(),
  { closeOnBackdrop: true, width: '480px', teleport: true },
);

const emit = defineEmits<{ 'update:modelValue': [boolean] }>();

const panelRef = ref<HTMLElement | null>(null);
let lastFocused: HTMLElement | null = null;

function close() {
  emit('update:modelValue', false);
}

function focusables(): HTMLElement[] {
  if (!panelRef.value) return [];
  return Array.from(
    panelRef.value.querySelectorAll<HTMLElement>(
      'a[href],button:not([disabled]),textarea,input,select,[tabindex]:not([tabindex="-1"])',
    ),
  ).filter((el) => el.offsetParent !== null || el === document.activeElement);
}

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape') {
    e.preventDefault();
    e.stopPropagation();
    close();
    return;
  }
  if (e.key === 'Tab') {
    const items = focusables();
    if (items.length === 0) {
      e.preventDefault();
      return;
    }
    const first = items[0];
    const last = items[items.length - 1];
    const active = document.activeElement as HTMLElement;
    if (e.shiftKey && active === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && active === last) {
      e.preventDefault();
      first.focus();
    }
  }
}

function onBackdrop() {
  if (props.closeOnBackdrop) close();
}

watch(
  () => props.modelValue,
  async (open) => {
    if (open) {
      lastFocused = document.activeElement as HTMLElement;
      document.addEventListener('keydown', onKeydown, true);
      await nextTick();
      // A dialog can name its default control with `data-autofocus` (e.g. the
      // Save button in UnsavedDialog, #357); otherwise the first focusable —
      // which is the header × button — gets focus.
      const preferred = panelRef.value?.querySelector<HTMLElement>('[data-autofocus]');
      (preferred ?? focusables()[0] ?? panelRef.value)?.focus();
    } else {
      document.removeEventListener('keydown', onKeydown, true);
      lastFocused?.focus?.();
      lastFocused = null;
    }
  },
);

onBeforeUnmount(() => {
  document.removeEventListener('keydown', onKeydown, true);
});
</script>

<template>
  <Teleport to="body" :disabled="!teleport">
    <div v-if="modelValue" class="ds-modal" role="presentation">
      <div class="ds-modal__backdrop" @click="onBackdrop" />
      <div
        ref="panelRef"
        class="ds-modal__panel"
        role="dialog"
        aria-modal="true"
        :aria-label="title"
        tabindex="-1"
        :style="{ width }"
      >
        <header v-if="title || $slots.header" class="ds-modal__head">
          <slot name="header">
            <h2 class="ds-modal__title">{{ title }}</h2>
          </slot>
          <button
            class="ds-modal__close"
            type="button"
            aria-label="Close"
            @click="close"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><line x1="6" y1="6" x2="18" y2="18" /><line x1="18" y1="6" x2="6" y2="18" /></svg>
          </button>
        </header>
        <div class="ds-modal__body">
          <slot />
        </div>
        <footer v-if="$slots.footer" class="ds-modal__foot">
          <slot name="footer" />
        </footer>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
/* 5.0 (spec §6): radius 14, padding 24, title 17/600, --sh-modal on --bg-pop;
   backdrop --scrim (.28 light / .5 dark). Opens with a 180ms fade + scale
   .98→1 (keyframes in styles/menus.css); reduced motion turns it off. */
.ds-modal {
  position: fixed;
  inset: 0;
  z-index: var(--z-modal);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: var(--sp-5);
}
.ds-modal__backdrop {
  position: absolute;
  inset: 0;
  background: var(--scrim);
  animation: sm-fade-in var(--dur) var(--ease-out);
}
.ds-modal__panel {
  position: relative;
  box-sizing: border-box;
  max-width: calc(100vw - var(--sp-6));
  max-height: calc(100vh - var(--sp-6));
  display: flex;
  flex-direction: column;
  background: var(--bg-pop);
  color: var(--text);
  border: var(--bd-hair);
  border-radius: var(--r-xl);
  box-shadow: var(--sh-modal);
  overflow: hidden;
  animation: sm-dialog-in var(--dur) var(--ease-out);
}
.ds-modal__panel:focus-visible {
  outline: none;
}
.ds-modal__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--sp-3);
  padding: 20px var(--sp-5) 4px;
}
.ds-modal__title {
  margin: 0;
  font-size: 17px;
  font-weight: 600;
  letter-spacing: -0.01em;
  line-height: 1.3;
  color: var(--text);
}
.ds-modal__close {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
  width: 28px;
  height: 28px;
  margin-right: -6px;
  padding: 0;
  background: transparent;
  border: 0;
  border-radius: var(--r-sm);
  color: var(--text-3);
  cursor: default;
}
.ds-modal__close:hover {
  background: var(--fill-1);
  color: var(--text);
}
.ds-modal__close:focus-visible {
  outline: none;
  box-shadow: var(--ring);
}
.ds-modal__body {
  padding: var(--sp-3) var(--sp-5) var(--sp-5);
  overflow-y: auto;
  color: var(--text);
  font-size: 13px;
  line-height: 1.5;
}
.ds-modal__panel > .ds-modal__body:first-child {
  padding-top: var(--sp-5);
}
.ds-modal__foot {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: var(--sp-2);
  padding: 0 var(--sp-5) var(--sp-5);
}
@media (prefers-reduced-motion: reduce) {
  .ds-modal__backdrop,
  .ds-modal__panel {
    animation: none;
  }
}
</style>
