<script setup lang="ts">
/** v4.6 F1 — number value cell. Emits a JS number so the Rust side serializes
 *  it bare (unquoted) in YAML. Non-numeric input falls back to the raw string
 *  so the user isn't silently data-lost. */
import { ref, watch, nextTick } from 'vue';
import { DsInput } from '../../../ui';

const props = defineProps<{ value: unknown }>();
const emit = defineEmits<{ update: [number | string] }>();

const editing = ref(false);
const draft = ref('');
const inputRef = ref<InstanceType<typeof DsInput> | null>(null);

function display(): string {
  const v = props.value;
  if (v == null || v === '') return '';
  return String(v);
}

async function startEdit() {
  draft.value = display();
  editing.value = true;
  await nextTick();
  const el = (inputRef.value?.$el as HTMLElement | undefined)?.querySelector?.('input');
  el?.focus();
  el?.select();
}

function commit() {
  if (!editing.value) return;
  editing.value = false;
  const raw = draft.value.trim();
  if (raw === display()) return;
  const n = Number(raw);
  emit('update', raw !== '' && Number.isFinite(n) ? n : raw);
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
  <div class="prop-number-cell">
    <DsInput
      v-if="editing"
      ref="inputRef"
      v-model="draft"
      size="sm"
      type="text"
      inputmode="decimal"
      @keydown.enter.prevent="commit"
      @keydown.esc.prevent="cancel"
      @blur="commit"
    />
    <button
      v-else
      type="button"
      class="prop-value-trigger prop-value-trigger--num"
      :class="{ 'prop-value-trigger--empty': display() === '' }"
      @click="startEdit"
    >
      {{ display() || '—' }}
    </button>
  </div>
</template>

<style scoped>
.prop-number-cell {
  width: 100%;
}
.prop-value-trigger--num {
  font-variant-numeric: tabular-nums;
}
</style>
