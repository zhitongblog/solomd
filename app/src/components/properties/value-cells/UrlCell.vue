<script setup lang="ts">
/** v4.6 F1 — URL value cell. Renders the link with an open-in-browser button
 *  (system opener, same as the editor's external-link handling); click the
 *  text to edit inline. Enter saves, Esc cancels. */
import { ref, watch, nextTick } from 'vue';
import { openUrl } from '@tauri-apps/plugin-opener';
import Icons from '../../Icons.vue';
import { useI18n } from '../../../i18n';

const props = defineProps<{ value: unknown }>();
const emit = defineEmits<{ update: [string] }>();

const { t } = useI18n();

const editing = ref(false);
const draft = ref('');
const inputRef = ref<HTMLInputElement | null>(null);

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
    <input
      v-if="editing"
      ref="inputRef"
      v-model="draft"
      class="rp-input prop-cell-input"
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
      ><Icons name="external" :size="13" /></button>
    </template>
  </div>
</template>

<style scoped>
.prop-url-cell {
  display: flex;
  align-items: center;
  gap: 2px;
  width: 100%;
}
.prop-url-cell__text {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--accent-text);
}
.prop-url-cell__open {
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  padding: 0;
  border: 0;
  border-radius: var(--r-sm);
  background: transparent;
  color: var(--text-3);
  cursor: pointer;
}
.prop-url-cell__open:hover {
  background: var(--fill-1);
  color: var(--accent-text);
}
.prop-url-cell__open:focus-visible {
  outline: none;
  box-shadow: var(--ring);
}
</style>
