<script setup lang="ts">
/**
 * F3 — Typed relationships panel (v4.6, design-system rebuild in v4.6.1).
 *
 * Two stacked sections in one right-sidebar pane, built entirely on the `ui/`
 * design system (DsPanel / DsButton / DsInput / DsChip / DsListRow / DsTooltip)
 * — no raw hex, no ad-hoc CSS islands — matching NeighborhoodPanel / InboxView /
 * TypesPanel for density and focus rings:
 *   1. "Relationships" — editable FORWARD edges authored in the active doc's
 *      YAML front matter: one group per relationship key (humanized label),
 *      clickable removable ref chips (DsChip), an inline note-search "add target"
 *      control per group, plus an "Add relationship" key+target form. Suggested
 *      starter keys (belongs_to / related_to / has) appear as faint placeholder
 *      slots when absent.
 *   2. "Referenced by" — read-only DERIVED inverse edges, grouped by resolved
 *      inverse label (Children / Referenced by / ← Custom), rows via DsListRow.
 *
 * Dirty guard: when the active buffer is dirty (`editability.canEdit === false`)
 * a "save the doc first" banner shows and every edit affordance is disabled, so
 * the guard is *visible* before a click — not just a toast after the failed write.
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
import { DsTooltip } from '../ui';
import Icons from './Icons.vue';
import PanelHeader from './panel/PanelHeader.vue';

const tabs = useTabsStore();
const idx = useWorkspaceIndexStore();
const files = useFiles();
const rel = useRelationships();
const { t } = useI18n();

const emit = defineEmits<{ close: [] }>();

/** Suggested starter relationship keys, shown as placeholder slots when the
 *  active doc doesn't already declare them. */
const SUGGESTED_KEYS = ['belongs_to', 'related_to', 'has'];

const activePath = computed(() => tabs.activeTab?.filePath ?? null);
const activeStem = computed(() => {
  const tab = tabs.activeTab;
  if (!tab || !tab.fileName) return null;
  return tab.fileName.replace(/\.[^.]+$/, '');
});
const isMarkdown = computed(() => tabs.activeTab?.language === 'markdown');

/** Reactive editability — drives the dirty-guard banner and disables every
 *  edit affordance while the active buffer has unsaved changes. */
const editability = rel.editability;
const canEdit = computed(() => editability.value.canEdit);

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

/** Whether the forward section is entirely empty (no groups, no suggestions). */
const forwardEmpty = computed(
  () => forwardKeys.value.length === 0 && suggestedAbsent.value.length === 0,
);

// --- Inline "add target" search per relationship key ------------------------

const addOpenKey = ref<string | null>(null);
const addQuery = ref('');
const addHighlight = ref(0);
const addInputEl = ref<HTMLInputElement | HTMLInputElement[] | null>(null);

function openAdd(key: string) {
  if (!canEdit.value) return;
  addOpenKey.value = key;
  addQuery.value = '';
  addHighlight.value = 0;
  nextTick(() => focusAddInput());
}
function closeAdd() {
  addOpenKey.value = null;
  addQuery.value = '';
}
function focusAddInput() {
  // The input sits inside a v-for, so the template ref is an array.
  const v = addInputEl.value;
  (Array.isArray(v) ? v[0] : v)?.focus();
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
  if (!canEdit.value) return;
  await rel.removeRef(key, ref);
}

// --- "Add relationship" key+target form -------------------------------------

const addRelOpen = ref(false);
const newKey = ref('');
const newTargetQuery = ref('');
const newTargetHighlight = ref(0);

