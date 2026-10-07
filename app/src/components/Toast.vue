<script setup lang="ts">
import { useToastsStore, type Toast } from '../stores/toasts';
import Icons from './Icons.vue';

const toasts = useToastsStore();

/* Line icons from the shared set (spec §2: no emoji / glyph badges). */
const icons: Record<string, string> = {
  success: 'check-circle',
  error: 'close',
  info: 'info',
  warning: 'info',
};

function onToastClick(t: Toast) {
  // A toast with an explicit action button keeps the old copy-on-click
  // behavior for the rest of its surface — a stray click on "Deleted x" must
  // not be read as "undo".
  if (t.onClick && !t.actionLabel) {
    t.onClick();
    toasts.resolve(t.id);
    return;
  }
  navigator.clipboard.writeText(t.message).catch(() => {});
}

function onToastAction(t: Toast) {
  t.onClick?.();
  toasts.resolve(t.id);
}
</script>

<template>
  <div class="toasts" role="status" aria-live="polite">
    <transition-group name="toast">
      <div
        v-for="t in toasts.items"
        :key="t.id"
        class="toast"
        :class="`toast--${t.kind}`"
        @click="onToastClick(t)"
      >
        <Icons class="toast__icon" :name="icons[t.kind] ?? 'info'" :size="16" aria-hidden="true" />
        <span class="toast__msg">{{ t.message }}</span>
        <button
          v-if="t.onClick && t.actionLabel"
          class="toast__action"
          @click.stop="onToastAction(t)"
        >{{ t.actionLabel }}</button>
      </div>
    </transition-group>
  </div>
</template>

<style scoped>
/* 5.0: small --bg-pop capsules with --sh-pop, centred above the bottom edge
   (the editor's bottom-right corner belongs to the stats pill). The kind is
   carried by the icon colour alone — no coloured edge. */
.toasts {
  position: fixed;
  left: 50%;
  bottom: 28px;
  translate: -50% 0;
  z-index: var(--z-toast);
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  pointer-events: none;
}
.toast {
  pointer-events: auto;
  display: flex;
  align-items: center;
  gap: 8px;
  box-sizing: border-box;
  min-height: 36px;
  max-width: min(460px, calc(100vw - 32px));
  padding: 7px 16px 7px 12px;
  border-radius: var(--r-full);
  font-size: 13px;
  line-height: 1.35;
  background: var(--bg-pop);
  border: var(--bd-hair);
  box-shadow: var(--sh-pop);
  color: var(--text);
  cursor: default;
}
.toast:has(.toast__action) {
  padding-right: 6px;
}
.toast__icon {
  flex-shrink: 0;
  color: var(--text-2);
}
.toast--success .toast__icon { color: var(--success); }
.toast--error .toast__icon { color: var(--danger); }
.toast--warning .toast__icon { color: var(--warning); }
.toast__msg {
  flex: 1;
  min-width: 0;
}
.toast__action {
  flex-shrink: 0;
  height: 24px;
  padding: 0 10px;
  border: 0;
  border-radius: var(--r-full);
  background: var(--fill-1);
  color: var(--accent-text);
  font: inherit;
  font-size: 12px;
  font-weight: 600;
  cursor: default;
}
.toast__action:hover {
  background: var(--fill-2);
}

.toast-enter-from,
.toast-leave-to { opacity: 0; transform: translateY(8px) scale(0.98); }
.toast-enter-active { transition: opacity var(--dur) var(--ease-out), transform var(--dur) var(--ease-out); }
.toast-leave-active { transition: opacity var(--dur-fast) ease-in, transform var(--dur-fast) ease-in; }
.toast-move { transition: transform var(--dur) var(--ease-out); }
</style>
