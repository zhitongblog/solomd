<script setup lang="ts">
/**
 * v4.6 F6 — dedicated Inbox workflow view (production depth).
 *
 * Center-pane overlay (same App.vue swap convention as BasesView): replaces
 * TileRoot in `.content` while `inboxViewOpen` is true. Opened via the
 * `solomd:open-inbox` window CustomEvent (see useInboxView.ts).
 *
 * Surface:
 *   - sticky header: back button, heading, Week / Month / All period pills
 *     with live counts (driven off the workspace index ⇒ updates on
 *     `solomd://index-updated` for free).
 *   - a scrollable, keyboard-navigable list of inbox notes built from the
 *     design-system `DsListRow`: title, captured-date (relative + absolute),
 *     advisory link count, and up to two front-matter property chips.
 *   - the currently-open note is highlighted (selected) in the list.
 *   - two empty states: true inbox-zero (no inbox notes at all) vs a
 *     period-empty state (notes exist, just not in this window).
 *   - footer: a real "Mark organized & advance" DsButton mirroring ⌘E, plus
 *     the shortcut hint. Disabled when there's no active inbox note to organize.
 *
 * Pure presentation over the `useInbox` composable — no store edits beyond the
 * shared `setInboxViewOpen` flag. Design-system components + tokens only; no
 * raw hex.
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue';
import { shortcutLabel } from '../lib/keybindings';
import { usesCommandKey } from '../lib/platform';
import Icons from './Icons.vue';
import '../styles/panels.css';
import { useInbox, type InboxPeriod } from '../composables/useInbox';
import { useFiles } from '../composables/useFiles';
import { useTabsStore } from '../stores/tabs';
import { useSettingsStore } from '../stores/settings';
import { useWorkspaceIndexStore, type IndexEntry } from '../stores/workspaceIndex';
import { inboxCapturedAt, inboxLinkCount } from '../lib/inbox-filter';
import { inferColumns, getCellValue, type ColumnDef } from '../lib/bases';
import { useI18n } from '../i18n';
import { INBOX_CLOSE_EVENT } from '../composables/useInboxView';

const inbox = useInbox();
const files = useFiles();
const tabs = useTabsStore();
const settings = useSettingsStore();
const idx = useWorkspaceIndexStore();
const { t, lang } = useI18n();
// #180 — the chord in this sentence comes from the user's bindings.
const macChord = usesCommandKey();
const kbSettings = useSettingsStore();
function withChord(key: string, actionId: string): string {
  return t(key, { key: shortcutLabel(actionId, kbSettings.keybindings, macChord) || '—' });
}

// Local UI state — which period pill is selected, and the list container ref
// used for roving keyboard focus.
const activePeriod = ref<InboxPeriod>('all');
const listEl = ref<HTMLElement | null>(null);

const periods: { id: InboxPeriod; label: string }[] = [
  { id: 'week', label: 'inbox.periodWeek' },
  { id: 'month', label: 'inbox.periodMonth' },
  { id: 'all', label: 'inbox.periodAll' },
];

const rows = computed<IndexEntry[]>(() => inbox.inboxEntries(activePeriod.value));
const counts = inbox.countByPeriod;
/** Total inbox notes across all periods — distinguishes true inbox-zero from
 *  a merely period-empty list. */
const totalInbox = computed(() => counts.value.all);

/** Path of the note currently open in the editor — highlighted in the list. */
const activePath = computed(() => tabs.activeTab?.filePath ?? null);
/** Whether ⌘E / the footer button can organize-and-advance right now. */
const canOrganize = computed(() => inbox.activeIsInbox.value);

/** Up to two front-matter property chips per row (excluding the inbox flag
 *  itself), reusing the bases column inference so we surface whatever the
 *  vault actually uses (status, type, tags…). */
const chipColumns = computed<ColumnDef[]>(() =>
  inferColumns(idx.entries)
    .filter((c) => c.source === 'frontmatter' && c.fmKey !== 'inbox')
    .slice(0, 2),
);

function rowChips(entry: IndexEntry): { key: string; label: string; value: string }[] {
  const out: { key: string; label: string; value: string }[] = [];
  for (const col of chipColumns.value) {
    const v = getCellValue(entry, col);
    if (v == null || v === '') continue;
    const value = Array.isArray(v) ? v.join(', ') : String(v);
    if (!value) continue;
    out.push({ key: col.fmKey ?? col.id, label: col.label, value });
  }
  return out;
}

function titleFor(entry: IndexEntry): string {
  return entry.title || entry.stem || entry.name;
}

