<script setup lang="ts">
/** v4.6 F1 — relation value cell. The value holds one or more `[[wikilink]]`s
 *  (either a single string or an array of strings). Each wikilink renders as a
 *  chip; clicking it resolves the target via the workspace index and opens the
 *  note (the BacklinksPanel navigation pattern). A chip reads "unresolved" (and
 *  is non-navigating) when the target stem isn't in the index. An inline editor
 *  lets you retype the raw value; Enter saves, Esc cancels. */
import { ref, computed, watch, nextTick } from 'vue';
import { DsChip, DsInput } from '../../../ui';
import { extractWikilinks, chipLabel, type Wikilink } from '../../../lib/wikilinks';
import { useWorkspaceIndexStore } from '../../../stores/workspaceIndex';
import { useFiles } from '../../../composables/useFiles';

const props = defineProps<{ value: unknown }>();
const emit = defineEmits<{ update: [string | string[]] }>();

const idx = useWorkspaceIndexStore();
const files = useFiles();

/** Was the source value an array? Drives whether we emit a string[] or string. */
const isArray = computed(() => Array.isArray(props.value));

/** Flatten the value to the raw string(s) we parse wikilinks out of. */
const rawStrings = computed<string[]>(() => {
  const v = props.value;
  if (Array.isArray(v)) return v.map((x) => (typeof x === 'string' ? x : String(x)));
  if (v == null) return [];
  return [typeof v === 'string' ? v : String(v)];
});

interface Link extends Wikilink {
  resolvedPath: string | null;
}

const links = computed<Link[]>(() => {
  const out: Link[] = [];
  for (const s of rawStrings.value) {
    for (const wl of extractWikilinks(s)) {
      const entry = idx.byStem.get(wl.target.toLowerCase());
      out.push({ ...wl, resolvedPath: entry?.path ?? null });
    }
  }
  return out;
});

async function open(link: Link) {
  let path = link.resolvedPath;
  if (!path) path = await idx.resolve(link.target);
  if (!path) return;
  await files.openPath(path, { bypassNewWindow: true });
  if (link.heading) {
    setTimeout(() => {
      window.dispatchEvent(
        new CustomEvent('solomd:outline-goto', { detail: { heading: link.heading } }),
      );
    }, 200);
  }
}

// ---- raw editing ----
const editing = ref(false);
const draft = ref('');
const inputRef = ref<InstanceType<typeof DsInput> | null>(null);

function displayRaw(): string {
  return rawStrings.value.join(isArray.value ? ', ' : '');
}

async function startEdit() {
  draft.value = displayRaw();
  editing.value = true;
  await nextTick();
  const el = (inputRef.value?.$el as HTMLElement | undefined)?.querySelector?.('input');
  el?.focus();
  el?.select();
}

function commit() {
  if (!editing.value) return;
  editing.value = false;
  if (draft.value === displayRaw()) return;
  if (isArray.value) {
    emit(
      'update',
      draft.value
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    );
  } else {
    emit('update', draft.value);
  }
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
  <div class="prop-relation-cell">
    <DsInput
      v-if="editing"
      ref="inputRef"
      v-model="draft"
      size="sm"
      placeholder="[[Note]]"
      @keydown.enter.prevent="commit"
      @keydown.esc.prevent="cancel"
      @blur="commit"
    />
    <template v-else>
      <template v-if="links.length">
        <DsChip
          v-for="(link, i) in links"
          :key="`${link.raw}-${i}`"
          size="sm"
          class="prop-relation-cell__chip"
          :class="{ 'prop-relation-cell__chip--unresolved': !link.resolvedPath }"
          @click="open(link)"
        >{{ chipLabel(link) }}</DsChip>
        <button type="button" class="prop-relation-cell__edit" title="Edit" @click="startEdit">✎</button>
      </template>
      <button
        v-else
        type="button"
        class="prop-value-trigger prop-value-trigger--empty"
        @click="startEdit"
      >{{ displayRaw() || '—' }}</button>
    </template>
  </div>
</template>

<style scoped>
.prop-relation-cell {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--sp-1);
  width: 100%;
}
.prop-relation-cell__chip {
  cursor: pointer;
}
.prop-relation-cell__chip:hover {
  border-color: var(--accent);
  color: var(--accent);
}
.prop-relation-cell__chip--unresolved {
  opacity: 0.55;
  cursor: default;
  text-decoration: line-through;
}
.prop-relation-cell__chip--unresolved:hover {
  border-color: var(--border);
  color: var(--text-muted);
}
.prop-relation-cell__edit {
  background: transparent;
  border: none;
  color: var(--text-muted);
  cursor: pointer;
  font-size: 11px;
  padding: 2px 4px;
  border-radius: var(--r-sm);
}
.prop-relation-cell__edit:hover {
  background: var(--bg-hover);
  color: var(--text);
}
</style>
