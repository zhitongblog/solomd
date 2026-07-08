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
import { DsPanel, DsButton, DsInput, DsChip, DsListRow, DsTooltip } from '../ui';

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
const addInputEl = ref<InstanceType<typeof DsInput> | null>(null);

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
  const root = (addInputEl.value as unknown as { $el?: HTMLElement } | null)?.$el;
  root?.querySelector?.('input')?.focus();
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
  <DsPanel grip @close="emit('close')">
    <template #title>{{ t('relationships.heading') }}</template>

    <div v-if="!idx.ready" class="rel__empty">
      <div class="rel__empty-icon" aria-hidden="true">🔗</div>
      <p class="rel__empty-title">{{ t('relationships.openFolder') }}</p>
    </div>
    <div v-else-if="!activePath || !isMarkdown" class="rel__empty">
      <div class="rel__empty-icon" aria-hidden="true">📄</div>
      <p class="rel__empty-title">{{ t('relationships.noActive') }}</p>
    </div>

    <div v-else class="rel__body">
      <!-- Dirty guard: visible "save first" banner; edits disabled while dirty -->
      <div v-if="!canEdit" class="rel__guard" role="status">
        {{ t('relationships.saveFirst') }}
      </div>

      <!-- SECTION 1 — Forward (editable) -->
      <section class="rel__region">
        <div class="rel__region-label">{{ t('relationships.forward') }}</div>

        <div v-if="forwardEmpty" class="rel__region-empty">
          {{ t('relationships.noForward') }}
        </div>

        <div v-for="key in forwardKeys" :key="key" class="rel__group">
          <div class="rel__group-label">{{ humanizeKey(key) }}</div>
          <div class="rel__chips">
            <DsChip
              v-for="ref in forward[key]"
              :key="ref"
              size="sm"
              :removable="canEdit"
              :title="refTarget(ref)"
              class="rel__chip"
              @remove="onRemove(key, ref)"
            >
              <button class="rel__chip-link" type="button" @click="openRef(ref)">
                {{ refTitle(ref) }}
              </button>
            </DsChip>
          </div>
          <!-- inline add-target -->
          <div v-if="addOpenKey === key" class="rel__add">
            <DsInput
              ref="addInputEl"
              v-model="addQuery"
              size="sm"
              :placeholder="t('relationships.searchNote')"
              @keydown="onAddKeydown"
              @blur="closeAdd"
            />
            <ul v-if="addCandidates.length" class="rel__add-list" role="listbox">
              <DsListRow
                v-for="(c, i) in addCandidates"
                :key="c.path"
                as="div"
                :active="i === addHighlight"
                @mousedown.prevent="commitAdd(c.stem)"
                @mouseenter="addHighlight = i"
              >
                {{ c.title || c.stem }}
              </DsListRow>
            </ul>
          </div>
          <DsButton
            v-else
            variant="ghost"
            size="sm"
            :disabled="!canEdit"
            class="rel__add-btn"
            @click="openAdd(key)"
          >
            + {{ t('relationships.addTarget') }}
          </DsButton>
        </div>

        <!-- Suggested placeholder slots -->
        <div
          v-for="key in suggestedAbsent"
          :key="`sug-${key}`"
          class="rel__group rel__group--ghost"
        >
          <div class="rel__group-label rel__group-label--ghost">{{ humanizeKey(key) }}</div>
          <DsButton
            variant="ghost"
            size="sm"
            :disabled="!canEdit"
            class="rel__add-btn rel__add-btn--ghost"
            @click="openAdd(key)"
          >
            + {{ t('relationships.addTarget') }}
          </DsButton>
        </div>

        <!-- Add new relationship key -->
        <div class="rel__addrel">
          <DsButton
            v-if="!addRelOpen"
            variant="subtle"
            size="sm"
            block
            :disabled="!canEdit"
            class="rel__addrel-btn"
            @click="openAddRel"
          >
            + {{ t('relationships.addRelationship') }}
          </DsButton>
          <div v-else class="rel__addrel-form">
            <DsInput
              v-model="newKey"
              size="sm"
              :placeholder="t('relationships.keyPlaceholder')"
            />
            <DsInput
              v-model="newTargetQuery"
              size="sm"
              :placeholder="t('relationships.searchNote')"
              @keydown="onNewTargetKeydown"
            />
            <ul v-if="newTargetCandidates.length" class="rel__add-list" role="listbox">
              <DsListRow
                v-for="(c, i) in newTargetCandidates"
                :key="c.path"
                as="div"
                :active="i === newTargetHighlight"
                @mousedown.prevent="commitAddRel(c.stem)"
                @mouseenter="newTargetHighlight = i"
              >
                {{ c.title || c.stem }}
              </DsListRow>
            </ul>
            <DsButton variant="ghost" size="sm" @click="closeAddRel">
              {{ t('relationships.cancel') }}
            </DsButton>
          </div>
        </div>
      </section>

      <!-- SECTION 2 — Referenced by (read-only, derived) -->
      <section class="rel__region">
        <div class="rel__region-label">{{ t('relationships.referencedBy') }}</div>
        <div v-if="loadingInverse" class="rel__region-empty">
          {{ t('relationships.loading') }}
        </div>
        <div v-else-if="inverseGroups.length === 0" class="rel__region-empty">
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
              <DsListRow
                class="rel__inv-row"
                :title="r.from_path"
                @click="openInverse(r)"
              >
                {{ r.from_name }}
              </DsListRow>
            </DsTooltip>
          </div>
        </div>
      </section>
    </div>
  </DsPanel>
