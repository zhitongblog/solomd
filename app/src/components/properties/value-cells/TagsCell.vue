<script setup lang="ts">
/** v4.6 F1 — tags value cell. Renders the array value as removable chips and
 *  an inline add-input with vault-wide autocomplete (the properties store's
 *  `vaultTagsByKey[propKey]`). Emits the full updated string[] on every
 *  add/remove so the Rust side rewrites the sequence atomically. */
import { ref, computed, nextTick } from 'vue';
import Icons from '../../Icons.vue';
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
const inputRef = ref<HTMLInputElement | null>(null);

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
  inputRef.value?.focus();
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
    <span v-for="tag in items" :key="tag" class="rp-chip prop-tags-cell__chip">
      {{ tag }}
      <button
        type="button"
        class="prop-tags-cell__x"
        :aria-label="t('inspector.removeTag')"
        @click.stop="remove(tag)"
      ><Icons name="close" :size="10" /></button>
    </span>

    <span v-if="adding" class="prop-tags-cell__add">
      <input
        ref="inputRef"
        v-model="draft"
        class="rp-input prop-cell-input"
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
    <button v-else type="button" class="prop-tags-cell__plus" :aria-label="t('inspector.addTag')" :title="t('inspector.addTag')" @click="startAdd"><Icons name="plus" :size="12" /></button>
  </div>
</template>

<style scoped>
.prop-tags-cell {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px;
  width: 100%;
  padding: 2px 0;
}
.prop-tags-cell__chip {
  cursor: default;
  padding-right: 3px;
}
.prop-tags-cell__x {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  padding: 0;
  border: 0;
  border-radius: var(--r-full);
  background: transparent;
  color: var(--text-3);
  cursor: pointer;
}
.prop-tags-cell__x:hover {
  background: var(--fill-2);
  color: var(--text);
}
.prop-tags-cell__x:focus-visible {
  outline: none;
  box-shadow: var(--ring);
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
  margin: 4px 0 0;
  padding: 4px;
  list-style: none;
  background: var(--bg-pop);
  border: var(--bd-hair);
  border-radius: var(--r-lg);
  box-shadow: var(--sh-pop);
  z-index: var(--z-pop);
  min-width: 120px;
  max-height: 180px;
  overflow-y: auto;
}
.prop-tags-cell__sugg-item {
  display: flex;
  align-items: center;
  min-height: 28px;
  padding: 0 8px;
  border-radius: var(--r-sm);
  font-size: 13px;
  cursor: pointer;
  white-space: nowrap;
}
.prop-tags-cell__sugg-item:hover {
  background: var(--fill-1);
}
.prop-tags-cell__plus {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  padding: 0;
  border: 0;
  border-radius: var(--r-full);
  background: transparent;
  color: var(--text-3);
  cursor: pointer;
}
.prop-tags-cell__plus:hover {
  color: var(--text);
  background: var(--fill-1);
}
.prop-tags-cell__plus:focus-visible,
.prop-tags-cell__sugg-item:focus-visible {
  outline: none;
  box-shadow: var(--ring);
}
</style>
