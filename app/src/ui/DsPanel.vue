<script setup lang="ts">
withDefaults(
  defineProps<{
    title?: string;
    /** Show a left grip handle (drag affordance), like .rs-pane-host. */
    grip?: boolean;
    closable?: boolean;
  }>(),
  { grip: false, closable: true },
);

const emit = defineEmits<{ close: [] }>();
</script>

<template>
  <section class="ds-panel">
    <header class="ds-panel__head">
      <span v-if="grip" class="ds-panel__grip" aria-hidden="true" />
      <span class="ds-panel__title">
        <slot name="title">{{ title }}</slot>
      </span>
      <span class="ds-panel__actions">
        <slot name="actions" />
        <button
          v-if="closable"
          class="ds-panel__close"
          type="button"
          aria-label="Close"
          @click="emit('close')"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><line x1="6" y1="6" x2="18" y2="18" /><line x1="18" y1="6" x2="6" y2="18" /></svg>
        </button>
      </span>
    </header>
    <div class="ds-panel__body">
      <slot />
    </div>
  </section>
</template>

<style scoped>
/* 5.0 side panel: --bg surface, hairline edge, a quiet 40px header. */
.ds-panel {
  display: flex;
  flex-direction: column;
  height: 100%;
  background: var(--bg);
  border-left: var(--bd-hair);
  overflow: hidden;
}
.ds-panel__head {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  min-height: 40px;
  box-sizing: border-box;
  padding: 0 var(--sp-2) 0 var(--sp-4);
  border-bottom: var(--bd-hair);
}
.ds-panel__grip {
  width: 3px;
  height: 14px;
  border-radius: var(--r-full);
  background: var(--fill-2);
  cursor: grab;
  flex-shrink: 0;
}
.ds-panel__title {
  flex: 1;
  font-size: 13px;
  font-weight: 600;
  color: var(--text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ds-panel__actions {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  color: var(--text-2);
}
.ds-panel__close {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  padding: 0;
  background: transparent;
  border: 0;
  color: var(--text-2);
  cursor: default;
  border-radius: var(--r-sm);
}
.ds-panel__close:hover {
  background: var(--fill-1);
  color: var(--text);
}
.ds-panel__close:focus-visible {
  outline: none;
  box-shadow: var(--ring);
}
.ds-panel__body {
  flex: 1;
  overflow-y: auto;
}
</style>

