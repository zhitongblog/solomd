<script setup lang="ts">
/**
 * v4.6 F1 — text value cell. Click-to-edit; Enter saves, Esc cancels.
 * The base pattern every other scalar cell mirrors.
 */
import { ref, watch, nextTick } from 'vue';
import { DsInput } from '../../../ui';

const props = defineProps<{ value: unknown; placeholder?: string }>();
const emit = defineEmits<{ update: [string] }>();

const editing = ref(false);
const draft = ref('');
const inputRef = ref<InstanceType<typeof DsInput> | null>(null);

function display(): string {
  const v = props.value;
  if (v == null) return '';
  return typeof v === 'string' ? v : String(v);
}

async function startEdit() {
  draft.value = display();
  editing.value = true;
  await nextTick();
  const el = (inputRef.value?.$el as HTMLElement | undefined)?.querySelector?.('input')
    ?? (inputRef.value?.$el as HTMLInputElement | undefined);
  (el as HTMLInputElement | undefined)?.focus?.();
  (el as HTMLInputElement | undefined)?.select?.();
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
    <DsInput
      v-if="editing"
      ref="inputRef"
      v-model="draft"
      size="sm"
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
