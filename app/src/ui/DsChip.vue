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
/* 5.0: radius 999, quiet --fill-1 capsule; a tinted chip when a colour is given. */
.ds-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  box-sizing: border-box;
  border: 0;
  border-radius: var(--r-full);
  font-family: var(--font-ui, inherit);
  font-weight: 500;
  line-height: 1;
  white-space: nowrap;
}
.ds-chip--neutral {
  background: var(--fill-1);
  color: var(--text-2);
}
.ds-chip--sm {
  height: 20px;
  padding: 0 8px;
  font-size: 11px;
}
.ds-chip--md {
  height: 24px;
  padding: 0 10px;
  font-size: 12px;
}
.ds-chip__remove {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 14px;
  height: 14px;
  margin-right: -4px;
  padding: 0;
  background: transparent;
  border: 0;
  color: inherit;
  font-size: 13px;
  line-height: 1;
  opacity: 0.6;
  border-radius: var(--r-full);
  cursor: default;
}
.ds-chip__remove:hover {
  opacity: 1;
  background: var(--fill-2);
}
.ds-chip__remove:focus-visible {
  outline: none;
  box-shadow: var(--ring);
}
</style>

