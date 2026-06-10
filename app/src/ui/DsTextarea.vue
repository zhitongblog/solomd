<script setup lang="ts">
withDefaults(
  defineProps<{
    modelValue?: string;
    placeholder?: string;
    disabled?: boolean;
    rows?: number;
  }>(),
  { rows: 4 },
);

const emit = defineEmits<{ 'update:modelValue': [string] }>();

function onInput(e: Event) {
  emit('update:modelValue', (e.target as HTMLTextAreaElement).value);
}
</script>

<template>
  <textarea
    class="ds-textarea"
    :value="modelValue"
    :placeholder="placeholder"
    :disabled="disabled"
    :rows="rows"
    @input="onInput"
  />
</template>

<style scoped>
.ds-textarea {
  width: 100%;
  font-family: inherit;
  font-size: 13px;
  line-height: 1.5;
  color: var(--text);
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: var(--r-md);
  padding: var(--sp-2) var(--sp-3);
  resize: vertical;
  transition: border-color var(--dur-fast) var(--ease),
    box-shadow var(--dur-fast) var(--ease);
}
.ds-textarea::placeholder {
  color: var(--text-faint);
}
.ds-textarea:hover:not(:disabled) {
  border-color: var(--text-faint);
}
.ds-textarea:focus-visible,
.ds-textarea:focus {
  outline: none;
  border-color: var(--accent);
  box-shadow: var(--ring);
}
.ds-textarea:disabled {
  opacity: 0.5;
  cursor: default;
}
</style>