function openAddRel() {
  if (!canEdit.value) return;
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
  <div class="rel rp">
    <PanelHeader :title="t('relationships.heading')" @close="emit('close')" />

    <div v-if="!idx.ready" class="rp-empty">{{ t('relationships.openFolder') }}</div>
    <div v-else-if="!activePath || !isMarkdown" class="rp-empty">{{ t('relationships.noActive') }}</div>

    <div v-else class="rel__body rp-body">
      <!-- Dirty guard: visible "save first" banner; edits disabled while dirty -->
      <div v-if="!canEdit" class="rel__guard" role="status">
        <Icons name="info" :size="14" />
        <span>{{ t('relationships.saveFirst') }}</span>
      </div>

      <!-- SECTION 1 — Forward (editable) -->
      <section class="rel__region">
        <div class="rp-section">{{ t('relationships.forward') }}</div>

        <div v-if="forwardEmpty" class="rel__region-empty rp-sub">
          {{ t('relationships.noForward') }}
        </div>

        <div v-for="key in forwardKeys" :key="key" class="rel__group">
          <div class="rel__group-label">{{ humanizeKey(key) }}</div>
          <div class="rp-chips rel__chips">
            <span
              v-for="ref in forward[key]"
              :key="ref"
              class="rp-chip rel__chip"
              :title="refTarget(ref)"
            >
              <button class="rel__chip-link" type="button" @click="openRef(ref)">
                {{ refTitle(ref) }}
              </button>
              <button
                v-if="canEdit"
                class="rel__chip-x"
                type="button"
                aria-label="Remove"
                @click.stop="onRemove(key, ref)"
              >
                <Icons name="close" :size="11" />
              </button>
            </span>
          </div>
          <!-- inline add-target -->
          <div v-if="addOpenKey === key" class="rel__add">
            <input
              ref="addInputEl"
              v-model="addQuery"
              class="rp-input"
              :placeholder="t('relationships.searchNote')"
              @keydown="onAddKeydown"
              @blur="closeAdd"
            />
            <ul v-if="addCandidates.length" class="rel__add-list" role="listbox">
              <li
                v-for="(c, i) in addCandidates"
                :key="c.path"
                class="rp-row"
                :class="{ 'is-hover': i === addHighlight }"
                role="option"
                @mousedown.prevent="commitAdd(c.stem)"
                @mouseenter="addHighlight = i"
              >
                <Icons class="rp-row__icon" name="file" :size="14" />
                <span class="rp-row__label">{{ c.title || c.stem }}</span>
              </li>
            </ul>
          </div>
          <button
            v-else
            type="button"
            class="rp-btn rp-btn--ghost rp-btn--sm rel__add-btn"
            :disabled="!canEdit"
            @click="openAdd(key)"
          >
            <Icons name="plus" :size="12" />{{ t('relationships.addTarget') }}
          </button>
        </div>

        <!-- Suggested placeholder slots -->
        <div
          v-for="key in suggestedAbsent"
          :key="`sug-${key}`"
          class="rel__group rel__group--ghost"
        >
          <div class="rel__group-label">{{ humanizeKey(key) }}</div>
          <button
            type="button"
            class="rp-btn rp-btn--ghost rp-btn--sm rel__add-btn"
            :disabled="!canEdit"
            @click="openAdd(key)"
          >
            <Icons name="plus" :size="12" />{{ t('relationships.addTarget') }}
          </button>
        </div>

        <!-- Add new relationship key -->
        <div class="rel__addrel">
          <button
            v-if="!addRelOpen"
            type="button"
            class="rp-btn rel__addrel-btn"
            :disabled="!canEdit"
            @click="openAddRel"
          >
            <Icons name="plus" :size="13" />{{ t('relationships.addRelationship') }}
          </button>
          <div v-else class="rel__addrel-form">
            <input
              v-model="newKey"
              class="rp-input"
              :placeholder="t('relationships.keyPlaceholder')"
            />
            <input
              v-model="newTargetQuery"
              class="rp-input"
              :placeholder="t('relationships.searchNote')"
              @keydown="onNewTargetKeydown"
            />
            <ul v-if="newTargetCandidates.length" class="rel__add-list" role="listbox">
              <li
                v-for="(c, i) in newTargetCandidates"
                :key="c.path"
                class="rp-row"
                :class="{ 'is-hover': i === newTargetHighlight }"
                role="option"
                @mousedown.prevent="commitAddRel(c.stem)"
                @mouseenter="newTargetHighlight = i"
              >
                <Icons class="rp-row__icon" name="file" :size="14" />
                <span class="rp-row__label">{{ c.title || c.stem }}</span>
              </li>
            </ul>
            <div class="rel__addrel-actions">
              <button type="button" class="rp-btn rp-btn--ghost rp-btn--sm" @click="closeAddRel">
                {{ t('relationships.cancel') }}
              </button>
            </div>
          </div>
        </div>
      </section>

      <!-- SECTION 2 — Referenced by (read-only, derived) -->
      <section class="rel__region">
        <div class="rp-section">{{ t('relationships.referencedBy') }}</div>
        <div v-if="loadingInverse" class="rel__region-empty rp-sub">
          {{ t('relationships.loading') }}
        </div>
        <div v-else-if="inverseGroups.length === 0" class="rel__region-empty rp-sub">
          {{ t('relationships.noReferencedBy') }}
        </div>
        <div v-for="g in inverseGroups" :key="g.label" class="rel__group">
          <div class="rel__group-label">{{ g.label }}</div>
          <div class="rel__inv-list" role="list">
            <DsTooltip
              v-for="(r, i) in g.items"
              :key="`${r.from_path}-${i}`"
              :label="t('relationships.inverseOf', { key: humanizeKey(r.via_key) })"
              placement="bottom"
            >
              <button
                type="button"
                class="rp-row rel__inv-row"
                :title="r.from_path"
                @click="openInverse(r)"
              >
                <Icons class="rp-row__icon" name="file" :size="14" />
                <span class="rp-row__label">{{ r.from_name }}</span>
              </button>
            </DsTooltip>
          </div>
        </div>
      </section>
    </div>
  </div>
</template>

<style scoped>
/* Dirty guard banner */
.rel__guard {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  margin: 0 0 8px;
  padding: 8px 10px;
  border-radius: var(--r-md);
  background: var(--fill-1);
  font-size: 12px;
  line-height: 1.45;
  color: var(--text-2);
}
.rel__guard :deep(svg) {
  flex: 0 0 auto;
  margin-top: 1px;
  color: var(--accent-text);
}

.rel__region + .rel__region {
  margin-top: 8px;
  padding-top: 4px;
  border-top: var(--bd-hair);
}
.rel__region-empty {
  padding: 2px 8px 8px;
}

.rel__group {
  padding: 4px 8px 6px;
}
.rel__group-label {
  margin-bottom: 4px;
  font-size: 12px;
  font-weight: 500;
  color: var(--text-2);
}
.rel__group--ghost .rel__group-label {
  color: var(--text-3);
  font-weight: 400;
}

.rel__chips {
  margin-bottom: 2px;
}
.rel__chip {
  max-width: 100%;
  cursor: default;
}
.rel__chip:has(.rel__chip-x) {
  padding-right: 3px;
}
.rel__chip-link {
  max-width: 160px;
  padding: 0;
  border: 0;
  background: transparent;
  font: inherit;
  color: var(--text);
  cursor: pointer;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.rel__chip-link:hover {
  color: var(--accent-text);
}
.rel__chip-x {
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
.rel__chip-x:hover {
  background: var(--fill-2);
  color: var(--text);
}
.rel__chip-link:focus-visible,
.rel__chip-x:focus-visible {
  outline: none;
  box-shadow: var(--ring);
  border-radius: var(--r-sm);
}

.rel__add {
  position: relative;
  margin-top: 4px;
}
.rel__add-list {
  list-style: none;
  margin: 4px 0 0;
  padding: 4px;
  background: var(--bg-pop);
  border: var(--bd-hair);
  border-radius: var(--r-lg);
  box-shadow: var(--sh-pop);
}
.rel__add-list .rp-row {
  border-radius: var(--r-sm);
}
.rel__add-list .rp-row.is-hover {
  background: var(--fill-1);
}
.rel__add-btn {
  margin-left: -8px;
  color: var(--text-3);
}
.rel__addrel {
  padding: 8px 8px 4px;
}
.rel__addrel-btn {
  width: 100%;
}
.rel__addrel-form {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.rel__addrel-actions {
  display: flex;
  justify-content: flex-end;
}
.rel__inv-list {
  display: flex;
  flex-direction: column;
  margin: 0 -8px;
}
</style>
