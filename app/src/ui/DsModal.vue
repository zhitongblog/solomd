<script setup lang="ts">
import { ref, computed, watch, nextTick, onBeforeUnmount } from 'vue';

interface PersistedModalBounds {
  width?: number;
  height?: number;
  x?: number;
  y?: number;
}

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
    /** #544 — Allow dragging edges/corners to resize the dialog panel. */
    resizable?: boolean;
    /** #544 — Allow dragging the modal header to reposition the dialog panel. */
    draggable?: boolean;
    /** Minimum width in px when resizing (default 420). */
    minWidth?: number;
    /** Minimum height in px when resizing (default 320). */
    minHeight?: number;
    /** localStorage key used to persist size and position across openings. */
    persistKey?: string;
  }>(),
  {
    closeOnBackdrop: true,
    width: '480px',
    teleport: true,
    resizable: false,
    draggable: false,
    minWidth: 420,
    minHeight: 320,
  },
);

const emit = defineEmits<{ 'update:modelValue': [boolean] }>();
// The root is a <Teleport>, which cannot inherit attributes — forward
// `class` / `data-*` from the caller to the overlay element instead, so
// `<DsModal class="settings-modal">` actually lands on the dialog.
defineOptions({ inheritAttrs: false });

const panelRef = ref<HTMLElement | null>(null);
let lastFocused: HTMLElement | null = null;

const customBounds = ref<PersistedModalBounds | null>(null);
const isInteracting = ref(false);
let cleanupPointerListeners: (() => void) | null = null;

function isNarrowViewport(): boolean {
  return (
    typeof document !== 'undefined' &&
    (document.documentElement.classList.contains('narrow-viewport') || window.innerWidth <= 640)
  );
}

function clampBounds(b: PersistedModalBounds): PersistedModalBounds {
  if (typeof window === 'undefined') return b;
  const margin = 12;
  const vw = Math.max(320, window.innerWidth);
  const vh = Math.max(240, window.innerHeight);
  const maxW = Math.max(props.minWidth, vw - margin * 2);
  const maxH = Math.max(props.minHeight, vh - margin * 2);
  const next: PersistedModalBounds = {};
  if (typeof b.width === 'number' && Number.isFinite(b.width)) {
    next.width = Math.round(Math.min(Math.max(b.width, props.minWidth), maxW));
  }
  if (typeof b.height === 'number' && Number.isFinite(b.height)) {
    next.height = Math.round(Math.min(Math.max(b.height, props.minHeight), maxH));
  }
  if (typeof b.x === 'number' && Number.isFinite(b.x) && typeof b.y === 'number' && Number.isFinite(b.y)) {
    const w = next.width ?? panelRef.value?.offsetWidth ?? 600;
    const h = next.height ?? panelRef.value?.offsetHeight ?? 480;
    next.x = Math.round(Math.min(Math.max(b.x, margin), Math.max(margin, vw - w - margin)));
    next.y = Math.round(Math.min(Math.max(b.y, margin), Math.max(margin, vh - h - margin)));
  }
  return next;
}

function loadPersistedBounds() {
  if (!props.persistKey || isNarrowViewport()) {
    customBounds.value = null;
    return;
  }
  try {
    const raw = localStorage.getItem(props.persistKey);
    if (!raw) {
      customBounds.value = null;
      return;
    }
    const parsed = JSON.parse(raw) as PersistedModalBounds;
    if (parsed && typeof parsed === 'object') {
      customBounds.value = clampBounds(parsed);
    }
  } catch {
    customBounds.value = null;
  }
}

function savePersistedBounds() {
  if (!props.persistKey || !customBounds.value) return;
  try {
    localStorage.setItem(props.persistKey, JSON.stringify(customBounds.value));
  } catch {
    // Ignore storage quota errors
  }
}

const panelStyle = computed(() => {
  const b = customBounds.value;
  if (!b || isNarrowViewport()) {
    return { width: props.width };
  }
  const style: Record<string, string> = {
    width: b.width ? `${b.width}px` : props.width,
  };
  if (b.height) {
    style.height = `${b.height}px`;
  }
  if (typeof b.x === 'number' && typeof b.y === 'number') {
    style.position = 'fixed';
    style.left = `${b.x}px`;
    style.top = `${b.y}px`;
    style.margin = '0';
  }
  return style;
});

type ResizeDir = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';
const resizeDirs: ResizeDir[] = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'];

