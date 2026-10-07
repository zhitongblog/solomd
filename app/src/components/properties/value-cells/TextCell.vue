<script setup lang="ts">
/**
 * v4.6 F1 — text value cell. Click-to-edit; Enter saves, Esc cancels.
 * The base pattern every other scalar cell mirrors.
 */
import { ref, watch, nextTick } from 'vue';

const props = defineProps<{ value: unknown; placeholder?: string }>();
const emit = defineEmits<{ update: [string] }>();

const editing = ref(false);
const draft = ref('');
const inputRef = ref<HTMLInputElement | null>(null);

function display(): string {
  const v = props.value;
  if (v == null) return '';
  return typeof v === 'string' ? v : String(v);
}

async function startEdit() {
  draft.value = display();
  editing.value = true;
  await nextTick();
  inputRef.value?.focus();
  inputRef.value?.select();
}

function commit() {
  if (!editing.value) return;
  editing.value = false;
  if (draft.value !== display()) emit('update', draft.value);
}

function cancel() {
  editing.value = false;
}

watch(
  () => props.value,
  () => {
    if (editing.value) editing.value = false;
  },
);
</script>

<template>
  <div class="prop-text-cell">
    <input
      v-if="editing"
      ref="inputRef"
      v-model="draft"
      class="rp-input prop-cell-input"
      :placeholder="placeholder"
      @keydown.enter.prevent="commit"
      @keydown.esc.prevent="cancel"
      @blur="commit"
    />
    <button
      v-else
      type="button"
      class="prop-value-trigger"
      :class="{ 'prop-value-trigger--empty': display() === '' }"
      @click="startEdit"
    >
      {{ display() || (placeholder ?? '—') }}
    </button>
  </div>
</template>

<style scoped>
.prop-text-cell {
  width: 100%;
}
</style>
