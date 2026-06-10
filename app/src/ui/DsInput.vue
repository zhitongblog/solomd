<script setup lang="ts">
withDefaults(
  defineProps<{
    modelValue?: string | number;
    type?: string;
    placeholder?: string;
    disabled?: boolean;
    size?: 'sm' | 'md';
  }>(),
  { type: 'text', size: 'md' },
);

const emit = defineEmits<{ 'update:modelValue': [string] }>();

function onInput(e: Event) {
  emit('update:modelValue', (e.target as HTMLInputElement).value);
}
</script>

<template>
  <input
    class="ds-input"
    :class="`ds-input--${size}`"
    :type="type"
    :value="modelValue"
    :placeholder="placeholder"
    :disabled="disabled"
    @input="onInput"
  />
</template>

<style scoped>
.ds-input {
  width: 100%;
  font-family: inherit;
  color: var(--text);
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: var(--r-md);
  transition: border-color var(--dur-fast) var(--ease),
    box-shadow var(--dur-fast) var(--ease);
}
.ds-input::placeholder {
  color: var(--text-faint);
}
.ds-input:hover:not(:disabled) {
  border-color: var(--text-faint);
}
.ds-input:focus-visible,
.ds-input:focus {
  outline: none;
  border-color: var(--accent);
  box-shadow: var(--ring);
}
.ds-input:disabled {
  opacity: 0.5;
  cursor: default;
}
.ds-input--sm {
  height: 32px;
  padding: 0 var(--sp-3);
  font-size: 12px;
}
.ds-input--md {
  height: 36px;
  padding: 0 var(--sp-3);
  font-size: 13px;
}
</style>
