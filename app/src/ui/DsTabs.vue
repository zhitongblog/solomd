<script setup lang="ts">
import { ref } from 'vue';

export interface DsTab {
  value: string;
  label: string;
  disabled?: boolean;
}

const props = defineProps<{
  modelValue: string;
  tabs: DsTab[];
}>();

const emit = defineEmits<{ 'update:modelValue': [string] }>();

const tablistRef = ref<HTMLElement | null>(null);

function select(tab: DsTab) {
  if (tab.disabled) return;
  emit('update:modelValue', tab.value);
}

function onKeydown(e: KeyboardEvent) {
  if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft' && e.key !== 'Home' && e.key !== 'End')
    return;
  e.preventDefault();
  const enabled = props.tabs.filter((t) => !t.disabled);
  if (enabled.length === 0) return;
  const curIdx = enabled.findIndex((t) => t.value === props.modelValue);
  let next = curIdx;
  if (e.key === 'ArrowRight') next = (curIdx + 1) % enabled.length;
  else if (e.key === 'ArrowLeft') next = (curIdx - 1 + enabled.length) % enabled.length;
  else if (e.key === 'Home') next = 0;
  else if (e.key === 'End') next = enabled.length - 1;
  const target = enabled[next];
  emit('update:modelValue', target.value);
  requestAnimationFrame(() => {
    tablistRef.value
      ?.querySelector<HTMLElement>(`[data-tab="${target.value}"]`)
      ?.focus();
  });
}
</script>

<template>
  <div class="ds-tabs">
    <div ref="tablistRef" class="ds-tabs__list" role="tablist" @keydown="onKeydown">
      <button
        v-for="tab in tabs"
        :key="tab.value"
        class="ds-tabs__tab"
        :class="{ 'ds-tabs__tab--active': tab.value === modelValue }"
        type="button"
        role="tab"
        :data-tab="tab.value"
        :aria-selected="tab.value === modelValue"
        :tabindex="tab.value === modelValue ? 0 : -1"
        :disabled="tab.disabled"
        @click="select(tab)"
      >
        {{ tab.label }}
      </button>
    </div>
    <div class="ds-tabs__panel" role="tabpanel">
      <slot :active="modelValue" />
    </div>
  </div>
</template>

<style scoped>
.ds-tabs {
  display: flex;
  flex-direction: column;
}
.ds-tabs__list {
  display: flex;
  align-items: center;
  gap: var(--sp-1);
  border-bottom: 1px solid var(--border);
}
.ds-tabs__tab {
  position: relative;
  background: transparent;
  border: none;
  font-family: inherit;
  font-size: 13px;
  font-weight: 500;
  color: var(--text-muted);
  padding: var(--sp-2) var(--sp-3);
  cursor: pointer;
  border-radius: var(--r-sm) var(--r-sm) 0 0;
  transition: color var(--dur-fast) var(--ease),
    background var(--dur-fast) var(--ease);
}
.ds-tabs__tab:hover:not(:disabled) {
  color: var(--text);
  background: var(--bg-hover);
}
.ds-tabs__tab--active {
  color: var(--text);
}
.ds-tabs__tab--active::after {
  content: '';
  position: absolute;
  left: var(--sp-2);
  right: var(--sp-2);
  bottom: -1px;
  height: 2px;
  background: var(--accent);
  border-radius: var(--r-full);
}
.ds-tabs__tab:disabled {
  opacity: 0.5;
  cursor: default;
}
.ds-tabs__tab:focus-visible {
  outline: none;
  box-shadow: var(--ring);
}
.ds-tabs__panel {
  padding: var(--sp-4) 0;
}
</style>
