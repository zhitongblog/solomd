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
/* 5.0 list row: 28px, radius 7, hover --fill-1, selected --accent-soft with
   --accent-text label (the sidebar-row look, spec §4). */
.ds-list-row {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  box-sizing: border-box;
  width: 100%;
  min-height: 28px;
  padding: 4px 8px;
  text-align: left;
  font-family: var(--font-ui, inherit);
  font-size: 13px;
  color: var(--text);
  background: transparent;
  border: 0;
  border-radius: 7px;
  cursor: default;
}
.ds-list-row:hover:not(.ds-list-row--disabled):not(.ds-list-row--selected) {
  background: var(--fill-1);
}
.ds-list-row--active {
  background: var(--fill-1);
}
.ds-list-row--selected {
  background: var(--accent-soft);
  color: var(--accent-text);
}
.ds-list-row--selected .ds-list-row__lead,
.ds-list-row--selected .ds-list-row__trail {
  color: var(--accent-text);
}
.ds-list-row--disabled {
  opacity: 0.45;
}
.ds-list-row:focus-visible {
  outline: none;
  box-shadow: var(--ring);
}
.ds-list-row__main {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ds-list-row__lead,
.ds-list-row__trail {
  display: inline-flex;
  align-items: center;
  flex-shrink: 0;
  color: var(--text-3);
}
.ds-list-row__lead {
  color: var(--text-2);
}
</style>

