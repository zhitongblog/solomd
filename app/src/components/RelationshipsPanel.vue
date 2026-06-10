<script setup lang="ts">
/**
 * F3 — Typed relationships panel (v4.6).
 *
 * Two stacked sections in one right-sidebar pane (cloned from
 * BacklinksPanel.vue, styled entirely with the existing design tokens):
 *   1. "Relationships" — editable FORWARD edges authored in the active doc's
 *      YAML front matter: one group per relationship key (humanized label),
 *      clickable ref chips with a hover-X to remove, an inline note-search
 *      "add target" control per group, plus an "Add relationship" key+target
 *      form. Suggested starter keys (belongs_to / related_to / has) appear as
 *      faint placeholder slots when absent.
 *   2. "Referenced by" — read-only DERIVED inverse edges, grouped by resolved
 *      inverse label (Children / Referenced by / ← Custom).
 *
 * All edits go through useRelationships → write_file; after the watcher emits
 * `solomd://index-updated`, idx.entries refreshes and both sections recompute.
 */
import { computed, onMounted, ref, watch, nextTick } from 'vue';
import { useTabsStore } from '../stores/tabs';
import {
  useWorkspaceIndexStore,
  type IndexEntry,
  type ReferencedByRef,
} from '../stores/workspaceIndex';
import { useFiles } from '../composables/useFiles';
import { useRelationships } from '../composables/useRelationships';
import {
  humanizeKey,
  resolveInverseLabel,
  orderInverseLabels,
  parseWikilinkTarget,
} from '../lib/relationships';
import { useI18n } from '../i18n';

const tabs = useTabsStore();
const idx = useWorkspaceIndexStore();
const files = useFiles();
const rel = useRelationships();
const { t } = useI18n();

defineEmits<{ close: [] }>();

/** Suggested starter relationship keys, shown as placeholder slots when the
 *  active doc doesn't already declare them. */
const SUGGESTED_KEYS = ['belongs_to', 'related_to', 'has'];

const activePath = computed(() => tabs.activeTab?.filePath ?? null);
const activeStem = computed(() => {
  const t = tabs.activeTab;
  if (!t || !t.fileName) return null;
  return t.fileName.replace(/\.[^.]+$/, '');
});
const isMarkdown = computed(() => tabs.activeTab?.language === 'markdown');

// --- Forward relationships (reactive off the index) -------------------------

const forward = computed<Record<string, string[]>>(() =>
  activePath.value ? rel.forwardFor(activePath.value) : {},
);
const forwardKeys = computed(() => Object.keys(forward.value));
const suggestedAbsent = computed(() =>
  SUGGESTED_KEYS.filter((k) => !forwardKeys.value.some((fk) => fk.toLowerCase() === k)),
);

/** Resolve a `[[stem]]` ref to a display title (index title or the stem). */
function refTitle(ref: string): string {
  const target = parseWikilinkTarget(ref);
  const e = idx.byStem.get(target.toLowerCase());
  return e?.title || target;
}
function refTarget(ref: string): string {
  return parseWikilinkTarget(ref);
}

async function openRef(ref: string) {
  const target = parseWikilinkTarget(ref);
  const e = idx.byStem.get(target.toLowerCase());
  if (e) await files.openPath(e.path, { bypassNewWindow: true });
}

// --- Referenced-by (inverse, server-resolved) -------------------------------

const inverse = ref<ReferencedByRef[]>([]);
const loadingInverse = ref(false);

async function reloadInverse() {
  if (!activeStem.value) {
    inverse.value = [];
    return;
  }
  loadingInverse.value = true;
  try {
    inverse.value = await rel.referencedByFor(activeStem.value);
  } finally {
    loadingInverse.value = false;
  }
}

interface InverseGroup {
  label: string;
  items: ReferencedByRef[];
}
const inverseGroups = computed<InverseGroup[]>(() => {
  const byLabel = new Map<string, ReferencedByRef[]>();
  for (const r of inverse.value) {
    const label = resolveInverseLabel(r.via_key);
    const list = byLabel.get(label) ?? [];
    list.push(r);
    byLabel.set(label, list);
  }
  return orderInverseLabels([...byLabel.keys()]).map((label) => ({
    label,
    items: byLabel.get(label) ?? [],
  }));
});

async function openInverse(r: ReferencedByRef) {
  await files.openPath(r.from_path, { bypassNewWindow: true });
}

watch(activeStem, reloadInverse);
watch(() => idx.entries, reloadInverse);
onMounted(reloadInverse);

