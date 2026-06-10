<script setup lang="ts">
/**
 * v4.6 F4 — "Neighborhood" relationship explorer pane.
 *
 * A grouped-list view of the focal note's relationships, driven entirely by
 * Markdown frontmatter (mirrors Tolaria's Neighborhood; NOT a force graph).
 * Right-sidebar pane modeled on BacklinksPanel.vue: active-tab-driven,
 * reactive to `idx.entries`, raw CSS-var styling.
 *
 * Sections:
 *   - Outgoing  : one group per relationship frontmatter key
 *   - Inverse   : reverse scan (Children / Referenced by / ← Key)
 *   - Backlinks : body-wikilink backlinks (workspace_index_backlinks)
 *
 * Interactions: plain click navigates/opens; cmd/ctrl-click PIVOTS the panel's
 * focal note (panel-local; does NOT open a tab). Escape pops the pivot stack
 * back (guarded so it never steals Escape from the editor / inputs).
 */
import { computed, onMounted, onBeforeUnmount, ref, watch } from 'vue';
import { useTabsStore } from '../stores/tabs';
import { useWorkspaceIndexStore, type BacklinkRef } from '../stores/workspaceIndex';
import { useFiles } from '../composables/useFiles';
import { useI18n } from '../i18n';
import {
  buildNeighborhood,
  createHistory,
  pushHistory,
  popHistory,
  historyTop,
  canGoBack,
  type Neighborhood,
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

const focalTitle = computed(() => {
  const e = focalEntry.value;
  if (e) return (e.title && e.title.trim()) || e.stem;
  // Fall back to the tab's display name when the index hasn't caught up.
  const fp = focalPath.value;
  if (!fp) return '';
  const base = fp.split('/').pop() ?? fp;
  return base.replace(/\.[^.]+$/, '');
});

// When the active tab changes (and we're not mid-pivot), reset the focal note
// to the new active tab so the panel tracks the editor like Backlinks does.
watch(activeTabPath, (p) => {
  history.value = createHistory(p);
});

const neighborhood = computed<Neighborhood>(() => {
  const focal = focalEntry.value;
  if (!focal) return { outgoing: [], inverse: [] };
  // Recomputes when entries identity changes (index-updated) or focal changes.
  return buildNeighborhood(focal, idx.entries, idx.byStem);
});

// --- Backlinks (body links) via the existing Rust command -----------------
const backlinks = ref<BacklinkRef[]>([]);
const loadingBacklinks = ref(false);

/** Stem used to look up body backlinks for the focal note. */
const focalStem = computed<string | null>(() => {
  const e = focalEntry.value;
  if (e) return e.stem;
  const fp = focalPath.value;
  if (!fp) return null;
  const base = fp.split('/').pop() ?? fp;
  return base.replace(/\.[^.]+$/, '');
});

async function reloadBacklinks() {
  if (!focalStem.value) {
    backlinks.value = [];
    return;
  }
  loadingBacklinks.value = true;
  try {
    const all = await idx.backlinksFor(focalStem.value);
    // Dedupe by source path and drop self-references so the Backlinks section
    // complements (rather than duplicates) the frontmatter groups.
    const seen = new Set<string>();
    backlinks.value = all.filter((b) => {
      if (b.from_path === focalPath.value) return false;
      if (seen.has(b.from_path)) return false;
      seen.add(b.from_path);
      return true;
    });
  } finally {
    loadingBacklinks.value = false;
  }
}

watch(focalStem, reloadBacklinks);
watch(() => idx.entries.length, reloadBacklinks);
onMounted(reloadBacklinks);

const isEmpty = computed(
  () =>
    neighborhood.value.outgoing.length === 0 &&
    neighborhood.value.inverse.length === 0 &&
    backlinks.value.length === 0,
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
  goBack();
}

onMounted(() => window.addEventListener('keydown', onKeydown));
onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown));

const totalCount = computed(
  () =>
    neighborhood.value.outgoing.reduce((n, g) => n + g.refs.length, 0) +
    neighborhood.value.inverse.reduce((n, g) => n + g.refs.length, 0) +
    backlinks.value.length,
);
</script>

