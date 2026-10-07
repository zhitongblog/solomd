<script setup lang="ts" generic="V extends string | number">
/**
 * Segmented control with a sliding thumb (docs/v5-ui-spec.md §1: "thumb
 * slides between segments, 180 ms"). Equal-width segments so the thumb can
 * be positioned with pure CSS (`--seg-i` / `--seg-n`), no measuring.
 */
import { computed } from 'vue';
import Icons from '../Icons.vue';
import '../../styles/panels.css';

const props = defineProps<{
  modelValue: V;
  options: { value: V; label?: string; icon?: string; title?: string }[];
  ariaLabel?: string;
}>();
const emit = defineEmits<{ 'update:modelValue': [V] }>();

const index = computed(() => Math.max(0, props.options.findIndex((o) => o.value === props.modelValue)));
</script>

<template>
  <div
    class="rp-seg"
    role="radiogroup"
    :aria-label="ariaLabel"
    :style="{ '--seg-n': options.length, '--seg-i': index }"
  >
    <span class="rp-seg__thumb" aria-hidden="true" />
    <button
      v-for="o in options"
      :key="String(o.value)"
      type="button"
      role="radio"
      class="rp-seg__opt"
      :class="{ 'is-on': o.value === modelValue }"
      :aria-checked="o.value === modelValue"
      :title="o.title ?? o.label"
      @click="emit('update:modelValue', o.value)"
    >
      <Icons v-if="o.icon" :name="o.icon" :size="14" />
      <span v-if="o.label">{{ o.label }}</span>
    </button>
  </div>
</template>
