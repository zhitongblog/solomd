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
  font-size: 13px;
  line-height: 1.5;
  padding: 7px 10px;
  resize: vertical;
}
.ds-textarea::placeholder {
  color: var(--text-3);
}
.ds-textarea:hover:not(:disabled):not(:focus) {
  background: var(--fill-2);
}
.ds-textarea:focus-visible,
.ds-textarea:focus {
  outline: none;
  background: var(--bg);
  box-shadow: var(--ring);
}
.ds-textarea:disabled {
  opacity: 0.5;
}
</style>
