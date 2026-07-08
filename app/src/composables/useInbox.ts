/**
 * v2.4 inbox workflow.
 *
 * Three pieces, one composable:
 *   1. Toggle the `inbox: true|false` boolean in the active doc's YAML
 *      front matter. Bound to ⌘E in `useShortcuts.ts`.
 *   2. Reactive count of `inbox: true` notes in the current workspace,
 *      derived from the existing workspace_index store (which already
 *      parses front matter).
 *   3. The "filter to inbox" toggle that the file tree consults.
 */
import { computed, ref } from 'vue';
import { useTabsStore } from '../stores/tabs';
import { useWorkspaceIndexStore, type IndexEntry } from '../stores/workspaceIndex';
import { useToastsStore } from '../stores/toasts';
import { useSettingsStore } from '../stores/settings';
import { useFiles } from './useFiles';
import { useI18n } from '../i18n';
import {
  countInboxByPeriod,
  filterInboxEntries,
  nextInboxEntryAfter,
  type InboxPeriod,
} from '../lib/inbox-filter';

export type { InboxPeriod } from '../lib/inbox-filter';

/**
 * Read the `inbox` flag from a markdown body's YAML front matter.
 * Returns `null` if there's no front matter at all, `true|false` if there
 * is and the key is set, `false` if the key is absent (the v2.4 default).
 */
export function readInboxFlag(body: string): boolean | null {
  const fm = extractFrontMatter(body);
  if (fm === null) return null;
  for (const line of fm.split('\n')) {
    const m = line.match(/^\s*inbox\s*:\s*(true|false)\s*$/i);
    if (m) return m[1].toLowerCase() === 'true';
  }
  return false;
}

/**
 * Toggle (or set) the `inbox` flag in a markdown body. Returns the
 * rewritten body. If there's no front matter, we synthesize one with
 * just the `inbox` key.
 *
 * Idempotent: setInboxFlag(body, true) twice yields the same string the
 * second time around — important for the watcher that auto-saves.
 */
export function setInboxFlag(body: string, value: boolean): string {
  const bom = body.startsWith('﻿') ? '﻿' : '';
  const rest = bom ? body.slice(1) : body;
  const fm = extractFrontMatter(rest);
  if (fm === null) {
    // No front matter — synthesize a minimal one. Newline before the body
    // unless the file was empty.
    const sep = rest.length === 0 ? '' : (rest.startsWith('\n') ? '' : '\n');
    return `${bom}---\ninbox: ${value}\n---\n${sep}${rest}`;
  }

  const lines = fm.split('\n');
  let touched = false;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(\s*)inbox\s*:\s*(true|false)\s*$/i);
    if (m) {
      lines[i] = `${m[1]}inbox: ${value}`;
      touched = true;
      break;
    }
  }
  if (!touched) {
    lines.push(`inbox: ${value}`);
  }
  // Rebuild the doc — keep everything outside the front-matter range untouched.
  const newFm = lines.join('\n').replace(/\s+$/, '');
  return `${bom}---\n${newFm}\n---\n${rest.slice(fmEndIndex(rest))}`;
}

/**
 * Return the YAML front-matter body (between the leading `---` and the
 * matching `\n---`) or `null` if the doc doesn't open with front matter.
 */
function extractFrontMatter(body: string): string | null {
  const trimmed = body.startsWith('﻿') ? body.slice(1) : body;
  if (!trimmed.startsWith('---')) return null;
  const nl = trimmed.indexOf('\n');
  if (nl < 0) return null;
  const after = trimmed.slice(nl + 1);
  const end = after.indexOf('\n---');
  if (end < 0) return null;
  return after.slice(0, end);
}

/** Byte offset (in `body` minus optional BOM) just past the closing `---\n`. */
function fmEndIndex(body: string): number {
  if (!body.startsWith('---')) return 0;
  const nl = body.indexOf('\n');
  if (nl < 0) return 0;
  const after = body.slice(nl + 1);
  const end = after.indexOf('\n---');
  if (end < 0) return 0;
  // skip past `\n---` and the trailing `\n` if any
  let cursor = nl + 1 + end + '\n---'.length;
  if (body[cursor] === '\n') cursor += 1;
  return cursor;
}

// ---------------------------------------------------------------------------
// Reactive piece — used by FileTree (badge), App (cmd+E), StatusBar (pill).
// ---------------------------------------------------------------------------

const filterMode = ref(false);
/** v4.6 F6 — shared across composable instances: true while the dedicated
 *  InboxView is mounted. Module-level so InboxView (which sets it) and
 *  useShortcuts (which reads it for ⌘E gating) see the same value. */
const inboxViewOpen = ref(false);

