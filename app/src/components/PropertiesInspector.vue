<script setup lang="ts">
/** v4.6 F1 — Properties inspector pane (right sidebar, id `inspector`, ⌘⇧I).
 *
 * A Markdown-first frontmatter editor: the YAML `---` block of the active note
 * IS the data model. This pane reads parsed frontmatter from the workspace
 * index (via `useProperties`) and writes back through the Rust round-trip
 * command so the body stays byte-identical and key order is preserved. Type is
 * inferred at render time (`inferDisplayMode`) with user overrides persisted
 * out-of-band in `.solomd/properties.json` (the properties store) — never in
 * the note.
 *
 * Sections, in order: pinned properties → the rest of the frontmatter → a small
 * fixed set of suggested slots (Status / Date / URL) the note hasn't set yet →
 * the "+ Add property" affordance. (SoloMD has no Type system, so Tolaria's
 * type-derived rows + Type/Workspace selectors are intentionally dropped.)
 */
import { ref, computed } from 'vue';
import { useProperties } from '../composables/useProperties';
import { usePropertiesStore } from '../stores/properties';
import { useWorkspaceStore } from '../stores/workspace';
import { useTabsStore } from '../stores/tabs';
import { useI18n } from '../i18n';
import {
  inferDisplayMode,
  coerceForMode,
  type DisplayMode,
} from '../lib/property-types';
import PropertyRow from './properties/PropertyRow.vue';
import AddPropertyForm from './properties/AddPropertyForm.vue';

const emit = defineEmits<{ close: [] }>();

const props = useProperties();
const store = usePropertiesStore();
const workspace = useWorkspaceStore();
const tabs = useTabsStore();
const { t } = useI18n();

/** Suggested keys the inspector offers when the note hasn't set them. Fixed,
 *  small set (no Type system to derive from). */
const SUGGESTED: { key: string; mode: DisplayMode }[] = [
  { key: 'status', mode: 'status' },
  { key: 'date', mode: 'date' },
  { key: 'url', mode: 'url' },
];

/** Effective display mode = user override ?? inferred. */
function modeFor(key: string, value: unknown): DisplayMode {
  return store.overrideFor(key) ?? inferDisplayMode(key, value);
}

interface Row {
  key: string;
  value: unknown;
  mode: DisplayMode;
  pinned: boolean;
}

const rows = computed<Row[]>(() => {
  const list = props.entries.value.map((e) => ({
    key: e.key,
    value: e.value,
    mode: modeFor(e.key, e.value),
    pinned: store.isPinned(e.key),
  }));
  // Pinned first (in pin order), then the rest in file order.
  const pinnedOrder = new Map(store.pinned.map((k, i) => [k, i]));
  return list.sort((a, b) => {
    const ap = pinnedOrder.has(a.key);
    const bp = pinnedOrder.has(b.key);
    if (ap && bp) return (pinnedOrder.get(a.key)! - pinnedOrder.get(b.key)!);
    if (ap) return -1;
    if (bp) return 1;
    return 0;
  });
});

/** Suggested slots whose key the note doesn't already declare. */
const suggested = computed(() => SUGGESTED.filter((s) => !props.has(s.key)));

const adding = ref(false);

async function onUpdate(key: string, value: unknown) {
  await props.update(key, value);
}

async function onRemove(key: string) {
  await props.remove(key);
  // Drop any out-of-band config for a key that no longer exists.
  if (store.overrideFor(key)) await store.setDisplayMode(key, null);
  if (store.isPinned(key)) await store.togglePinned(key);
}

async function onRecast(key: string, value: unknown, mode: DisplayMode) {
  await store.setDisplayMode(key, mode);
  // Coerce the persisted value so it matches the new mode's JS shape, unless
  // the value is empty (nothing to coerce / write).
  if (value != null && value !== '') {
    const coerced = coerceForMode(mode, value);
    await props.update(key, coerced);
  }
}

async function onTogglePin(key: string) {
  await store.togglePinned(key);
}

async function addSuggested(s: { key: string; mode: DisplayMode }) {
  const empty: unknown = s.mode === 'tags' || s.mode === 'relation' ? [] : s.mode === 'boolean' ? false : '';
  // Persist the suggested mode as an override so the new (empty) value renders
  // with the right editor even before inference has a value to chew on.
  await store.setDisplayMode(s.key, s.mode);
  await props.update(s.key, empty);
}

async function onAddConfirm(payload: { key: string; mode: DisplayMode; value: unknown }) {
  adding.value = false;
  // If the chosen mode isn't what inference would pick, record an override.
  const inferred = inferDisplayMode(payload.key, payload.value);
  if (payload.mode !== inferred) {
    await store.setDisplayMode(payload.key, payload.mode);
  }
  await props.update(payload.key, payload.value);
}

const activeName = computed(() => tabs.activeTab?.fileName ?? null);
</script>

