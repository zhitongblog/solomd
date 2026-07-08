<script setup lang="ts">
/** v4.6 F1 — URL value cell. Renders the link with an open-in-browser button
 *  (system opener, same as the editor's external-link handling); click the
 *  text to edit inline. Enter saves, Esc cancels. */
import { ref, watch, nextTick } from 'vue';
import { openUrl } from '@tauri-apps/plugin-opener';
import { DsInput } from '../../../ui';
import { useI18n } from '../../../i18n';

const props = defineProps<{ value: unknown }>();
const emit = defineEmits<{ update: [string] }>();

const { t } = useI18n();

const editing = ref(false);
const draft = ref('');
const inputRef = ref<InstanceType<typeof DsInput> | null>(null);

function display(): string {
  const v = props.value;
  return v == null ? '' : typeof v === 'string' ? v : String(v);
}

function href(): string {
  const s = display();
  if (/^https?:\/\//i.test(s)) return s;
  if (/^www\./i.test(s)) return `https://${s}`;
  return s;
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
  if (draft.value !== display()) emit('update', draft.value);
}

function cancel() {
  editing.value = false;
}

async function open() {
  const u = href();
  if (!u) return;
  try {
    await openUrl(u);
  } catch {
    /* opener unavailable — ignore */
  }
}

watch(
  () => props.value,
  () => {
    if (editing.value) editing.value = false;
  },
);
</script>

<template>
  <div class="prop-url-cell">
    <DsInput
      v-if="editing"
      ref="inputRef"
      v-model="draft"
      size="sm"
      type="url"
      @keydown.enter.prevent="commit"
      @keydown.esc.prevent="cancel"
      @blur="commit"
    />
    <template v-else>
      <button
        type="button"
        class="prop-value-trigger prop-url-cell__text"
        :class="{ 'prop-value-trigger--empty': display() === '' }"
        @click="startEdit"
      >
        {{ display() || '—' }}
      </button>
      <button
        v-if="display() !== ''"
        type="button"
        class="prop-url-cell__open"
        :title="t('inspector.openLink')"
        :aria-label="t('inspector.openLink')"
        @click="open"
      >↗</button>
    </template>
  </div>
</template>

<style scoped>
.prop-url-cell {
  display: flex;
  align-items: center;
  gap: var(--sp-1);
  width: 100%;
}
.prop-url-cell__text {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--accent);
}
.prop-url-cell__open {
  flex-shrink: 0;
  background: transparent;
  border: none;
  color: var(--text-muted);
  cursor: pointer;
  font-size: 13px;
  line-height: 1;
  padding: 2px 4px;
  border-radius: var(--r-sm);
}
.prop-url-cell__open:hover {
  background: var(--bg-hover);
  color: var(--accent);
}
.prop-url-cell__open:focus-visible {
  outline: none;
  box-shadow: var(--ring);
}
</style>
