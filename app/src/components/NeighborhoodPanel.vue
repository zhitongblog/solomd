<script setup lang="ts">
/**
 * v4.6.1 F4 — "Neighborhood" relationship explorer pane (production).
 *
 * A grouped-list view of the focal note's relationships, driven entirely by
 * Markdown frontmatter (mirrors Tolaria's Neighborhood; NOT a force graph).
 * Right-sidebar pane modeled on BacklinksPanel, rebuilt on the design system
 * (DsPanel / DsListRow / DsChip / DsButton / DsTooltip).
 *
 * Sections:
 *   - Outgoing  : one group per relationship frontmatter key (memoized, pure)
 *   - Inverse   : reverse edges resolved server-side via
 *                 `workspace_index_referenced_by` (Children / Referenced by /
 *                 ← Key) — the O(n) scan happens once in Rust, not the client
 *   - Backlinks : body-wikilink backlinks (workspace_index_backlinks)
 *
 * Interactions:
 *   - plain click            → opens the note in a tab
 *   - cmd/ctrl-click         → PIVOTS the panel's focal note (panel-local;
 *                              does NOT open a tab) and pushes the history stack
 *   - breadcrumb back / ‹    → pops the pivot stack
 *   - Escape                 → pops the pivot stack, GUARDED so it never steals
 *                              Escape from CodeMirror / inputs / contenteditable
 */
import { computed, onMounted, onBeforeUnmount, ref, watch } from 'vue';
import { useTabsStore } from '../stores/tabs';
import {
  useWorkspaceIndexStore,
  type BacklinkRef,
  type ReferencedByRef,
} from '../stores/workspaceIndex';
import { useFiles } from '../composables/useFiles';
import { useI18n } from '../i18n';
import { DsPanel, DsListRow, DsChip, DsButton, DsTooltip } from '../ui';
import {
  outgoingFor,
  groupReferencedBy,
  createHistory,
  pushHistory,
  popHistory,
  historyTop,
  canGoBack,
  type NeighborGroup,
  type NeighborRef,
  type NeighborhoodHistory,
} from '../composables/useNeighborhood';
import NeighborhoodGroupSection from './NeighborhoodGroupSection.vue';

const tabs = useTabsStore();
const idx = useWorkspaceIndexStore();
const files = useFiles();
const { t } = useI18n();

const emit = defineEmits<{ close: [] }>();

/** Active tab's file path — the default focal note when no pivot is active. */
const activeTabPath = computed<string | null>(() => tabs.activeTab?.filePath ?? null);

// Pivot history is panel-local. Top of stack = current focal note path.
const history = ref<NeighborhoodHistory>(createHistory(activeTabPath.value));

/** The note the panel is currently focused on (active tab, or a pivot). */
const focalPath = computed<string | null>(() => historyTop(history.value));

/** Resolved focal IndexEntry, or null. */
const focalEntry = computed(() => {
  if (!focalPath.value) return null;
  return idx.byPath.get(focalPath.value) ?? null;
});

/** Title for an arbitrary path — index title/stem, else basename. */
function titleForPath(fp: string | null): string {
  if (!fp) return '';
  const e = idx.byPath.get(fp);
  if (e) return (e.title && e.title.trim()) || e.stem;
  const base = fp.split('/').pop() ?? fp;
  return base.replace(/\.[^.]+$/, '');
}

const focalTitle = computed(() => titleForPath(focalPath.value));

/** Breadcrumb trail (root → … → focal); each step is a clickable jump-back. */
const crumbs = computed(() =>
  history.value.stack.map((p, i) => ({
    path: p,
    title: titleForPath(p),
    depth: i,
    isCurrent: i === history.value.stack.length - 1,
  })),
);

// When the active tab changes (and we're not mid-pivot), reset the focal note
// to the new active tab so the panel tracks the editor like Backlinks does.
watch(activeTabPath, (p) => {
  history.value = createHistory(p);
});