export function useInbox() {
  const tabs = useTabsStore();
  const index = useWorkspaceIndexStore();
  const toasts = useToastsStore();
  const settings = useSettingsStore();
  const files = useFiles();
  const { t } = useI18n();

  const activeIsInbox = computed(() => {
    const tab = tabs.activeTab;
    if (!tab) return false;
    return readInboxFlag(tab.content) === true;
  });

  /**
   * Number of `.md` files in the current workspace whose front matter has
   * `inbox: true`. Reactive — backed by the workspace_index store, which
   * the Rust-side watcher refreshes on every file change.
   */
  const inboxCount = computed(() => {
    let n = 0;
    for (const e of index.entries) {
      const fm = e.frontmatter as Record<string, unknown> | null;
      if (fm && fm.inbox === true) n += 1;
    }
    return n;
  });

  /**
   * List of paths for inbox docs — used by the file tree filter.
   */
  const inboxPaths = computed(() => {
    const out = new Set<string>();
    for (const e of index.entries) {
      const fm = e.frontmatter as Record<string, unknown> | null;
      if (fm && fm.inbox === true) out.add(e.path);
    }
    return out;
  });

  /**
   * Toggle ⌘E. Updates the active tab's content via the tabs store; the
   * Editor's `watch(() => props.tab.content)` propagates the edit into
   * the live CodeMirror state.
   */
  function toggleActive() {
    const tab = tabs.activeTab;
    if (!tab) {
      toasts.info(t('toast.noActiveDoc'));
      return;
    }
    const cur = readInboxFlag(tab.content) === true;
    const next = setInboxFlag(tab.content, !cur);
    tabs.setContent(tab.id, next);
    toasts.success(
      !cur ? t('inbox.markedInbox') : t('inbox.unmarkedInbox'),
    );
  }

  function setFilter(on: boolean) {
    filterMode.value = on;
  }
  function toggleFilter() {
    filterMode.value = !filterMode.value;
  }

  // -------------------------------------------------------------------------
  // v4.6 F6 — period-aware listing + organize-and-advance.
  // -------------------------------------------------------------------------

  /** Inbox entries for the InboxView, newest-captured first, clipped to the
   *  given period. Pure delegation to lib/inbox-filter so it's unit-testable. */
  function inboxEntries(period: InboxPeriod): IndexEntry[] {
    return filterInboxEntries(index.entries, period);
  }

  /** Live { week, month, all } counts for the InboxView period pills. */
  const countByPeriod = computed(() => countInboxByPeriod(index.entries));

  /**
   * Is the inbox workflow currently the user's active context? True when the
   * dedicated InboxView is open OR the file-tree inbox filter is on. ⌘E only
   * auto-advances inside this context; everywhere else it stays a plain
   * toggle so existing v2.4 muscle memory is preserved.
   */
  function setInboxViewOpen(v: boolean) {
    inboxViewOpen.value = v;
  }
  const inboxContextActive = computed(
    () => inboxViewOpen.value || filterMode.value,
  );

  /**
   * ⌘E handler. Marks the active note organized (`inbox: false`) and, when
   * `autoAdvanceInboxAfterOrganize` is on and the inbox context is active,
   * snapshots the next inbox entry BEFORE the write and opens it afterwards.
   * Marking the last note ⇒ nothing to advance to ⇒ inbox-zero.
   *
   * Outside the inbox context (or with auto-advance off) it degrades to the
   * plain ⌘E toggle, so capture (mark unorganized) still works from anywhere.
   */
  async function organizeAndAdvance() {
    const tab = tabs.activeTab;
    if (!tab) {
      toasts.info(t('toast.noActiveDoc'));
      return;
    }

    const wasInbox = readInboxFlag(tab.content) === true;
    const advancing =
      wasInbox &&
      settings.autoAdvanceInboxAfterOrganize &&
      inboxContextActive.value;

    // Snapshot the advance target from the CURRENT visible list (still
    // containing this note) before we flip the flag — matches Tolaria's
    // capture-before-write ordering so the index round-trip can't move the
    // target out from under us.
    const targetPath = advancing
      ? nextInboxEntryAfter(inboxEntries('all'), tab.filePath ?? '')?.path ?? null
      : null;
    const fromPath = tab.filePath;

    // Optimistic local flip drives the UI immediately (don't wait for the
    // index round-trip); the autosave path persists `inbox: false` to disk.
    const next = setInboxFlag(tab.content, !wasInbox);
    tabs.setContent(tab.id, next);
    toasts.success(
      !wasInbox ? t('inbox.markedInbox') : t('inbox.unmarkedInbox'),
    );

    if (!advancing) return;

    // Guard against the user navigating away mid-write (Tolaria's
    // isStillFocusedOnPath): only advance if focus is still on the note we
    // just organized.
    if (tabs.activeTab?.filePath !== fromPath) return;

    if (targetPath) {
      await files.openPath(targetPath, { bypassNewWindow: true });
    } else {
      // Inbox-zero: nothing left to advance to.
      toasts.success(t('inbox.zero'));
    }
  }

  return {
    activeIsInbox,
    inboxCount,
    inboxPaths,
    toggleActive,
    organizeAndAdvance,
    inboxEntries,
    countByPeriod,
    inboxContextActive,
    setInboxViewOpen,
    filterMode: computed(() => filterMode.value),
    setFilter,
    toggleFilter,
  };
}