<template>
  <div class="nbhd">
    <header class="nbhd__head">
      <span class="nbhd__title">{{ t('neighborhood.heading') }}</span>
      <span class="nbhd__count">{{ totalCount }}</span>
      <button
        class="rs-pane-close"
        type="button"
        :title="t('rightSidebar.hidePane')"
        @click="emit('close')"
      >×</button>
    </header>

    <div v-if="!idx.ready" class="nbhd__empty">{{ t('neighborhood.openFolder') }}</div>
    <div v-else-if="!focalPath" class="nbhd__empty">{{ t('neighborhood.noActive') }}</div>

    <template v-else>
      <!-- Focal-note breadcrumb + back affordance (shown when pivoted). -->
      <div class="nbhd__crumb">
        <button
          v-if="canGoBack(history)"
          class="nbhd__back"
          type="button"
          :title="t('neighborhood.back')"
          @click="goBack"
        >‹</button>
        <span class="nbhd__focal" :title="focalPath">{{ focalTitle }}</span>
      </div>

      <div v-if="isEmpty && !loadingBacklinks" class="nbhd__empty">
        {{ t('neighborhood.empty') }}
        <div class="nbhd__hint">{{ t('neighborhood.pivotHint') }}</div>
      </div>

      <div v-else class="nbhd__body">
        <!-- OUTGOING -->
        <div v-if="neighborhood.outgoing.length" class="nbhd__region">
          <div class="nbhd__region-label">{{ t('neighborhood.outgoing') }}</div>
          <NeighborhoodGroupSection
            v-for="g in neighborhood.outgoing"
            :key="`out-${g.key}`"
            :group="g"
            @navigate="navigate"
            @pivot="pivot"
          />
        </div>

        <!-- INVERSE -->
        <div v-if="neighborhood.inverse.length" class="nbhd__region">
          <div class="nbhd__region-label">{{ t('neighborhood.inverse') }}</div>
          <NeighborhoodGroupSection
            v-for="g in neighborhood.inverse"
            :key="`inv-${g.key}`"
            :group="g"
            @navigate="navigate"
            @pivot="pivot"
          />
        </div>

        <!-- BACKLINKS (body links) -->
        <div v-if="backlinks.length" class="nbhd__region">
          <div class="nbhd__region-label">
            {{ t('neighborhood.backlinks') }}
            <span class="nbhd__region-count">{{ backlinks.length }}</span>
          </div>
          <ul class="nbhd__bl-list">
            <li
              v-for="(b, i) in backlinks"
              :key="`${b.from_path}-${i}`"
              class="nbhd__bl-item"
            >
              <button class="nbhd__bl-row" type="button" @click="openBacklink($event, b)">
                <span class="nbhd__bl-title">{{ b.from_name }}</span>
                <span class="nbhd__bl-loc">L{{ b.line }}</span>
              </button>
            </li>
          </ul>
        </div>
      </div>
    </template>
  </div>
</template>

<style scoped>
.nbhd {
  display: flex;
  flex-direction: column;
  height: 100%;
  background: var(--bg);
  border-left: 1px solid var(--border);
  overflow: hidden;
}
.nbhd__head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  border-bottom: 1px solid var(--border);
  background: var(--bg-soft);
}
.nbhd__title {
  font-size: 11px;
  font-weight: 600;
  color: var(--text-muted);
  text-transform: uppercase;
  letter-spacing: 0.06em;
  flex: 1;
}
.nbhd__count {
  background: var(--bg-elev);
  border: 1px solid var(--border);
  border-radius: 999px;
  padding: 1px 8px;
  font-size: 11px;
  color: var(--text-muted);
  font-variant-numeric: tabular-nums;
}
.nbhd__crumb {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 12px;
  border-bottom: 1px solid var(--border);
  background: var(--bg-soft);
}
.nbhd__back {
  background: var(--bg-elev);
  border: 1px solid var(--border);
  border-radius: 6px;
  color: var(--text-muted);
  cursor: pointer;
  font-size: 14px;
  line-height: 1;
  padding: 2px 8px;
}
.nbhd__back:hover {
  background: var(--bg-hover);
  color: var(--text);
}
.nbhd__focal {
  font-size: 12px;
  font-weight: 600;
  color: var(--text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.nbhd__empty {
  padding: 24px 16px;
  text-align: center;
  color: var(--text-faint);
  font-size: 12px;
  line-height: 1.6;
}
.nbhd__hint {
  margin-top: 8px;
  font-size: 11px;
  color: var(--text-faint);
}
.nbhd__body {
  overflow-y: auto;
  flex: 1;
  padding: 6px;
}
.nbhd__region + .nbhd__region {
  margin-top: 10px;
  padding-top: 10px;
  border-top: 1px solid var(--border);
}
.nbhd__region-label {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 2px 8px 4px;
  font-size: 10px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--text-faint);
}
.nbhd__region-count {
  font-variant-numeric: tabular-nums;
}
.nbhd__bl-list {
  list-style: none;
  margin: 0;
  padding: 0 0 0 8px;
}
.nbhd__bl-row {
  display: block;
  width: 100%;
  text-align: left;
  background: transparent;
  border: 1px solid transparent;
  padding: 6px 10px;
  border-radius: 6px;
  cursor: pointer;
  transition: background 0.12s, border-color 0.12s;
}
.nbhd__bl-row:hover {
  background: var(--bg-hover);
  border-color: var(--border);
}
.nbhd__bl-title {
  font-size: 12px;
  font-weight: 500;
  color: var(--text);
}
.nbhd__bl-loc {
  margin-left: 8px;
  font-size: 10px;
  color: var(--text-faint);
  font-variant-numeric: tabular-nums;
}
</style>