// --- Outgoing groups (memoized, pure over focal + entries identity) --------
const outgoing = computed<NeighborGroup[]>(() => {
  const focal = focalEntry.value;
  if (!focal) return [];
  // `idx.entries` is the identity token: Pinia replaces the array wholesale on
  // every `solomd://index-updated`, so this recomputes exactly on index change
  // or focal change and is O(1) on every other reactive tick.
  return outgoingFor(focal, idx.byStem, idx.entries);
});

// --- Inverse groups (server-resolved reverse scan) -------------------------
const inverseRaw = ref<ReferencedByRef[]>([]);
const loadingInverse = ref(false);

/** Stem used to look up inverse refs / body backlinks for the focal note. */
const focalStem = computed<string | null>(() => {
  const e = focalEntry.value;
  if (e) return e.stem;
  const fp = focalPath.value;
  if (!fp) return null;
  const base = fp.split('/').pop() ?? fp;
  return base.replace(/\.[^.]+$/, '');
});

async function reloadInverse() {
  if (!focalStem.value) {
    inverseRaw.value = [];
    return;
  }
  loadingInverse.value = true;
  const stem = focalStem.value;
  try {
    const refs = await idx.referencedBy(stem);
    // Guard against a stale async resolving after the focal moved on.
    if (focalStem.value === stem) inverseRaw.value = refs;
  } finally {
    if (focalStem.value === stem) loadingInverse.value = false;
  }
}

const inverse = computed<NeighborGroup[]>(() =>
  groupReferencedBy(inverseRaw.value, idx.byPath),
);

// --- Backlinks (body links) via the existing Rust command ------------------
const backlinks = ref<BacklinkRef[]>([]);
const loadingBacklinks = ref(false);

async function reloadBacklinks() {
  if (!focalStem.value) {
    backlinks.value = [];
    return;
  }
  loadingBacklinks.value = true;
  const stem = focalStem.value;
  try {
    const all = await idx.backlinksFor(stem);
    const seen = new Set<string>();
    const filtered = all.filter((b) => {
      if (b.from_path === focalPath.value) return false;
      if (seen.has(b.from_path)) return false;
      seen.add(b.from_path);
      return true;
    });
    if (focalStem.value === stem) backlinks.value = filtered;
  } finally {
    if (focalStem.value === stem) loadingBacklinks.value = false;
  }
}

function reloadAll() {
  reloadInverse();
  reloadBacklinks();
}

// Refetch on focal change and on index updates (live update on index change).
watch(focalStem, reloadAll);
watch(() => idx.entries, reloadAll);
onMounted(reloadAll);

const loading = computed(() => loadingInverse.value || loadingBacklinks.value);

const isEmpty = computed(
  () =>
    outgoing.value.length === 0 &&
    inverse.value.length === 0 &&
    backlinks.value.length === 0,
);

const totalCount = computed(
  () =>
    outgoing.value.reduce((n, g) => n + g.refs.length, 0) +
    inverse.value.reduce((n, g) => n + g.refs.length, 0) +
    backlinks.value.length,
);

// --- Navigation + pivot ----------------------------------------------------
async function navigate(r: NeighborRef) {
  await files.openPath(r.path, { bypassNewWindow: true });
}

function pivot(r: NeighborRef) {
  history.value = pushHistory(history.value, r.path);
}

function goBack() {
  const { history: h } = popHistory(history.value);
  history.value = h;
}

/** Jump the breadcrumb back to a specific depth (truncates the stack). */
function jumpTo(depth: number) {
  if (depth >= history.value.stack.length - 1) return;
  history.value = { stack: history.value.stack.slice(0, depth + 1) };
}

async function openBacklink(e: MouseEvent, b: BacklinkRef) {
  if (e.metaKey || e.ctrlKey) {
    history.value = pushHistory(history.value, b.from_path);
    return;
  }
  await files.openPath(b.from_path, { bypassNewWindow: true });
  setTimeout(() => {
    window.dispatchEvent(
      new CustomEvent('solomd:outline-goto', {
        detail: { line: b.line, paneId: undefined },
      }),
    );
  }, 200);
}