</template>

<style scoped>
.rel__body {
  padding: var(--sp-2);
}

/* Empty / loading state ----------------------------------------------------*/
.rel__empty {
  padding: var(--sp-6) var(--sp-4);
  text-align: center;
  color: var(--text-faint);
}
.rel__empty-icon {
  font-size: 28px;
  opacity: 0.5;
  margin-bottom: var(--sp-3);
}
.rel__empty-title {
  margin: 0;
  font-size: 12px;
  color: var(--text-muted);
  line-height: 1.5;
}

/* Dirty guard banner -------------------------------------------------------*/
.rel__guard {
  margin: 0 var(--sp-1) var(--sp-2);
  padding: var(--sp-2) var(--sp-3);
  background: var(--accent-soft);
  border: 1px solid var(--border);
  border-radius: var(--r-sm);
  font-size: 11px;
  line-height: 1.4;
  color: var(--text-muted);
}

/* Regions ------------------------------------------------------------------*/
.rel__region + .rel__region {
  margin-top: var(--sp-3);
  padding-top: var(--sp-3);
  border-top: 1px solid var(--border);
}
.rel__region-label {
  padding: var(--sp-1) var(--sp-2);
  font-size: 10px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--text-faint);
}
.rel__region-empty {
  padding: var(--sp-2) var(--sp-2) var(--sp-3);
  font-size: 12px;
  color: var(--text-faint);
  line-height: 1.5;
}

/* Groups -------------------------------------------------------------------*/
.rel__group {
  padding: var(--sp-1) var(--sp-2);
  border-radius: var(--r-sm);
}
.rel__group + .rel__group {
  margin-top: var(--sp-1);
}
.rel__group--ghost {
  opacity: 0.75;
}
.rel__group-label {
  font-size: 11px;
  font-weight: 600;
  color: var(--text);
  margin-bottom: var(--sp-1);
}
.rel__group-label--ghost {
  color: var(--text-faint);
  font-weight: 500;
}

/* Forward chips ------------------------------------------------------------*/
.rel__chips {
  display: flex;
  flex-wrap: wrap;
  gap: var(--sp-1);
  margin-bottom: var(--sp-1);
}
/* DsChip wraps the clickable title; the chip itself carries the surface. */
.rel__chip-link {
  background: transparent;
  border: none;
  padding: 0;
  font: inherit;
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
.rel__chip-link:focus-visible {
  outline: none;
  box-shadow: var(--ring);
  border-radius: var(--r-sm);
}

/* Add-target / add-relationship --------------------------------------------*/
.rel__add {
  position: relative;
}
.rel__add-list {
  list-style: none;
  margin: var(--sp-1) 0 0;
  padding: var(--sp-1);
  background: var(--bg-elev);
  border: 1px solid var(--border);
  border-radius: var(--r-md);
  box-shadow: var(--sh-1);
}
.rel__add-btn {
  margin-left: calc(-1 * var(--sp-2));
}
.rel__add-btn--ghost {
  color: var(--text-faint);
}
.rel__addrel {
  padding: var(--sp-1) var(--sp-2);
  margin-top: var(--sp-2);
}
.rel__addrel-form {
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
}

/* Referenced-by list -------------------------------------------------------*/
.rel__inv-list {
  display: flex;
  flex-direction: column;
  gap: 1px;
}
.rel__inv-row {
  font-size: 12px;
}
</style>