<template>
  <div class="inspector">
    <header class="inspector__head">
      <span class="inspector__title">{{ t('inspector.heading') }}</span>
      <span v-if="props.ready.value && rows.length" class="inspector__count">{{ rows.length }}</span>
      <button
        class="rs-pane-close"
        type="button"
        :title="t('rightSidebar.hidePane')"
        @click="emit('close')"
      >×</button>
    </header>

    <div v-if="!workspace.currentFolder" class="inspector__empty">{{ t('inspector.openFolder') }}</div>
    <div v-else-if="!props.activePath.value" class="inspector__empty">{{ t('inspector.noActive') }}</div>
    <div v-else-if="!props.ready.value" class="inspector__empty">{{ t('inspector.notMarkdown') }}</div>

    <div v-else class="inspector__body">
      <div v-if="activeName" class="inspector__file">{{ activeName }}</div>

      <div class="inspector__rows">
        <PropertyRow
          v-for="row in rows"
          :key="row.key"
          :prop-key="row.key"
          :value="row.value"
          :mode="row.mode"
          :pinned="row.pinned"
          @update="onUpdate(row.key, $event)"
          @remove="onRemove(row.key)"
          @recast="onRecast(row.key, row.value, $event)"
          @toggle-pin="onTogglePin(row.key)"
        />
        <p v-if="!rows.length" class="inspector__none">{{ t('inspector.noProps') }}</p>
      </div>

      <div v-if="suggested.length" class="inspector__suggested">
        <span class="inspector__suggested-label">{{ t('inspector.suggested') }}</span>
        <div class="inspector__suggested-chips">
          <button
            v-for="s in suggested"
            :key="s.key"
            type="button"
            class="inspector__suggested-chip"
            @click="addSuggested(s)"
          >+ {{ s.key }}</button>
        </div>
      </div>

      <AddPropertyForm
        v-if="adding"
        @confirm="onAddConfirm"
        @cancel="adding = false"
      />
      <button v-else type="button" class="inspector__add" @click="adding = true">
        + {{ t('inspector.addProperty') }}
      </button>
    </div>
  </div>
</template>

<style scoped>
.inspector {
  display: flex;
  flex-direction: column;
  height: 100%;
  background: var(--bg);
  border-left: 1px solid var(--border);
  overflow: hidden;
}
.inspector__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--sp-2);
  padding: var(--sp-2) var(--sp-3);
  border-bottom: 1px solid var(--border);
  background: var(--bg-elev);
}
.inspector__title {
  flex: 1;
  font-size: 11px;
  font-weight: 600;
  color: var(--text-muted);
  text-transform: uppercase;
  letter-spacing: 0.06em;
}
.inspector__count {
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: var(--r-full);
  padding: 1px 8px;
  font-size: 11px;
  color: var(--text-muted);
  font-variant-numeric: tabular-nums;
}
.inspector__empty {
  padding: var(--sp-6) var(--sp-4);
  text-align: center;
  color: var(--text-muted);
  font-size: 12px;
  line-height: 1.6;
}
.inspector__body {
  flex: 1;
  overflow-y: auto;
  padding: var(--sp-3);
  display: flex;
  flex-direction: column;
  gap: var(--sp-3);
}
.inspector__file {
  font-size: 11px;
  color: var(--text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.inspector__rows {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.inspector__none {
  margin: 0;
  padding: var(--sp-3) 0;
  font-size: 12px;
  color: var(--text-muted);
}
.inspector__suggested {
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
  padding-top: var(--sp-2);
  border-top: 1px solid var(--border);
}
.inspector__suggested-label {
  font-size: 10px;
  font-weight: 600;
  color: var(--text-muted);
  text-transform: uppercase;
  letter-spacing: 0.06em;
}
.inspector__suggested-chips {
  display: flex;
  flex-wrap: wrap;
  gap: var(--sp-2);
}
.inspector__suggested-chip {
  background: transparent;
  border: 1px dashed var(--border);
  border-radius: var(--r-full);
  color: var(--text-muted);
  font-size: 12px;
  padding: 2px var(--sp-3);
  cursor: pointer;
}
.inspector__suggested-chip:hover {
  border-style: solid;
  color: var(--text);
  background: var(--bg-hover);
}
.inspector__add {
  align-self: flex-start;
  background: transparent;
  border: 1px dashed var(--border);
  border-radius: var(--r-md);
  color: var(--text-muted);
  font-size: 12px;
  padding: var(--sp-2) var(--sp-3);
  cursor: pointer;
}
.inspector__add:hover {
  border-style: solid;
  color: var(--text);
  background: var(--bg-hover);
}
</style>

<style>
/* Shared (non-scoped) click-to-edit trigger used by the value cells. Defined
 * once here so each cell component stays free of duplicated trigger CSS. */
.prop-value-trigger {
  display: inline-block;
  width: 100%;
  text-align: left;
  background: transparent;
  border: none;
  color: var(--text);
  font: inherit;
  font-size: 13px;
  padding: 2px var(--sp-1);
  border-radius: var(--r-sm);
  cursor: text;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.prop-value-trigger:hover {
  background: var(--bg-hover);
}
.prop-value-trigger--empty {
  color: var(--text-muted);
}
</style>