// --- Escape-to-back (guarded so it doesn't steal Escape from editor/inputs) -
function onKeydown(ev: KeyboardEvent) {
  if (ev.key !== 'Escape') return;
  if (!canGoBack(history.value)) return;
  const el = document.activeElement as HTMLElement | null;
  if (el) {
    const tag = el.tagName.toLowerCase();
    if (tag === 'input' || tag === 'textarea' || el.isContentEditable) return;
    // CodeMirror editor surface — leave Escape to the editor.
    if (el.closest('.cm-editor')) return;
  }
  ev.preventDefault();
  ev.stopPropagation();
  goBack();
}

onMounted(() => window.addEventListener('keydown', onKeydown));
onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown));
</script>

<template>
  <DsPanel grip @close="emit('close')">
    <template #title>{{ t('neighborhood.heading') }}</template>
    <template #actions>
      <DsChip v-if="focalPath && !isEmpty" size="sm">{{ totalCount }}</DsChip>
    </template>

    <div v-if="!idx.ready" class="nbhd__empty">
      <div class="nbhd__empty-icon" aria-hidden="true">🕸</div>
      <p class="nbhd__empty-title">{{ t('neighborhood.openFolder') }}</p>
    </div>
    <div v-else-if="!focalPath" class="nbhd__empty">
      <div class="nbhd__empty-icon" aria-hidden="true">📄</div>
      <p class="nbhd__empty-title">{{ t('neighborhood.noActive') }}</p>
    </div>

    <template v-else>
      <!-- Focal-note breadcrumb + back affordance (shown when pivoted). -->
      <div v-if="canGoBack(history)" class="nbhd__crumb">
        <DsTooltip :label="t('neighborhood.back')" placement="bottom">
          <DsButton variant="ghost" size="sm" class="nbhd__back" @click="goBack">‹</DsButton>
        </DsTooltip>
        <nav class="nbhd__trail" :aria-label="t('neighborhood.heading')">
          <template v-for="(c, i) in crumbs" :key="c.path">
            <span v-if="i > 0" class="nbhd__trail-sep" aria-hidden="true">›</span>
            <button
              class="nbhd__trail-item"
              :class="{ 'nbhd__trail-item--current': c.isCurrent }"
              type="button"
              :disabled="c.isCurrent"
              :title="c.path"
              @click="jumpTo(c.depth)"
            >{{ c.title }}</button>
          </template>
        </nav>
      </div>
      <div v-else class="nbhd__focalbar">
        <span class="nbhd__focal" :title="focalPath">{{ focalTitle }}</span>
      </div>

      <div v-if="isEmpty && !loading" class="nbhd__empty">
        <div class="nbhd__empty-icon" aria-hidden="true">🪢</div>
        <p class="nbhd__empty-title">{{ t('neighborhood.empty') }}</p>
        <p class="nbhd__empty-hint">{{ t('neighborhood.pivotHint') }}</p>
        <code class="nbhd__empty-code">belongs_to: "[[Parent]]"</code>
      </div>

      <div v-else class="nbhd__body">
        <!-- OUTGOING -->
        <div v-if="outgoing.length" class="nbhd__region">
          <div class="nbhd__region-label">{{ t('neighborhood.outgoing') }}</div>
          <NeighborhoodGroupSection
            v-for="g in outgoing"
            :key="`out-${g.key}`"
            :group="g"
            :focal-path="focalPath"
            @navigate="navigate"
            @pivot="pivot"
          />
        </div>

        <!-- INVERSE -->
        <div v-if="inverse.length" class="nbhd__region">
          <div class="nbhd__region-label">{{ t('neighborhood.inverse') }}</div>
          <NeighborhoodGroupSection
            v-for="g in inverse"
            :key="`inv-${g.key}`"
            :group="g"
            :focal-path="focalPath"
            @navigate="navigate"
            @pivot="pivot"
          />
        </div>

        <!-- BACKLINKS (body links) -->
        <div v-if="backlinks.length" class="nbhd__region">
          <div class="nbhd__region-label">
            {{ t('neighborhood.backlinks') }}
            <DsChip size="sm">{{ backlinks.length }}</DsChip>
          </div>
          <div class="nbhd__bl-list" role="list">
            <DsListRow
              v-for="(b, i) in backlinks"
              :key="`${b.from_path}-${i}`"
              class="nbhd__bl-row"
              :title="b.from_path"
              @click="openBacklink($event, b)"
            >
              <span class="nbhd__bl-title">{{ b.from_name }}</span>
              <template #trailing>
                <span class="nbhd__bl-loc">L{{ b.line }}</span>
              </template>
            </DsListRow>
          </div>
        </div>
      </div>
    </template>
  </DsPanel>