// --- Inline "add target" search per relationship key ------------------------

const addOpenKey = ref<string | null>(null);
const addQuery = ref('');
const addHighlight = ref(0);
const addInputEl = ref<HTMLInputElement | null>(null);

function openAdd(key: string) {
  addOpenKey.value = key;
  addQuery.value = '';
  addHighlight.value = 0;
  nextTick(() => addInputEl.value?.focus());
}
function closeAdd() {
  addOpenKey.value = null;
  addQuery.value = '';
}

/** Note-search candidates over the index, filtered by stem/title, excluding
 *  the active doc and refs already present under the open key. */
const addCandidates = computed<IndexEntry[]>(() => {
  if (!addOpenKey.value) return [];
  const q = addQuery.value.trim().toLowerCase();
  const existing = new Set(
    (forward.value[addOpenKey.value] ?? []).map((r) => parseWikilinkTarget(r).toLowerCase()),
  );
  return idx.entries
    .filter((e) => e.path !== activePath.value)
    .filter((e) => !existing.has(e.stem.toLowerCase()))
    .filter((e) => {
      if (!q) return true;
      return (
        e.stem.toLowerCase().includes(q) ||
        (e.title ?? '').toLowerCase().includes(q)
      );
    })
    .slice(0, 8);
});

function onAddKeydown(ev: KeyboardEvent) {
  const n = addCandidates.value.length;
  if (ev.key === 'ArrowDown') {
    ev.preventDefault();
    addHighlight.value = n === 0 ? 0 : (addHighlight.value + 1) % n;
  } else if (ev.key === 'ArrowUp') {
    ev.preventDefault();
    addHighlight.value = n === 0 ? 0 : (addHighlight.value - 1 + n) % n;
  } else if (ev.key === 'Enter') {
    ev.preventDefault();
    const pick = addCandidates.value[addHighlight.value];
    if (pick) void commitAdd(pick.stem);
  } else if (ev.key === 'Escape') {
    ev.preventDefault();
    closeAdd();
  }
}

async function commitAdd(stem: string) {
  const key = addOpenKey.value;
  if (!key) return;
  closeAdd();
  await rel.addRef(key, stem);
}

async function onRemove(key: string, ref: string) {
  await rel.removeRef(key, ref);
}

// --- "Add relationship" key+target form -------------------------------------

const addRelOpen = ref(false);
const newKey = ref('');
const newTargetQuery = ref('');
const newTargetHighlight = ref(0);

function openAddRel() {
  addRelOpen.value = true;
  newKey.value = '';
  newTargetQuery.value = '';
  newTargetHighlight.value = 0;
}
function closeAddRel() {
  addRelOpen.value = false;
}

const newTargetCandidates = computed<IndexEntry[]>(() => {
  const q = newTargetQuery.value.trim().toLowerCase();
  return idx.entries
    .filter((e) => e.path !== activePath.value)
    .filter((e) => {
      if (!q) return true;
      return e.stem.toLowerCase().includes(q) || (e.title ?? '').toLowerCase().includes(q);
    })
    .slice(0, 8);
});

function onNewTargetKeydown(ev: KeyboardEvent) {
  const n = newTargetCandidates.value.length;
  if (ev.key === 'ArrowDown') {
    ev.preventDefault();
    newTargetHighlight.value = n === 0 ? 0 : (newTargetHighlight.value + 1) % n;
  } else if (ev.key === 'ArrowUp') {
    ev.preventDefault();
    newTargetHighlight.value = n === 0 ? 0 : (newTargetHighlight.value - 1 + n) % n;
  } else if (ev.key === 'Enter') {
    ev.preventDefault();
    const pick = newTargetCandidates.value[newTargetHighlight.value];
    if (pick) void commitAddRel(pick.stem);
  } else if (ev.key === 'Escape') {
    ev.preventDefault();
    closeAddRel();
  }
}

async function commitAddRel(stem: string) {
  const key = newKey.value.trim();
  if (!key) return;
  closeAddRel();
  await rel.addRelationshipKey(key, stem);
}
</script>

