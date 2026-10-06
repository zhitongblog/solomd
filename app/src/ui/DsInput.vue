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
/* 5.0: 32px, radius 8, --fill-1 well with a hairline, focus ring. */
.ds-input {
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
}
.ds-input::placeholder {
  color: var(--text-3);
}
.ds-input:hover:not(:disabled):not(:focus) {
  background: var(--fill-2);
}
.ds-input:focus-visible,
.ds-input:focus {
  outline: none;
  background: var(--bg);
  box-shadow: var(--ring);
}
.ds-input:disabled {
  opacity: 0.5;
}
.ds-input--sm {
  height: 26px;
  padding: 0 8px;
  font-size: 12px;
  border-radius: var(--r-sm);
}
.ds-input--md {
  height: 32px;
  padding: 0 10px;
  font-size: 13px;
}
</style>