</template>

<style scoped>
.nbhd__empty {
  padding: var(--sp-6) var(--sp-4);
  text-align: center;
  color: var(--text-faint);
}
.nbhd__empty-icon {
  font-size: 28px;
  opacity: 0.5;
  margin-bottom: var(--sp-3);
}
.nbhd__empty-title {
  margin: 0;
  font-size: 12px;
  color: var(--text-muted);
  line-height: 1.5;
}
.nbhd__empty-hint {
  margin: var(--sp-2) 0 0;
  font-size: 11px;
  color: var(--text-faint);
  line-height: 1.5;
}
.nbhd__empty-code {
  display: inline-block;
  margin-top: var(--sp-3);
  padding: var(--sp-1) var(--sp-2);
  background: var(--bg-elev);
  border: 1px solid var(--border);
  border-radius: var(--r-sm);
  font-family: var(--font-mono, monospace);
  font-size: 11px;
  color: var(--text-muted);
}
.nbhd__crumb {
  display: flex;
  align-items: center;
  gap: var(--sp-1);
  padding: var(--sp-2) var(--sp-3);
  border-bottom: 1px solid var(--border);
  background: var(--bg-elev);
}
.nbhd__back {
  font-size: 15px;
  line-height: 1;
  min-width: 0;
  padding: 0 var(--sp-2);
}
.nbhd__trail {
  display: flex;
  align-items: center;
  gap: var(--sp-1);
  overflow: hidden;
  flex: 1;
}
.nbhd__trail-sep {
  color: var(--text-faint);
  font-size: 11px;
  flex-shrink: 0;
}
.nbhd__trail-item {
  background: transparent;
  border: none;
  padding: 0;
  font-size: 12px;
  color: var(--text-muted);
  cursor: pointer;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 120px;
}
.nbhd__trail-item:hover:not(:disabled) {
  color: var(--text);
  text-decoration: underline;
}
.nbhd__trail-item--current {
  color: var(--text);
  font-weight: 600;
  cursor: default;
  flex-shrink: 0;
}
.nbhd__focalbar {
  padding: var(--sp-2) var(--sp-3);
  border-bottom: 1px solid var(--border);
  background: var(--bg-elev);
}
.nbhd__focal {
  display: block;
  font-size: 12px;
  font-weight: 600;
  color: var(--text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.nbhd__body {
  padding: var(--sp-2);
}
.nbhd__region + .nbhd__region {
  margin-top: var(--sp-3);
  padding-top: var(--sp-3);
  border-top: 1px solid var(--border);
}
.nbhd__region-label {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  padding: var(--sp-1) var(--sp-2) var(--sp-1);
  font-size: 10px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--text-faint);
}
.nbhd__bl-list {
  padding-left: var(--sp-2);
}
.nbhd__bl-row {
  font-size: 12px;
}
.nbhd__bl-title {
  font-weight: 500;
}
.nbhd__bl-loc {
  font-size: 10px;
  color: var(--text-faint);
  font-variant-numeric: tabular-nums;
}
</style>