<template>
  <div class="rel">
    <header class="rel__head">
      <span class="rel__title">{{ t('relationships.heading') }}</span>
      <button
        class="rs-pane-close"
        type="button"
        :title="t('rightSidebar.hidePane')"
        @click="$emit('close')"
      >×</button>
    </header>

    <div v-if="!idx.ready" class="rel__empty">{{ t('relationships.openFolder') }}</div>
    <div v-else-if="!activePath || !isMarkdown" class="rel__empty">{{ t('relationships.noActive') }}</div>

    <div v-else class="rel__body">
      <!-- SECTION 1 — Forward (editable) -->
      <section class="rel__section">
        <div class="rel__section-head">{{ t('relationships.forward') }}</div>

        <div v-if="forwardKeys.length === 0 && suggestedAbsent.length === 0" class="rel__empty">
          {{ t('relationships.noForward') }}
        </div>

        <div v-for="key in forwardKeys" :key="key" class="rel__group">
          <div class="rel__group-label">{{ humanizeKey(key) }}</div>
          <ul class="rel__chips">
            <li v-for="ref in forward[key]" :key="ref" class="rel__chip">
              <button class="rel__chip-link" :title="refTarget(ref)" @click="openRef(ref)">
                {{ refTitle(ref) }}
              </button>
              <button
                class="rel__chip-x"
                type="button"
                :title="t('relationships.remove')"
                @click="onRemove(key, ref)"
              >×</button>
            </li>
          </ul>
          <!-- inline add-target -->
          <div v-if="addOpenKey === key" class="rel__add">
            <input
              ref="addInputEl"
              v-model="addQuery"
              class="rel__add-input"
              :placeholder="t('relationships.searchNote')"
              @keydown="onAddKeydown"
              @blur="closeAdd"
            />
            <ul v-if="addCandidates.length" class="rel__add-list">
              <li
                v-for="(c, i) in addCandidates"
                :key="c.path"
                :class="['rel__add-item', i === addHighlight ? 'rel__add-item--active' : '']"
                @mousedown.prevent="commitAdd(c.stem)"
                @mouseenter="addHighlight = i"
              >
                {{ c.title || c.stem }}
              </li>
            </ul>
          </div>
          <button v-else class="rel__add-btn" type="button" @click="openAdd(key)">
            + {{ t('relationships.addTarget') }}
          </button>
        </div>

        <!-- Suggested placeholder slots -->
        <div v-for="key in suggestedAbsent" :key="`sug-${key}`" class="rel__group rel__group--ghost">
          <div class="rel__group-label rel__group-label--ghost">{{ humanizeKey(key) }}</div>
          <button class="rel__add-btn rel__add-btn--ghost" type="button" @click="openAdd(key)">
            + {{ t('relationships.addTarget') }}
          </button>
        </div>

        <!-- Add new relationship key -->
        <div class="rel__addrel">
          <button v-if="!addRelOpen" class="rel__addrel-btn" type="button" @click="openAddRel">
            + {{ t('relationships.addRelationship') }}
          </button>
          <div v-else class="rel__addrel-form">
            <input
              v-model="newKey"
              class="rel__add-input"
              :placeholder="t('relationships.keyPlaceholder')"
            />
            <input
              v-model="newTargetQuery"
              class="rel__add-input"
              :placeholder="t('relationships.searchNote')"
              @keydown="onNewTargetKeydown"
            />
            <ul v-if="newTargetCandidates.length" class="rel__add-list">
              <li
                v-for="(c, i) in newTargetCandidates"
                :key="c.path"
                :class="['rel__add-item', i === newTargetHighlight ? 'rel__add-item--active' : '']"
                @mousedown.prevent="commitAddRel(c.stem)"
                @mouseenter="newTargetHighlight = i"
              >
                {{ c.title || c.stem }}
              </li>
            </ul>
            <button class="rel__add-btn" type="button" @click="closeAddRel">
              {{ t('relationships.cancel') }}
            </button>
          </div>
        </div>
      </section>

      <!-- SECTION 2 — Referenced by (read-only, derived) -->
      <section class="rel__section">
        <div class="rel__section-head">{{ t('relationships.referencedBy') }}</div>
        <div v-if="loadingInverse" class="rel__empty">{{ t('relationships.loading') }}</div>
        <div v-else-if="inverseGroups.length === 0" class="rel__empty">
          {{ t('relationships.noReferencedBy') }}
        </div>
        <div v-for="g in inverseGroups" :key="g.label" class="rel__group">
          <div class="rel__group-label">{{ g.label }}</div>
          <ul class="rel__inv-list">
            <li
              v-for="(r, i) in g.items"
              :key="`${r.from_path}-${i}`"
              class="rel__inv-item"
            >
              <button
                class="rel__inv-link"
                :title="t('relationships.inverseOf', { key: humanizeKey(r.via_key) })"
                @click="openInverse(r)"
              >
                {{ r.from_name }}
              </button>
            </li>
          </ul>
        </div>
      </section>
    </div>
  </div>
</template>