function startResize(dir: ResizeDir, e: PointerEvent) {
  if (!props.resizable || isNarrowViewport() || e.button !== 0 || !panelRef.value) return;
  e.preventDefault();
  e.stopPropagation();

  const rect = panelRef.value.getBoundingClientRect();
  const startX = e.clientX;
  const startY = e.clientY;
  const startLeft = rect.left;
  const startTop = rect.top;
  const startWidth = rect.width;
  const startHeight = rect.height;
  const margin = 12;

  isInteracting.value = true;

  const onMove = (ev: PointerEvent) => {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const dx = ev.clientX - startX;
    const dy = ev.clientY - startY;

    let newLeft = startLeft;
    let newTop = startTop;
    let newWidth = startWidth;
    let newHeight = startHeight;

    if (dir.includes('e')) {
      const maxW = Math.max(props.minWidth, vw - startLeft - margin);
      newWidth = Math.min(Math.max(startWidth + dx, props.minWidth), maxW);
    } else if (dir.includes('w')) {
      const rightEdge = startLeft + startWidth;
      const maxW = Math.max(props.minWidth, rightEdge - margin);
      newWidth = Math.min(Math.max(startWidth - dx, props.minWidth), maxW);
      newLeft = rightEdge - newWidth;
    }

    if (dir.includes('s')) {
      const maxH = Math.max(props.minHeight, vh - startTop - margin);
      newHeight = Math.min(Math.max(startHeight + dy, props.minHeight), maxH);
    } else if (dir.includes('n')) {
      const bottomEdge = startTop + startHeight;
      const maxH = Math.max(props.minHeight, bottomEdge - margin);
      newHeight = Math.min(Math.max(startHeight - dy, props.minHeight), maxH);
      newTop = bottomEdge - newHeight;
    }

    customBounds.value = {
      width: Math.round(newWidth),
      height: Math.round(newHeight),
      x: Math.round(newLeft),
      y: Math.round(newTop),
    };
  };

  const onUp = () => {
    isInteracting.value = false;
    savePersistedBounds();
    cleanupPointerListeners?.();
    cleanupPointerListeners = null;
  };

  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
  window.addEventListener('pointercancel', onUp);
  cleanupPointerListeners = () => {
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    window.removeEventListener('pointercancel', onUp);
  };
}

function startDragHeader(e: PointerEvent) {
  if (!props.draggable || isNarrowViewport() || e.button !== 0 || !panelRef.value) return;
  const target = e.target as HTMLElement | null;
  if (target?.closest('button, a, input, select, textarea, [role="button"]')) return;
  e.preventDefault();

  const rect = panelRef.value.getBoundingClientRect();
  const startX = e.clientX;
  const startY = e.clientY;
  const startLeft = rect.left;
  const startTop = rect.top;
  const startWidth = rect.width;
  const startHeight = rect.height;
  const margin = 12;

  isInteracting.value = true;

  const onMove = (ev: PointerEvent) => {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const dx = ev.clientX - startX;
    const dy = ev.clientY - startY;
    const newLeft = Math.min(
      Math.max(startLeft + dx, margin),
      Math.max(margin, vw - startWidth - margin),
    );
    const newTop = Math.min(
      Math.max(startTop + dy, margin),
      Math.max(margin, vh - startHeight - margin),
    );
    customBounds.value = {
      width: Math.round(customBounds.value?.width ?? startWidth),
      height: Math.round(customBounds.value?.height ?? startHeight),
      x: Math.round(newLeft),
      y: Math.round(newTop),
    };
  };

  const onUp = () => {
    isInteracting.value = false;
    savePersistedBounds();
    cleanupPointerListeners?.();
    cleanupPointerListeners = null;
  };

  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
  window.addEventListener('pointercancel', onUp);
  cleanupPointerListeners = () => {
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    window.removeEventListener('pointercancel', onUp);
  };
}

function onWindowResize() {
  if (customBounds.value && !isNarrowViewport()) {
    customBounds.value = clampBounds(customBounds.value);
  }
}

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
      loadPersistedBounds();
      lastFocused = document.activeElement as HTMLElement;
      document.addEventListener('keydown', onKeydown, true);
      window.addEventListener('resize', onWindowResize);
      await nextTick();
      // A dialog can name its default control with `data-autofocus` (e.g. the
      // Save button in UnsavedDialog, #357); otherwise its first text field;
      // otherwise the panel itself.
      const preferred = panelRef.value?.querySelector<HTMLElement>('[data-autofocus]');
      // Never the header × or an inline task-list checkbox (#543): only focus
      // text-like inputs / selects / textareas by default.
      const first = focusables().find((el) =>
        el.matches(
          'input:not([type="checkbox"]):not([type="radio"]):not([type="button"]):not([type="submit"]):not([type="reset"]):not([type="range"]):not([type="color"]):not([type="file"]), select, textarea',
        ),
      );
      (preferred ?? first ?? panelRef.value)?.focus();
    } else {
      cleanupPointerListeners?.();
      cleanupPointerListeners = null;
      isInteracting.value = false;
      document.removeEventListener('keydown', onKeydown, true);
      window.removeEventListener('resize', onWindowResize);
      lastFocused?.focus?.();
      lastFocused = null;
    }
  },
  { immediate: true },
);

