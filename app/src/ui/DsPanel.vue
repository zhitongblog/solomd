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
        >×</button>
      </span>
    </header>
    <div class="ds-panel__body">
      <slot />
    </div>
  </section>
</template>

<style scoped>
.ds-panel {
  display: flex;
  flex-direction: column;
  height: 100%;
  background: var(--bg);
  border-left: 1px solid var(--border);
  overflow: hidden;
}
.ds-panel__head {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  padding: var(--sp-2) var(--sp-3);
  border-bottom: 1px solid var(--border);
  background: var(--bg-elev);
}
.ds-panel__grip {
  width: 3px;
  height: 14px;
  border-radius: var(--r-full);
  background: var(--border);
  cursor: grab;
  flex-shrink: 0;
}
.ds-panel__title {
  flex: 1;
  font-size: 11px;
  font-weight: 600;
  color: var(--text-muted);
  text-transform: uppercase;
  letter-spacing: 0.06em;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ds-panel__actions {
  display: inline-flex;
  align-items: center;
  gap: var(--sp-1);
}
.ds-panel__close {
  background: transparent;
  border: none;
  color: var(--text-muted);
  font-size: 16px;
  line-height: 1;
  cursor: pointer;
  width: 22px;
  height: 22px;
  border-radius: var(--r-sm);
}
.ds-panel__close:hover {
  background: var(--bg-hover);
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
