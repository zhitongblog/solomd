/**
 * v4.6 F6 — pure inbox-workflow helpers.
 *
 * No DOM, no Tauri, no Pinia: everything here is a plain function over the
 * `IndexEntry` shape so it can be unit-tested directly (see
 * /tmp/tolaria/checks/inbox-*.mjs) and reused from `useInbox` / `InboxView`.
 *
 * Mirrors Tolaria's `noteListHelpers` inbox section, but keyed on SoloMD's
 * existing on-disk `inbox: true|false` front-matter flag (NOT Tolaria's
 * `_organized`). `inbox: true` = unorganized / still in the inbox; absent or
 * `inbox: false` = organized.
 */
import type { IndexEntry } from '../stores/workspaceIndex';

/** Period filter for the InboxView pills. */
export type InboxPeriod = 'week' | 'month' | 'all';

/**
 * Is this entry currently sitting in the inbox?
 *
 * Authoritative signal is the boolean front-matter flag — `inbox === true`.
 * The "no outgoing relationships" idea (Tolaria onboarding language) is only
 * an advisory hint surfaced in the row subtitle via {@link inboxLinkCount};
 * it never changes membership.
 */
export function isInboxCandidate(entry: IndexEntry): boolean {
  const fm = entry.frontmatter as Record<string, unknown> | null;
  return !!fm && fm.inbox === true;
}

/** Outgoing-relationship count for the advisory "needs organizing" hint. */
export function inboxLinkCount(entry: IndexEntry): number {
  return Array.isArray(entry.wikilinks) ? entry.wikilinks.length : 0;
}

/**
 * Best-effort "captured at" timestamp (ms epoch) for sorting / period
 * bucketing. Prefers a `created` / `date` front-matter key (parseable as a
 * date), then falls back to the file mtime so a note without an explicit
 * created date still sorts sensibly.
 */
export function inboxCapturedAt(entry: IndexEntry): number {
  const fm = entry.frontmatter as Record<string, unknown> | null;
  if (fm) {
    for (const key of ['created', 'date', 'createdAt']) {
      const raw = fm[key];
      if (raw == null) continue;
      const ms = typeof raw === 'number' ? raw : Date.parse(String(raw));
      if (Number.isFinite(ms)) return ms;
    }
  }
  return typeof entry.mtime === 'number' ? entry.mtime : 0;
}

/** Period cutoff in ms epoch. `all` → 0 (everything passes). */
export function periodCutoff(period: InboxPeriod, now = Date.now()): number {
  if (period === 'week') return now - 7 * 24 * 60 * 60 * 1000;
  if (period === 'month') return now - 30 * 24 * 60 * 60 * 1000;
  return 0;
}

/**
 * Inbox entries for a period, newest-captured first. `all` returns every
 * inbox entry; `week` / `month` clip to a rolling window on the captured-at
 * timestamp.
 */
export function filterInboxEntries(
  entries: IndexEntry[],
  period: InboxPeriod,
  now = Date.now(),
): IndexEntry[] {
  const cutoff = periodCutoff(period, now);
  return entries
    .filter(isInboxCandidate)
    .filter((e) => period === 'all' || inboxCapturedAt(e) >= cutoff)
    .sort((a, b) => inboxCapturedAt(b) - inboxCapturedAt(a));
}

/** Counts per period — drives the live numbers on the Week/Month/All pills. */
export function countInboxByPeriod(
  entries: IndexEntry[],
  now = Date.now(),
): Record<InboxPeriod, number> {
  const inbox = entries.filter(isInboxCandidate);
  const weekCut = periodCutoff('week', now);
  const monthCut = periodCutoff('month', now);
  let week = 0;
  let month = 0;
  for (const e of inbox) {
    const t = inboxCapturedAt(e);
    if (t >= weekCut) week += 1;
    if (t >= monthCut) month += 1;
  }
  return { week, month, all: inbox.length };
}

/**
 * The inbox entry that should become active after `path` is organized.
 *
 * Given the *current* visible inbox list (the one the user is looking at,
 * still containing `path`), returns the next entry after `path` — or the
 * previous one if `path` was last — or `null` when `path` was the only
 * remaining inbox note (⇒ inbox-zero). Copied semantics from Tolaria's
 * `nextVisibleEntryAfter`: snapshot BEFORE the organize write so the advance
 * target is stable.
 */
export function nextInboxEntryAfter(
  list: IndexEntry[],
  path: string,
): IndexEntry | null {
  const idx = list.findIndex((e) => e.path === path);
  if (idx < 0) {
    // `path` isn't in the list (already organized / filtered out): advance to
    // the first remaining inbox note if any.
    return list[0] ?? null;
  }
  if (list.length <= 1) return null; // it was the only one → inbox-zero
  // Prefer the next entry; wrap to the previous one when organizing the last.
  return list[idx + 1] ?? list[idx - 1] ?? null;
}
