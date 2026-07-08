<script setup lang="ts">
/** v4.6 F1 — tags value cell. Renders the array value as removable chips and
 *  an inline add-input with vault-wide autocomplete (the properties store's
 *  `vaultTagsByKey[propKey]`). Emits the full updated string[] on every
 *  add/remove so the Rust side rewrites the sequence atomically. */
import { ref, computed, nextTick } from 'vue';
import { DsChip, DsInput } from '../../../ui';
import { usePropertiesStore } from '../../../stores/properties';
import { useI18n } from '../../../i18n';

const props = defineProps<{ value: unknown; propKey: string }>();
const emit = defineEmits<{ update: [string[]] }>();

const store = usePropertiesStore();
const { t } = useI18n();

const items = computed<string[]>(() => {
  const v = props.value;
  if (Array.isArray(v)) return v.map((x) => (typeof x === 'string' ? x : String(x)));
  if (v == null || v === '') return [];
  return String(v)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
});

const adding = ref(false);
const draft = ref('');
const inputRef = ref<InstanceType<typeof DsInput> | null>(null);

const suggestions = computed<string[]>(() => {
  const pool = store.vaultTagsByKey[props.propKey] ?? [];
  const q = draft.value.trim().toLowerCase();
  return pool
    .filter((s) => !items.value.includes(s) && (q === '' || s.toLowerCase().includes(q)))
    .slice(0, 8);
});

async function startAdd() {
  adding.value = true;
  draft.value = '';
  await nextTick();
  const el = (inputRef.value?.$el as HTMLElement | undefined)?.querySelector?.('input');
  el?.focus();
}

function add(tag: string) {
  const v = tag.trim();
  if (v === '' || items.value.includes(v)) {
    draft.value = '';
    return;
  }
  emit('update', [...items.value, v]);
  draft.value = '';
}

function commitDraft() {
  if (draft.value.trim() === '') {
    adding.value = false;
    return;
  }
  add(draft.value);
}

function remove(tag: string) {
  emit('update', items.value.filter((x) => x !== tag));
}

/** Backspace on an empty add-input removes the last chip (Tolaria parity). */
function onBackspace() {
  if (draft.value === '' && items.value.length) {
    emit('update', items.value.slice(0, -1));
  }
}
</script>

<template>
  <div class="prop-tags-cell">
    <DsChip
      v-for="tag in items"
      :key="tag"
      size="sm"
      removable
      @remove="remove(tag)"
    >{{ tag }}</DsChip>

    <span v-if="adding" class="prop-tags-cell__add">
      <DsInput
        ref="inputRef"
        v-model="draft"
        size="sm"
        :placeholder="t('inspector.addTag')"
        @keydown.enter.prevent="commitDraft"
        @keydown.esc.prevent="adding = false"
        @keydown.delete="onBackspace"
        @blur="adding = false"
      />
      <ul v-if="suggestions.length" class="prop-tags-cell__sugg">
        <li
          v-for="s in suggestions"
          :key="s"
          class="prop-tags-cell__sugg-item"
          @mousedown.prevent="add(s)"
        >{{ s }}</li>
      </ul>
    </span>
    <button v-else type="button" class="prop-tags-cell__plus" @click="startAdd">+</button>
  </div>
</template>

<style scoped>
.prop-tags-cell {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--sp-1);
  width: 100%;
}
.prop-tags-cell__add {
  position: relative;
  display: inline-flex;
  min-width: 100px;
}
.prop-tags-cell__sugg {
  position: absolute;
  top: 100%;
  left: 0;
  margin: 2px 0 0;
  padding: var(--sp-1);
  list-style: none;
  background: var(--bg-elev);
  border: 1px solid var(--border);
  border-radius: var(--r-md);
  box-shadow: var(--sh-pop);
  z-index: var(--z-pop);
  min-width: 120px;
  max-height: 180px;
  overflow-y: auto;
}
.prop-tags-cell__sugg-item {
  padding: var(--sp-1) var(--sp-2);
  border-radius: var(--r-sm);
  font-size: 12px;
  cursor: pointer;
  white-space: nowrap;
}
.prop-tags-cell__sugg-item:hover {
  background: var(--bg-hover);
}
.prop-tags-cell__plus {
  width: 20px;
  height: 20px;
  border-radius: var(--r-full);
  border: 1px dashed var(--border);
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
  line-height: 1;
  font-size: 13px;
}
.prop-tags-cell__plus:hover {
  border-style: solid;
  color: var(--text);
  background: var(--bg-hover);
}
.prop-tags-cell__plus:focus-visible,
.prop-tags-cell__sugg-item:focus-visible {
  outline: none;
  box-shadow: var(--ring);
}
</style>
