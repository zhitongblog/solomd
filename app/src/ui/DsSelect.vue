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
    <span class="ds-select__chevron" aria-hidden="true">▾</span>
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
  width: 100%;
  font-family: inherit;
  color: var(--text);
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: var(--r-md);
  cursor: pointer;
  transition: border-color var(--dur-fast) var(--ease),
    box-shadow var(--dur-fast) var(--ease);
}
.ds-select__native:hover:not(:disabled) {
  border-color: var(--text-faint);
}
.ds-select__native:focus-visible,
.ds-select__native:focus {
  outline: none;
  border-color: var(--accent);
  box-shadow: var(--ring);
}
.ds-select__native:disabled {
  opacity: 0.5;
  cursor: default;
}
.ds-select__chevron {
  position: absolute;
  right: var(--sp-3);
  top: 50%;
  transform: translateY(-50%);
  pointer-events: none;
  color: var(--text-muted);
  font-size: 10px;
}
.ds-select--sm .ds-select__native {
  height: 32px;
  padding: 0 var(--sp-5) 0 var(--sp-3);
  font-size: 12px;
}
.ds-select--md .ds-select__native {
  height: 36px;
  padding: 0 var(--sp-5) 0 var(--sp-3);
  font-size: 13px;
}
</style>
