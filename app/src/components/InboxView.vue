<script setup lang="ts">
/**
 * v4.6 F6 — dedicated Inbox workflow view.
 *
 * Center-pane overlay (same App.vue swap convention as BasesView): replaces
 * TileRoot in `.content` while `inboxViewOpen` is true. Opened via the
 * `solomd:open-inbox` window CustomEvent (see useInboxView.ts).
 *
 * Surface:
 *   - sticky header with Week / Month / All period pills + live counts
 *   - a scrollable list of inbox notes (title, captured-date · N links,
 *     optional front-matter property chips)
 *   - inbox-zero empty state
 *   - click a row → open the note; ⌘E from anywhere marks the active note
 *     organized and (when enabled) auto-advances to the next inbox note.
 *
 * Pure presentation over `useInbox` composable state — no store edits beyond
 * the shared `setInboxViewOpen` flag. Design-system tokens only.
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { DsButton, DsChip } from '../ui';
import { useInbox, type InboxPeriod } from '../composables/useInbox';
import { useFiles } from '../composables/useFiles';
import { useWorkspaceIndexStore, type IndexEntry } from '../stores/workspaceIndex';
import { inboxCapturedAt, inboxLinkCount } from '../lib/inbox-filter';
import { inferColumns, getCellValue } from '../lib/bases';
import { useI18n } from '../i18n';
import { INBOX_CLOSE_EVENT } from '../composables/useInboxView';

const inbox = useInbox();
const files = useFiles();
const idx = useWorkspaceIndexStore();
const { t } = useI18n();

// Local UI state — which period pill is selected.
const activePeriod = ref<InboxPeriod>('all');

const periods: { id: InboxPeriod; label: string }[] = [
  { id: 'week', label: 'inbox.periodWeek' },
  { id: 'month', label: 'inbox.periodMonth' },
  { id: 'all', label: 'inbox.periodAll' },
];

const rows = computed<IndexEntry[]>(() => inbox.inboxEntries(activePeriod.value));
const counts = inbox.countByPeriod;

/** Up to two front-matter property chips per row (excluding the inbox flag
 *  itself), reusing the bases column inference so we surface whatever the
 *  vault actually uses (status, type, tags…). */
const chipColumns = computed(() =>
  inferColumns(idx.entries)
    .filter((c) => c.source === 'frontmatter' && c.fmKey !== 'inbox')
    .slice(0, 2),
);

function rowChips(entry: IndexEntry): { label: string; value: string }[] {
  const out: { label: string; value: string }[] = [];
  for (const col of chipColumns.value) {
    const v = getCellValue(entry, col);
    if (v == null || v === '') continue;
    out.push({ label: col.label, value: String(v) });
  }
  return out;
}

function titleFor(entry: IndexEntry): string {
  return entry.title || entry.stem || entry.name;
}

function capturedLabel(entry: IndexEntry): string {
  const ms = inboxCapturedAt(entry);
  if (!ms) return '';
  try {
    return new Date(ms).toLocaleDateString();
  } catch {
    return '';
  }
}

function selectPeriod(p: InboxPeriod) {
  activePeriod.value = p;
}

async function openRow(entry: IndexEntry) {
  await files.openPath(entry.path, { bypassNewWindow: true });
}

function close() {
  window.dispatchEvent(new CustomEvent(INBOX_CLOSE_EVENT));
}

onMounted(() => {
  inbox.setInboxViewOpen(true);
});
onBeforeUnmount(() => {
  inbox.setInboxViewOpen(false);
});
</script>

