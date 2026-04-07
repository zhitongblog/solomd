<script setup lang="ts">
import { useToastsStore } from '../stores/toasts';

const toasts = useToastsStore();

const icons: Record<string, string> = {
  success: '✓',
  error: '✕',
  info: 'ℹ',
  warning: '!',
};
</script>

<template>
  <div class="toasts" role="status" aria-live="polite">
    <transition-group name="toast">
      <div
        v-for="t in toasts.items"
        :key="t.id"
        class="toast"
        :class="`toast--${t.kind}`"
        @click="toasts.dismiss(t.id)"
      >
        <span class="toast__icon">{{ icons[t.kind] }}</span>
        <span class="toast__msg">{{ t.message }}</span>
      </div>
    </transition-group>
  </div>
</template>

<style scoped>
.toasts {
  position: fixed;
  bottom: 36px;
  right: 18px;
  z-index: 2000;
  display: flex;
  flex-direction: column;
  gap: 8px;
  pointer-events: none;
}
.toast {
  pointer-events: auto;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 14px;
  border-radius: 6px;
  font-size: 13px;
  background: var(--bg-elev);
  border: 1px solid var(--border);
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.2);
  cursor: pointer;
  min-width: 220px;
  max-width: 380px;
  color: var(--text);
}
.toast__icon {
  flex-shrink: 0;
  width: 18px;
  height: 18px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 11px;
  font-weight: 700;
  color: white;
}
.toast__msg {
  flex: 1;
}
.toast--success .toast__icon { background: #2ea043; }
.toast--success { border-left: 3px solid #2ea043; }
.toast--error .toast__icon { background: #d64545; }
.toast--error { border-left: 3px solid #d64545; }
.toast--info .toast__icon { background: var(--accent); color: var(--accent-fg); }
.toast--info { border-left: 3px solid var(--accent); }
.toast--warning .toast__icon { background: #d4a017; }
.toast--warning { border-left: 3px solid #d4a017; }

.toast-enter-from { opacity: 0; transform: translateX(20px); }
.toast-enter-active { transition: all 0.2s ease-out; }
.toast-leave-to { opacity: 0; transform: translateX(20px); }
.toast-leave-active { transition: all 0.2s ease-in; position: absolute; right: 0; }
</style>
