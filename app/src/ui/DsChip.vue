<script setup lang="ts">
import { computed } from 'vue';

const props = withDefaults(
  defineProps<{
    /** Any CSS color. Drives a soft tinted background + matching text. */
    color?: string;
    removable?: boolean;
    size?: 'sm' | 'md';
  }>(),
  { size: 'md' },
);

const emit = defineEmits<{ remove: [] }>();

/* When a color is given we tint via color-mix so the chip stays legible in
 * both light and dark without hardcoding hex pairs. Falls back to neutral
 * surface tokens when no color is supplied. */
const style = computed(() => {
  if (!props.color) return undefined;
  return {
    '--chip-color': props.color,
    background: `color-mix(in srgb, ${props.color} 14%, transparent)`,
    color: props.color,
    borderColor: `color-mix(in srgb, ${props.color} 30%, transparent)`,
  } as Record<string, string>;
});
</script>

<template>
  <span
    class="ds-chip"
    :class="[`ds-chip--${size}`, { 'ds-chip--neutral': !color }]"
    :style="style"
  >
    <slot />
    <button
      v-if="removable"
      class="ds-chip__remove"
      type="button"
      aria-label="Remove"
      @click.stop="emit('remove')"
    >×</button>
  </span>
</template>

<style scoped>
.ds-chip {
  display: inline-flex;
  align-items: center;
  gap: var(--sp-1);
  border: 1px solid transparent;
  border-radius: var(--r-full);
  font-weight: 500;
  line-height: 1;
  white-space: nowrap;
}
.ds-chip--neutral {
  background: var(--bg-hover);
  border-color: var(--border);
  color: var(--text-muted);
}
.ds-chip--sm {
  height: 20px;
  padding: 0 var(--sp-2);
  font-size: 11px;
}
.ds-chip--md {
  height: 24px;
  padding: 0 var(--sp-3);
  font-size: 12px;
}
.ds-chip__remove {
  background: transparent;
  border: none;
  color: inherit;
  cursor: pointer;
  font-size: 14px;
  line-height: 1;
  opacity: 0.7;
  border-radius: var(--r-full);
}
.ds-chip__remove:hover {
  opacity: 1;
}
.ds-chip__remove:focus-visible {
  outline: none;
  box-shadow: var(--ring);
}
</style>