<template>
  <div class="inbox-view">
    <header class="inbox-view__head">
      <div class="inbox-view__head-left">
        <DsButton size="sm" variant="ghost" @click="close">
          {{ t('inbox.back') }}
        </DsButton>
        <strong class="inbox-view__title">{{ t('inbox.viewHeading') }}</strong>
      </div>
      <div class="inbox-view__pills">
        <button
          v-for="p in periods"
          :key="p.id"
          class="inbox-view__pill"
          :class="{ 'inbox-view__pill--active': activePeriod === p.id }"
          @click="selectPeriod(p.id)"
        >
          <span>{{ t(p.label) }}</span>
          <span class="inbox-view__pill-count">{{ counts[p.id] }}</span>
        </button>
      </div>
    </header>

    <div v-if="rows.length === 0" class="inbox-view__zero">
      <div class="inbox-view__zero-check">✓</div>
      <p class="inbox-view__zero-title">{{ t('inbox.zeroTitle') }}</p>
      <p class="inbox-view__zero-sub">{{ t('inbox.zeroSub') }}</p>
    </div>

    <div v-else class="inbox-view__list">
      <button
        v-for="entry in rows"
        :key="entry.path"
        class="inbox-view__row"
        @click="openRow(entry)"
      >
        <span class="inbox-view__row-main">
          <span class="inbox-view__row-title">{{ titleFor(entry) }}</span>
          <span class="inbox-view__row-sub">
            <span v-if="capturedLabel(entry)">{{ capturedLabel(entry) }}</span>
            <span v-if="capturedLabel(entry)" class="inbox-view__dot">·</span>
            <span>{{ t('inbox.linkCount', { n: String(inboxLinkCount(entry)) }) }}</span>
          </span>
        </span>
        <span v-if="rowChips(entry).length" class="inbox-view__row-chips">
          <DsChip
            v-for="c in rowChips(entry)"
            :key="c.label + c.value"
            size="sm"
          >{{ c.value }}</DsChip>
        </span>
      </button>
    </div>

    <footer class="inbox-view__foot">
      <span class="inbox-view__hint">{{ t('inbox.organizeHint') }}</span>
    </footer>
  </div>
</template>

<style scoped>
.inbox-view {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
  background: var(--bg);
  color: var(--text);
  overflow: hidden;
}
.inbox-view__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--sp-3);
  padding: var(--sp-2) var(--sp-3);
  border-bottom: var(--bd);
  background: var(--bg-elev);
  flex-wrap: wrap;
}
.inbox-view__head-left {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
}
.inbox-view__title {
  font-size: 13px;
  color: var(--text-muted);
  text-transform: uppercase;
  letter-spacing: 0.06em;
}
.inbox-view__pills {
  display: inline-flex;
  gap: var(--sp-1);
  padding: var(--sp-1);
  background: var(--bg);
  border: var(--bd);
  border-radius: var(--r-full);
}
.inbox-view__pill {
  display: inline-flex;
  align-items: center;
  gap: var(--sp-2);
  border: none;
  background: transparent;
  color: var(--text-muted);
  font-family: inherit;
  font-size: 12px;
  font-weight: 500;
  padding: var(--sp-1) var(--sp-3);
  border-radius: var(--r-full);
  cursor: pointer;
  transition: background var(--dur-fast) var(--ease), color var(--dur-fast) var(--ease);
}
.inbox-view__pill:hover {
  background: var(--bg-hover);
}
.inbox-view__pill--active {
  background: var(--accent);
  color: var(--accent-fg);
}
.inbox-view__pill-count {
  font-variant-numeric: tabular-nums;
  font-size: 11px;
  opacity: 0.85;
}
.inbox-view__list {
  flex: 1;
  overflow: auto;
  min-height: 0;
  padding: var(--sp-2);
  display: flex;
  flex-direction: column;
  gap: var(--sp-1);
}
.inbox-view__row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--sp-3);
  width: 100%;
  text-align: left;
  font-family: inherit;
  background: transparent;
  border: 1px solid transparent;
  border-radius: var(--r-md);
  padding: var(--sp-2) var(--sp-3);
  cursor: pointer;
  transition: background var(--dur-fast) var(--ease);
}
.inbox-view__row:hover {
  background: var(--bg-hover);
}
.inbox-view__row:focus-visible {
  outline: none;
  box-shadow: var(--ring);
}
.inbox-view__row-main {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
  flex: 1;
}
.inbox-view__row-title {
  color: var(--text);
  font-size: 14px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.inbox-view__row-sub {
  display: inline-flex;
  align-items: center;
  gap: var(--sp-1);
  color: var(--text-muted);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}
.inbox-view__dot {
  color: var(--text-faint);
}
.inbox-view__row-chips {
  display: inline-flex;
  gap: var(--sp-1);
  flex-shrink: 0;
}
.inbox-view__zero {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--sp-2);
  padding: var(--sp-6);
  text-align: center;
}
.inbox-view__zero-check {
  width: 48px;
  height: 48px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: var(--r-full);
  background: var(--accent-soft);
  color: var(--accent);
  font-size: 24px;
  font-weight: 700;
}
.inbox-view__zero-title {
  color: var(--text);
  font-size: 15px;
  font-weight: 600;
  margin: 0;
}
.inbox-view__zero-sub {
  color: var(--text-muted);
  font-size: 13px;
  margin: 0;
}
.inbox-view__foot {
  display: flex;
  align-items: center;
  padding: var(--sp-2) var(--sp-3);
  border-top: var(--bd);
  background: var(--bg-elev);
}
.inbox-view__hint {
  color: var(--text-faint);
  font-size: 11px;
}
</style>
