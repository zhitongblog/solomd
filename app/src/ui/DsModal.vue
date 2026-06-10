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
      (focusables()[0] ?? panelRef.value)?.focus();
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
          >×</button>
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
  background: rgba(0, 0, 0, 0.4);
  animation: ds-modal-fade var(--dur) var(--ease);
}
.ds-modal__panel {
  position: relative;
  max-width: calc(100vw - var(--sp-6));
  max-height: calc(100vh - var(--sp-6));
  display: flex;
  flex-direction: column;
  background: var(--bg-elev);
  border: 1px solid var(--border);
  border-radius: var(--r-lg);
  box-shadow: var(--sh-pop);
  animation: ds-modal-pop var(--dur) var(--ease);
}
.ds-modal__panel:focus-visible {
  outline: none;
}
.ds-modal__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--sp-3);
  padding: var(--sp-4) var(--sp-5);
  border-bottom: 1px solid var(--border);
}
.ds-modal__title {
  margin: 0;
  font-size: 15px;
  font-weight: 600;
  color: var(--text);
}
.ds-modal__close {
  background: transparent;
  border: none;
  color: var(--text-muted);
  font-size: 20px;
  line-height: 1;
  cursor: pointer;
  border-radius: var(--r-sm);
  width: 28px;
  height: 28px;
}
.ds-modal__close:hover {
  background: var(--bg-hover);
  color: var(--text);
}
.ds-modal__close:focus-visible {
  outline: none;
  box-shadow: var(--ring);
}
.ds-modal__body {
  padding: var(--sp-5);
  overflow-y: auto;
  color: var(--text);
  font-size: 13px;
}
.ds-modal__foot {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: var(--sp-2);
  padding: var(--sp-4) var(--sp-5);
  border-top: 1px solid var(--border);
}
@keyframes ds-modal-fade {
  from {
    opacity: 0;
  }
}
@keyframes ds-modal-pop {
  from {
    opacity: 0;
    transform: translateY(8px) scale(0.98);
  }
}
</style>