/** Absolute captured date (localized), e.g. "Jun 10, 2026". */
function capturedAbsolute(entry: IndexEntry): string {
  const ms = inboxCapturedAt(entry);
  if (!ms) return '';
  try {
    return new Date(ms).toLocaleDateString(lang.value, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
  } catch {
    return '';
  }
}

/** Relative captured label ("today", "2 days ago"…) for at-a-glance recency,
 *  localized via Intl.RelativeTimeFormat with a graceful fallback. */
function capturedRelative(entry: IndexEntry): string {
  const ms = inboxCapturedAt(entry);
  if (!ms) return '';
  const diff = ms - Date.now();
  const absDays = Math.round(Math.abs(diff) / 86_400_000);
  try {
    const rtf = new Intl.RelativeTimeFormat(lang.value, { numeric: 'auto' });
    if (absDays < 1) {
      const hours = Math.round(diff / 3_600_000);
      if (Math.abs(hours) < 1) return rtf.format(0, 'day');
      return rtf.format(hours, 'hour');
    }
    if (absDays < 30) return rtf.format(Math.round(diff / 86_400_000), 'day');
    if (absDays < 365) return rtf.format(Math.round(diff / (86_400_000 * 30)), 'month');
    return rtf.format(Math.round(diff / (86_400_000 * 365)), 'year');
  } catch {
    return capturedAbsolute(entry);
  }
}

function selectPeriod(p: InboxPeriod) {
  activePeriod.value = p;
}

async function openRow(entry: IndexEntry) {
  await files.openPath(entry.path, { bypassNewWindow: true });
}

/** Footer button: same organize-and-advance the ⌘E shortcut runs. */
function organize() {
  if (settings.inboxWorkflowEnabled) void inbox.organizeAndAdvance();
  else inbox.toggleActive();
}

function close() {
  window.dispatchEvent(new CustomEvent(INBOX_CLOSE_EVENT));
}

// ---- keyboard navigation within the list (↑ / ↓ / Home / End) -------------
function focusRow(i: number) {
  const clamped = Math.max(0, Math.min(i, rows.value.length - 1));
  nextTick(() => {
    listEl.value
      ?.querySelectorAll<HTMLElement>('[data-inbox-row]')
      ?.[clamped]?.focus();
  });
}

function onListKeydown(e: KeyboardEvent) {
  if (rows.value.length === 0) return;
  const els = Array.from(
    listEl.value?.querySelectorAll<HTMLElement>('[data-inbox-row]') ?? [],
  );
  const cur = els.findIndex((el) => el === document.activeElement);
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    focusRow(cur < 0 ? 0 : cur + 1);
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    focusRow(cur < 0 ? 0 : cur - 1);
  } else if (e.key === 'Home') {
    e.preventDefault();
    focusRow(0);
  } else if (e.key === 'End') {
    e.preventDefault();
    focusRow(rows.value.length - 1);
  }
}

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape') {
    e.preventDefault();
    close();
  }
}

onMounted(() => {
  inbox.setInboxViewOpen(true);
  window.addEventListener('keydown', onKeydown);
});
onBeforeUnmount(() => {
  inbox.setInboxViewOpen(false);
  window.removeEventListener('keydown', onKeydown);
});
</script>

<template>
  <div class="inbox-view pg">
    <header class="inbox-view__head pg-head">
      <button
        class="pg-icon-btn inbox-view__back"
        type="button"
        :title="t('inbox.back')"
        :aria-label="t('inbox.back')"
        @click="close"
      >
        <Icons name="chevron-left" :size="18" />
      </button>
      <h1 class="inbox-view__title pg-title">{{ t('inbox.viewHeading') }}</h1>
      <span class="pg-subtitle inbox-view__total">{{ totalInbox }}</span>
      <span class="pg-spacer" />
      <div
        class="inbox-view__pills rp-seg"
        role="tablist"
        :aria-label="t('inbox.viewHeading')"
        :style="{ '--seg-n': periods.length, '--seg-i': Math.max(0, periods.findIndex((p) => p.id === activePeriod)) }"
      >
        <span class="rp-seg__thumb" aria-hidden="true" />
        <button
          v-for="p in periods"
          :key="p.id"
          class="inbox-view__pill rp-seg__opt"
          :class="{ 'inbox-view__pill--active is-on': activePeriod === p.id }"
          type="button"
          role="tab"
          :aria-selected="activePeriod === p.id"
          @click="selectPeriod(p.id)"
        >
          <span>{{ t(p.label) }}</span>
          <span class="inbox-view__pill-count">{{ counts[p.id] }}</span>
        </button>
      </div>
    </header>

    <!-- True inbox-zero: nothing flagged inbox anywhere. -->
    <div v-if="totalInbox === 0" class="inbox-view__zero">
      <span class="inbox-view__zero-check" aria-hidden="true">
        <Icons name="check-circle" :size="28" />
      </span>
      <p class="inbox-view__zero-title">{{ t('inbox.zeroTitle') }}</p>
      <p class="inbox-view__zero-sub">{{ t('inbox.zeroSub') }}</p>
    </div>

    <!-- Period-empty: inbox notes exist, just none in this window. -->
    <div v-else-if="rows.length === 0" class="inbox-view__zero">
      <span class="inbox-view__zero-check" aria-hidden="true">
        <Icons name="inbox" :size="28" />
      </span>
      <p class="inbox-view__zero-title">{{ t('inbox.periodEmptyTitle') }}</p>
      <p class="inbox-view__zero-sub">
        {{ t('inbox.periodEmptySub', { n: String(totalInbox) }) }}
      </p>
      <button class="rp-btn inbox-view__show-all" type="button" @click="selectPeriod('all')">
        {{ t('inbox.showAll') }}
      </button>
    </div>

    <div
      v-else
      ref="listEl"
      class="inbox-view__list pg-body"
      role="list"
      @keydown="onListKeydown"
    >
      <button
        v-for="entry in rows"
        :key="entry.path"
        type="button"
        role="listitem"
        data-inbox-row
        class="inbox-view__row"
        :class="{ 'is-active': entry.path === activePath }"
        :aria-selected="entry.path === activePath || undefined"
        @click="openRow(entry)"
      >
        <span class="inbox-view__row-main">
          <span class="inbox-view__row-title">{{ titleFor(entry) }}</span>
          <span class="inbox-view__row-sub">
            <span
              v-if="capturedRelative(entry)"
              class="inbox-view__captured"
              :title="capturedAbsolute(entry)"
            >{{ capturedRelative(entry) }}</span>
            <span v-if="capturedRelative(entry)" class="inbox-view__dot">·</span>
            <span>{{ t('inbox.linkCount', { n: String(inboxLinkCount(entry)) }) }}</span>
          </span>
        </span>
        <span v-if="rowChips(entry).length" class="inbox-view__row-chips">
          <span
            v-for="c in rowChips(entry)"
            :key="c.key + c.value"
            class="rp-chip"
            :title="c.label + ': ' + c.value"
          >{{ c.value }}</span>
        </span>
      </button>
    </div>

    <footer class="inbox-view__foot">
      <button
        class="rp-btn rp-btn--primary"
        type="button"
        :disabled="!canOrganize"
        @click="organize"
      >
        <Icons name="check-circle" :size="14" />
        {{ t('inbox.organizeAction') }}
      </button>
      <span class="inbox-view__hint">{{ withChord('inbox.organizeHint', 'inbox.toggle') }}</span>
    </footer>
  </div>