<style scoped>
.rel {
  display: flex;
  flex-direction: column;
  height: 100%;
  background: var(--bg);
  border-left: 1px solid var(--border);
  overflow: hidden;
}
.rel__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 12px;
  border-bottom: 1px solid var(--border);
  background: var(--bg-soft);
}
.rel__title {
  font-size: 11px;
  font-weight: 600;
  color: var(--text-muted);
  text-transform: uppercase;
  letter-spacing: 0.06em;
}
.rel__body {
  flex: 1;
  overflow-y: auto;
  padding: 6px;
}
.rel__section + .rel__section {
  margin-top: 10px;
  border-top: 1px solid var(--border);
  padding-top: 8px;
}
.rel__section-head {
  font-size: 10px;
  font-weight: 600;
  color: var(--text-muted);
  text-transform: uppercase;
  letter-spacing: 0.06em;
  padding: 2px 8px 6px;
}
.rel__empty {
  padding: 16px;
  text-align: center;
  color: var(--text-faint);
  font-size: 12px;
  line-height: 1.6;
}
.rel__group {
  padding: 6px 8px;
  border-radius: 6px;
}
.rel__group + .rel__group {
  margin-top: 2px;
}
.rel__group-label {
  font-size: 11px;
  font-weight: 600;
  color: var(--text);
  margin-bottom: 4px;
}
.rel__group-label--ghost {
  color: var(--text-faint);
  font-weight: 500;
}
.rel__group--ghost {
  opacity: 0.75;
}
.rel__chips {
  list-style: none;
  margin: 0 0 4px;
  padding: 0;
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}
.rel__chip {
  display: inline-flex;
  align-items: center;
  background: var(--bg-elev);
  border: 1px solid var(--border);
  border-radius: 999px;
  overflow: hidden;
}
.rel__chip-link {
  background: transparent;
  border: none;
  padding: 2px 4px 2px 10px;
  font-size: 12px;
  color: var(--accent);
  cursor: pointer;
  max-width: 160px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.rel__chip-link:hover {
  text-decoration: underline;
}
.rel__chip-x {
  background: transparent;
  border: none;
  padding: 2px 8px 2px 4px;
  font-size: 13px;
  line-height: 1;
  color: var(--text-faint);
  cursor: pointer;
}
.rel__chip-x:hover {
  color: var(--text);
}
.rel__add {
  position: relative;
}
.rel__add-input {
  width: 100%;
  box-sizing: border-box;
  background: var(--bg-elev);
  border: 1px solid var(--border);
  border-radius: 5px;
  padding: 4px 8px;
  font-size: 12px;
  color: var(--text);
}
.rel__add-input:focus {
  outline: none;
  border-color: var(--accent);
}
.rel__add-input + .rel__add-input {
  margin-top: 4px;
}
.rel__add-list {
  list-style: none;
  margin: 4px 0 0;
  padding: 4px;
  background: var(--bg-elev);
  border: 1px solid var(--border);
  border-radius: 6px;
}
.rel__add-item {
  padding: 4px 8px;
  font-size: 12px;
  color: var(--text);
  border-radius: 4px;
  cursor: pointer;
}
.rel__add-item--active {
  background: var(--bg-hover);
}
.rel__add-btn {
  background: transparent;
  border: none;
  padding: 2px 4px;
  font-size: 11px;
  color: var(--text-muted);
  cursor: pointer;
}
.rel__add-btn:hover {
  color: var(--accent);
}
.rel__add-btn--ghost {
  color: var(--text-faint);
}
.rel__addrel {
  padding: 6px 8px;
  margin-top: 4px;
}
.rel__addrel-btn {
  background: transparent;
  border: 1px dashed var(--border);
  border-radius: 6px;
  width: 100%;
  padding: 6px;
  font-size: 11px;
  color: var(--text-muted);
  cursor: pointer;
}
.rel__addrel-btn:hover {
  border-color: var(--accent);
  color: var(--accent);
}
.rel__inv-list {
  list-style: none;
  margin: 0;
  padding: 0;
}
.rel__inv-item + .rel__inv-item {
  margin-top: 2px;
}
.rel__inv-link {
  display: block;
  width: 100%;
  text-align: left;
  background: transparent;
  border: 1px solid transparent;
  padding: 5px 8px;
  border-radius: 6px;
  font-size: 12px;
  color: var(--text);
  cursor: pointer;
  transition: background 0.12s, border-color 0.12s;
}
.rel__inv-link:hover {
  background: var(--bg-hover);
  border-color: var(--border);
}
</style>
