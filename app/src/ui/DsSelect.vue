<script setup lang="ts">
export interface DsSelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}

withDefaults(
  defineProps<{
    modelValue?: string;
    options: DsSelectOption[];
    disabled?: boolean;
    size?: 'sm' | 'md';
  }>(),
  { size: 'md' },
);

const emit = defineEmits<{ 'update:modelValue': [string] }>();

function onChange(e: Event) {
  emit('update:modelValue', (e.target as HTMLSelectElement).value);
}
</script>

<template>
  <div class="ds-select" :class="`ds-select--${size}`">
    <select
      class="ds-select__native"
      :value="modelValue"
      :disabled="disabled"
      @change="onChange"
    >
      <option
        v-for="opt in options"
        :key="opt.value"
        :value="opt.value"
        :disabled="opt.disabled"
      >
        {{ opt.label }}
      </option>
    </select>
    <span class="ds-select__chevron" aria-hidden="true">
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="8 10 12 6 16 10" /><polyline points="8 14 12 18 16 14" /></svg>
    </span>
  </div>
</template>

<style scoped>
.ds-select {
  position: relative;
  display: inline-flex;
  width: 100%;
}
.ds-select__native {
  appearance: none;
  -webkit-appearance: none;
  box-sizing: border-box;
  width: 100%;
  font-family: var(--font-ui, inherit);
  color: var(--text);
  background: var(--fill-1);
  border: var(--bd-hair);
  border-color: var(--hairline);
  border-radius: var(--r-md);
  transition: background-color var(--dur-fast) var(--ease),
    box-shadow var(--dur-fast) var(--ease);
  cursor: default;
}
.ds-select__native:hover:not(:disabled):not(:focus) {
  background: var(--fill-2);
}
.ds-select__native:focus-visible,
.ds-select__native:focus {
  outline: none;
  box-shadow: var(--ring);
}
.ds-select__native:disabled {
  opacity: 0.5;
}
.ds-select__chevron {
  position: absolute;
  right: 9px;
  top: 50%;
  transform: translateY(-50%);
  display: inline-flex;
  pointer-events: none;
  color: var(--text-3);
}
.ds-select--sm .ds-select__native {
  height: 26px;
  padding: 0 26px 0 8px;
  font-size: 12px;
  border-radius: var(--r-sm);
}
.ds-select--md .ds-select__native {
  height: 32px;
  padding: 0 28px 0 10px;
  font-size: 13px;
}
</style>