</template>

<style scoped>
.inbox-view {
  flex: 1;
}
.inbox-view__head {
  padding-left: 16px;
  gap: 8px;
}
.inbox-view__total {
  padding-top: 4px;
}
.inbox-view__pills {
  min-width: 260px;
}
.inbox-view__pill-count {
  font-variant-numeric: tabular-nums;
  font-size: 11px;
  color: var(--text-3);
}
.inbox-view__list {
  display: flex;
  flex-direction: column;
  gap: 0;
  padding-top: 4px;
  padding-left: 16px;
  padding-right: 16px;
}
.inbox-view__row {
  position: relative;
  display: flex;
  align-items: center;
  gap: 12px;
  width: 100%;
  min-height: 52px;
  padding: 8px 12px;
  box-sizing: border-box;
  border: 0;
  border-radius: var(--r-md);
  background: transparent;
  color: var(--text);
  font: inherit;
  text-align: left;
  cursor: pointer;
  transition: background var(--dur-fast) var(--ease);
}
/* Hairline separators between rows, inset to the text. */
.inbox-view__row + .inbox-view__row::before {
  content: '';
  position: absolute;
  top: 0;
  left: 12px;
  right: 12px;
  border-top: var(--bd-hair);
}
.inbox-view__row:hover,
.inbox-view__row:hover + .inbox-view__row::before,
.inbox-view__row.is-active + .inbox-view__row::before,
.inbox-view__row.is-active::before,
.inbox-view__row:hover::before {
  border-color: transparent;
}
.inbox-view__row:hover {
  background: var(--fill-1);
}
.inbox-view__row.is-active {
  background: var(--accent-soft);
}
.inbox-view__row.is-active .inbox-view__row-title {
  color: var(--accent-text);
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
  font-size: 13px;
  font-weight: 500;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.inbox-view__row-sub {
  display: inline-flex;
  align-items: center;
  gap: var(--sp-1);
  color: var(--text-3);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}
.inbox-view__captured {
  cursor: default;
}
.inbox-view__row-chips {
  display: inline-flex;
  gap: var(--sp-1);
  flex-shrink: 0;
}
.inbox-view__row-chips .rp-chip {
  cursor: default;
}
.inbox-view__zero {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: var(--sp-6);
  text-align: center;
}
.inbox-view__zero-check {
  display: inline-flex;
  color: var(--text-3);
  margin-bottom: 4px;
}
.inbox-view__zero-title {
  color: var(--text-2);
  font-size: 15px;
  font-weight: 600;
  margin: 0;
}
.inbox-view__zero-sub {
  color: var(--text-3);
  font-size: 13px;
  margin: 0;
}
.inbox-view__show-all {
  margin-top: 8px;
}
.inbox-view__foot {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: var(--sp-3);
  padding: 10px 24px;
  border-top: var(--bd-hair);
}
.inbox-view__hint {
  color: var(--text-3);
  font-size: 12px;
}
</style>
