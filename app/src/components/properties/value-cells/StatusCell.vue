<script setup lang="ts">
/** v4.6 F1 — status value cell. Renders the current status as a color-coded
 *  chip; clicking opens a Popover with a free-text input + a suggestion list
 *  drawn from vault-wide status values (the properties store's `vaultStatuses`).
 *  Enter (or picking a suggestion) saves, Esc cancels. */
import { ref, computed, watch, nextTick } from 'vue';
import { DsPopover, DsChip, DsInput } from '../../../ui';
import { usePropertiesStore } from '../../../stores/properties';

const props = defineProps<{ value: unknown }>();
const emit = defineEmits<{ update: [string] }>();

const store = usePropertiesStore();

const current = computed<string>(() => {
  const v = props.value;
  return v == null ? '' : typeof v === 'string' ? v : String(v);
});

const draft = ref('');
const inputRef = ref<InstanceType<typeof DsInput> | null>(null);
const popRef = ref<InstanceType<typeof DsPopover> | null>(null);

/** A stable, low-saturation hue derived from the status string so the same
 *  status always reads the same color without a hardcoded palette. */
function colorFor(status: string): string {
  const s = status.toLowerCase();
  if (/done|complete|published|closed|active/.test(s)) return 'var(--success)';
  if (/blocked|cancel|fail|inactive/.test(s)) return 'var(--danger)';
  if (/progress|doing|wip|review|pending|planned/.test(s)) return 'var(--warning)';
  if (/todo|to-do|backlog|draft|open|planned/.test(s)) return 'var(--accent)';
  return 'var(--text-muted)';
}

const suggestions = computed<string[]>(() => {
  const q = draft.value.trim().toLowerCase();
  return store.vaultStatuses.filter((s) => s.toLowerCase() !== current.value.toLowerCase() && (q === '' || s.toLowerCase().includes(q)));
});

async function onOpen() {
  draft.value = current.value;
  await nextTick();
  const el = (inputRef.value?.$el as HTMLElement | undefined)?.querySelector?.('input');
  el?.focus();
  el?.select();
}

function choose(v: string) {
  if (v !== current.value) emit('update', v);
  popRef.value?.close();
}

function commitTyped() {
  const v = draft.value.trim();
  if (v !== '' && v !== current.value) emit('update', v);
  popRef.value?.close();
}

watch(
  () => props.value,
  () => popRef.value?.close(),
);
</script>

<template>
  <DsPopover ref="popRef" align="start">
    <template #trigger="{ open }">
      <span class="prop-status-trigger" @click="open || onOpen()">
        <DsChip v-if="current" size="sm" :color="colorFor(current)">{{ current }}</DsChip>
        <span v-else class="prop-value-trigger prop-value-trigger--empty">—</span>
      </span>
    </template>
    <div class="prop-status-pop">
      <DsInput
        ref="inputRef"
        v-model="draft"
        size="sm"
        placeholder="Status…"
        @keydown.enter.prevent="commitTyped"
        @keydown.esc.prevent="popRef?.close()"
      />
      <ul v-if="suggestions.length" class="prop-status-pop__list">
        <li
          v-for="s in suggestions"
          :key="s"
          class="prop-status-pop__item"
          @click="choose(s)"
        >
          <DsChip size="sm" :color="colorFor(s)">{{ s }}</DsChip>
        </li>
      </ul>
    </div>
  </DsPopover>
</template>

<style scoped>
.prop-status-trigger {
  display: inline-flex;
  cursor: pointer;
}
.prop-status-pop {
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
  min-width: 180px;
}
.prop-status-pop__list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: var(--sp-1);
  max-height: 200px;
  overflow-y: auto;
}
.prop-status-pop__item {
  padding: var(--sp-1);
  border-radius: var(--r-sm);
  cursor: pointer;
}
.prop-status-pop__item:hover {
  background: var(--bg-hover);
}
</style>
