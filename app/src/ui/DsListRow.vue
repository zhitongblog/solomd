<script setup lang="ts">
withDefaults(
  defineProps<{
    active?: boolean;
    selected?: boolean;
    disabled?: boolean;
    as?: 'button' | 'div';
  }>(),
  { as: 'button' },
);

const emit = defineEmits<{ click: [MouseEvent] }>();
</script>

<template>
  <component
    :is="as"
    class="ds-list-row"
    :class="{
      'ds-list-row--active': active,
      'ds-list-row--selected': selected,
      'ds-list-row--disabled': disabled,
    }"
    :type="as === 'button' ? 'button' : undefined"
    :disabled="as === 'button' ? disabled : undefined"
    :aria-selected="selected || undefined"
    @click="emit('click', $event)"
  >
    <span v-if="$slots.leading" class="ds-list-row__lead"><slot name="leading" /></span>
    <span class="ds-list-row__main"><slot /></span>
    <span v-if="$slots.trailing" class="ds-list-row__trail"><slot name="trailing" /></span>
  </component>
</template>

<style scoped>
.ds-list-row {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  width: 100%;
  text-align: left;
  font-family: inherit;
  font-size: 13px;
  color: var(--text);
  background: transparent;
  border: 1px solid transparent;
  border-radius: var(--r-sm);
  padding: var(--sp-2) var(--sp-3);
  cursor: pointer;
  transition: background var(--dur-fast) var(--ease),
    border-color var(--dur-fast) var(--ease);
}
.ds-list-row:hover:not(.ds-list-row--disabled) {
  background: var(--bg-hover);
}
.ds-list-row--active {
  background: var(--bg-hover);
}
.ds-list-row--selected {
  background: var(--accent-soft);
  border-color: var(--accent);
  color: var(--text);
}
.ds-list-row--disabled {
  opacity: 0.5;
  cursor: default;
}
.ds-list-row:focus-visible {
  outline: none;
  box-shadow: var(--ring);
}
.ds-list-row__main {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ds-list-row__lead,
.ds-list-row__trail {
  display: inline-flex;
  align-items: center;
  flex-shrink: 0;
  color: var(--text-muted);
}
</style>
