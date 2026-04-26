/**
 * v2.5 — writing-session bookkeeping for the WritingGoals pill / popover.
 *
 * Tracks two horizons per file:
 *
 *   - "since opened" — the count we observed when the doc was first opened
 *     in this session. Resets when the tab is closed and reopened (we key
 *     by file path; close+reopen rebuilds the entry on next observation).
 *   - "since saved" — derived from the live tab's content vs. savedContent,
 *     computed on the fly in the composable; we just persist the timestamp
 *     of the last save so the popover can show "since save (12s ago)".
 *
 * Daily totals are kept in the same store so the WritingGoals popover and
 * the optional status-bar "Today: …" segment share one source of truth.
 *
 * Persisted to `localStorage['solomd.writingSession.v1']`.
 */
import { defineStore } from 'pinia';

const LS_KEY = 'solomd.writingSession.v1';

export interface SessionEntry {
  /** ISO-ish timestamp of the first observation in this open. */
  firstOpenedAt: string;
  /** Count at the moment we first saw the doc — anchor for delta-since-open. */
  openCount: number;
  /** Most recent observed count. Lets us survive a reload mid-edit. */
  current: number;
  /** Last save timestamp (set when caller calls `markSaved`). */
  lastSavedAt: string | null;
  /** Count at last save — anchor for delta-since-save. */
  lastSavedCount: number;
  /** YYYY-MM-DD on which `firstOpenedAt` falls. Drives daily-rollover reset. */
  day: string;
}

export interface DailyTotalEntry {
  /** YYYY-MM-DD. */
  day: string;
  /** Sum of positive deltas (current - openCount) across docs touched today. */
  totalNewWords: number;
  /** Set of paths that contributed to the total (for the "across N docs" copy). */
  paths: string[];
}

interface State {
  sessions: Record<string, SessionEntry>;
  daily: DailyTotalEntry;
}

function todayISO(d: Date = new Date()): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function load(): State {
  const today = todayISO();
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as State;
      // Day rollover — discard yesterday's snapshot of "today total".
      if (parsed.daily?.day !== today) {
        parsed.daily = { day: today, totalNewWords: 0, paths: [] };
      }
      // Drop session entries whose `day` doesn't match today — they're stale
      // anchors that would otherwise count yesterday's progress as today's.
      if (parsed.sessions) {
        for (const k of Object.keys(parsed.sessions)) {
          if (parsed.sessions[k].day !== today) {
            delete parsed.sessions[k];
          }
        }
      } else {
        parsed.sessions = {};
      }
      return parsed;
    }
  } catch {}
  return {
    sessions: {},
    daily: { day: today, totalNewWords: 0, paths: [] },
  };
}

export const useWritingSessionStore = defineStore('writingSession', {
  state: (): State => load(),
  getters: {
    /** Number of distinct paths that contributed to today's total. */
    todayDocCount(state): number {
      return state.daily.paths.length;
    },
    todayTotal(state): number {
      return state.daily.totalNewWords;
    },
    /**
     * Streak count (in days) of consecutive days that have docs with
     * `goal_set_at` covering them. We approximate from the goal_set_at
     * dates passed in — the popover supplies them.
     */
    sessionForPath(): (path: string) => SessionEntry | undefined {
      return (path: string) => this.sessions[path];
    },
  },
  actions: {
    persist() {
      try {
        localStorage.setItem(LS_KEY, JSON.stringify(this.$state));
      } catch {}
    },
    /**
     * Day-rollover poll — call this every ~30 s. If the calendar day has
     * changed since the daily snapshot was taken, reset everything.
     */
    rolloverIfNewDay() {
      const today = todayISO();
      if (this.daily.day !== today) {
        this.daily = { day: today, totalNewWords: 0, paths: [] };
        // Stale anchors carry over an old day's open count — reset them too.
        this.sessions = {};
        this.persist();
      }
    },
    /**
     * Idempotent observation — call this whenever we see the live count for
     * `path`. Creates the session entry on first sight; updates `current`
     * and recomputes today-total deltas thereafter.
     */
    observe(path: string, count: number) {
      if (!path) return;
      const today = todayISO();
      if (this.daily.day !== today) {
        this.rolloverIfNewDay();
      }
      let entry = this.sessions[path];
      if (!entry || entry.day !== today) {
        entry = {
          firstOpenedAt: new Date().toISOString(),
          openCount: count,
          current: count,
          lastSavedAt: null,
          lastSavedCount: count,
          day: today,
        };
        this.sessions[path] = entry;
        if (!this.daily.paths.includes(path)) {
          this.daily.paths.push(path);
        }
        this.persist();
        return;
      }

      // Update the rolling delta in `daily.totalNewWords` based on the *new*
      // delta vs the previously-counted delta for this path.
      const prevDelta = Math.max(0, entry.current - entry.openCount);
      entry.current = count;
      const newDelta = Math.max(0, entry.current - entry.openCount);
      this.daily.totalNewWords += newDelta - prevDelta;
      if (this.daily.totalNewWords < 0) this.daily.totalNewWords = 0;

      if (!this.daily.paths.includes(path)) {
        this.daily.paths.push(path);
      }
      this.persist();
    },
    /** Stamp last-save anchor when the doc is saved. */
    markSaved(path: string, count: number) {
      const entry = this.sessions[path];
      if (!entry) return;
      entry.lastSavedAt = new Date().toISOString();
      entry.lastSavedCount = count;
      this.persist();
    },
    /**
     * "Reset session counter" button on the popover — moves the anchor up
     * to the current value so the next delta starts from zero.
     */
    resetSession(path: string, currentCount: number) {
      const entry = this.sessions[path];
      const today = todayISO();
      if (!entry) {
        this.sessions[path] = {
          firstOpenedAt: new Date().toISOString(),
          openCount: currentCount,
          current: currentCount,
          lastSavedAt: null,
          lastSavedCount: currentCount,
          day: today,
        };
      } else {
        // Subtract the prior contribution from today-total before zeroing it.
        const prevDelta = Math.max(0, entry.current - entry.openCount);
        this.daily.totalNewWords = Math.max(0, this.daily.totalNewWords - prevDelta);
        entry.openCount = currentCount;
        entry.current = currentCount;
        entry.firstOpenedAt = new Date().toISOString();
      }
      this.persist();
    },
    /**
     * Clean up the session entry when a tab is closed. The next open of
     * the same doc will start a fresh entry. We keep the daily-total path
     * list intact — the user did contribute today.
     */
    closePath(path: string) {
      if (!path) return;
      delete this.sessions[path];
      this.persist();
    },
  },
});

/**
 * Compute a streak (consecutive-days-with-a-goal) ending today, given a
 * set of `goal_set_at` dates pulled from the workspace's current docs.
 *
 * If today's doc has `goal_set_at: 2026-04-20`, that's a 7-day streak
 * (assuming today is 2026-04-26). We don't try to verify the user actually
 * wrote on each intermediate day — `goal_set_at` is the user's stated start
 * date and the streak is purely "how many days you've had this goal."
 */
export function computeStreakDays(goalSetAt: string | null, today: Date = new Date()): number {
  if (!goalSetAt) return 0;
  const m = goalSetAt.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return 0;
  const setDate = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  if (Number.isNaN(setDate.getTime())) return 0;
  const todayMid = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const diff = Math.floor((todayMid.getTime() - setDate.getTime()) / 86400000);
  if (diff < 0) return 0;
  return diff + 1;
}