onBeforeUnmount(() => {
  cleanupPointerListeners?.();
  cleanupPointerListeners = null;
  document.removeEventListener('keydown', onKeydown, true);
  window.removeEventListener('resize', onWindowResize);
});
</script>

<template>
  <Teleport to="body" :disabled="!teleport">
    <div v-if="modelValue" class="ds-modal" role="presentation" v-bind="$attrs">
      <div class="ds-modal__backdrop" @click="onBackdrop" />
      <div
        ref="panelRef"
        class="ds-modal__panel"
        :class="{
          'ds-modal__panel--resizable': resizable,
          'ds-modal__panel--interacting': isInteracting,
        }"
        role="dialog"
        aria-modal="true"
        :aria-label="title"
        tabindex="-1"
        :style="panelStyle"
      >
        <template v-if="resizable">
          <div
            v-for="dir in resizeDirs"
            :key="dir"
            class="ds-modal__resize-handle"
            :class="`ds-modal__resize-handle--${dir}`"
            @pointerdown="startResize(dir, $event)"
          />
        </template>
        <header
          v-if="title || $slots.header"
          class="ds-modal__head"
          :class="{ 'ds-modal__head--draggable': draggable }"
          @pointerdown="startDragHeader"
        >
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
  /* #479: Keep teleported modal panels below the Android/iOS status bar so the
     top border and ✕ close button are never obscured on phones. */
  padding-top: calc(max(env(safe-area-inset-top, 0px), var(--android-safe-top, 0px)) + var(--sp-4));
  padding-bottom: calc(max(env(safe-area-inset-bottom, 0px), var(--android-safe-bottom, 0px)) + var(--sp-4));
  padding-left: calc(env(safe-area-inset-left, 0px) + var(--sp-4));
  padding-right: calc(env(safe-area-inset-right, 0px) + var(--sp-4));
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
  /* #426 / #125: Measure against .ds-modal (fixed inset: 0; padding: --sp-5)
     instead of 100vw/100vh, which can remain stuck at a Split View / Stage
     Manager scene width on iPadOS 26 and scales wrongly under CSS zoom. */
  max-width: 100%;
  max-height: 100%;
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
.ds-modal__panel--interacting {
  user-select: none;
}
.ds-modal__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--sp-3);
  padding: 20px var(--sp-5) 4px;
}
.ds-modal__head--draggable {
  cursor: move;
  user-select: none;
}
:root.narrow-viewport .ds-modal__head--draggable {
  cursor: default;
}
.ds-modal__resize-handle {
  position: absolute;
  z-index: 20;
  touch-action: none;
}
:root.narrow-viewport .ds-modal__resize-handle {
  display: none;
}
.ds-modal__resize-handle--n {
  top: 0;
  left: 10px;
  right: 10px;
  height: 6px;
  cursor: ns-resize;
}
.ds-modal__resize-handle--s {
  bottom: 0;
  left: 10px;
  right: 10px;
  height: 6px;
  cursor: ns-resize;
}
.ds-modal__resize-handle--e {
  top: 10px;
  bottom: 10px;
  right: 0;
  width: 6px;
  cursor: ew-resize;
}
.ds-modal__resize-handle--w {
  top: 10px;
  bottom: 10px;
  left: 0;
  width: 6px;
  cursor: ew-resize;
}
.ds-modal__resize-handle--ne {
  top: 0;
  right: 0;
  width: 12px;
  height: 12px;
  cursor: nesw-resize;
}
.ds-modal__resize-handle--nw {
  top: 0;
  left: 0;
  width: 12px;
  height: 12px;
  cursor: nwse-resize;
}
.ds-modal__resize-handle--se {
  bottom: 0;
  right: 0;
  width: 12px;
  height: 12px;
  cursor: nwse-resize;
}
.ds-modal__resize-handle--sw {
  bottom: 0;
  left: 0;
  width: 12px;
  height: 12px;
  cursor: nesw-resize;
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
