/**
 * v2.5 — edit-frequency store for the ⌘P quick file switcher.
 *
 * Tracks how many times the user has saved each file. Combined with
 * `useWorkspaceStore().recentFiles` (which is recency-ordered, MRU 12),
 * this gives the switcher an MFU signal so frequently-touched docs
 * float near the top even when they fall off the small recents list.
 *
 * Persistence:
 *   localStorage['solomd.recentEdits.v1'] = { "<absolute path>": <count> }
 *
 * Capacity: hard-capped at 1000 entries (LRU). When exceeded we drop the
 * lowest-count entries first; ties broken by lexicographic path so the
 * eviction is deterministic / test-friendly.
 *
 * Scoring (used by topN):
 *   - Empty query → return up to N paths in MRU∪MFU order. The given
 *     `recentPaths` argument (caller passes workspace.recentFiles) is the
 *     MRU spine; we then append the highest-frequency paths not already
 *     present, until we hit N.
 *   - Non-empty query → fuzzy-rank everything we know about (open tabs +
 *     recents + all tracked frequency entries) using the scorer in
 *     `scorePath`, then take top N.
 */
import { defineStore } from 'pinia';

const LS_KEY = 'solomd.recentEdits.v1';
const LRU_CAP = 1000;

interface RecentEditsState {
  /** Absolute path → save count. */
  counts: Record<string, number>;
}

function load(): RecentEditsState {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') {
        const counts: Record<string, number> = {};
        for (const [k, v] of Object.entries(parsed)) {
          if (typeof v === 'number' && Number.isFinite(v) && v > 0) counts[k] = v;
        }
        return { counts };
      }
    }
  } catch {}
  return { counts: {} };
}

/**
 * Custom 50-line fuzzy scorer.
 *
 *   - basename match beats path match
 *   - prefix beats inner match
 *   - contiguous run beats scattered chars
 *   - both case-insensitive; result is `null` when any query char is
 *     missing from the candidate.
 *
 * Returns higher = better, or `null` for "doesn't match at all".
 */
export function scorePath(query: string, path: string): number | null {
  if (!query) return 0;
  const q = query.toLowerCase();
  const p = path.toLowerCase();
  const slash = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  const base = slash >= 0 ? p.slice(slash + 1) : p;
  // 1) Subsequence check across the full path. Fail fast if any char missing.
  let pi = 0;
  for (const ch of q) {
    const found = p.indexOf(ch, pi);
    if (found < 0) return null;
    pi = found + 1;
  }
  let score = 0;
  // 2) Base-name contiguous-substring bonus (largest single signal).
  const baseHit = base.indexOf(q);
  if (baseHit === 0) score += 1000; // basename prefix
  else if (baseHit > 0) score += 600; // basename inner contiguous
  // 3) Path contiguous-substring bonus (smaller).
  const pathHit = p.indexOf(q);
  if (pathHit >= 0) score += 200;
  // 4) Reward consecutive matches of subsequence chars in the basename.
  let bi = 0;
  let run = 0;
  let bestRun = 0;
  for (const ch of q) {
    const found = base.indexOf(ch, bi);
    if (found < 0) {
      run = 0;
      continue;
    }
    if (found === bi) run += 1;
    else run = 1;
    if (run > bestRun) bestRun = run;
    bi = found + 1;
  }
  score += bestRun * 50;
  // 5) Penalize long paths so shorter / shallower hits win ties.
  score -= Math.min(p.length, 200) * 0.5;
  // 6) Tiny bonus when the basename itself starts with the first query char.
  if (base.startsWith(q[0])) score += 10;
  return score;
}

export const useRecentEditsStore = defineStore('recentEdits', {
  state: (): RecentEditsState => load(),
  actions: {
    persist() {
      try {
        localStorage.setItem(LS_KEY, JSON.stringify(this.counts));
      } catch {}
    },
    /** Increment count for `path`. Called from useFiles.saveActive on save. */
    recordEdit(path: string) {
      if (!path) return;
      this.counts[path] = (this.counts[path] || 0) + 1;
      this.evictIfNeeded();
      this.persist();
    },
    /** Drop the path entirely (e.g. when a file is deleted/renamed). */
    forget(path: string) {
      if (path in this.counts) {
        delete this.counts[path];
        this.persist();
      }
    },
    evictIfNeeded() {
      const keys = Object.keys(this.counts);
      if (keys.length <= LRU_CAP) return;
      // Lowest count first, ties broken lexicographically (deterministic).
      keys.sort((a, b) => {
        const ca = this.counts[a];
        const cb = this.counts[b];
        if (ca !== cb) return ca - cb;
        return a < b ? -1 : a > b ? 1 : 0;
      });
      const drop = keys.length - LRU_CAP;
      for (let i = 0; i < drop; i++) delete this.counts[keys[i]];
    },
    /**
     * Return up to `n` candidate paths.
     *   - `query` empty → MRU spine then MFU tail.
     *   - `query` non-empty → fuzzy-ranked across the union of all known
     *     paths (recents + extra + tracked frequency keys).
     *
     * `recentPaths` should be `useWorkspaceStore().recentFiles` (MRU first).
     * `extra` lets the caller seed currently-open tabs that may not yet
     * be in either list (e.g. a freshly-opened file before its first save).
     */
    topN(
      n: number,
      query: string,
      recentPaths: string[] = [],
      extra: string[] = [],
    ): string[] {
      const q = query.trim();
      if (!q) {
        const seen = new Set<string>();
        const out: string[] = [];
        for (const p of recentPaths) {
          if (p && !seen.has(p)) {
            seen.add(p);
            out.push(p);
            if (out.length >= n) return out;
          }
        }
        const byFreq = Object.entries(this.counts).sort(
          (a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1),
        );
        for (const [p] of byFreq) {
          if (!seen.has(p)) {
            seen.add(p);
            out.push(p);
            if (out.length >= n) return out;
          }
        }
        for (const p of extra) {
          if (p && !seen.has(p)) {
            seen.add(p);
            out.push(p);
            if (out.length >= n) return out;
          }
        }
        return out;
      }
      // Fuzzy mode: rank the union.
      const universe = new Set<string>();
      for (const p of recentPaths) if (p) universe.add(p);
      for (const p of Object.keys(this.counts)) universe.add(p);
      for (const p of extra) if (p) universe.add(p);
      const ranked: Array<{ path: string; score: number }> = [];
      for (const path of universe) {
        const s = scorePath(q, path);
        if (s !== null) {
          // Mild boost from edit frequency (log so noisy files don't dominate).
          const freq = this.counts[path] || 0;
          ranked.push({ path, score: s + Math.log2(1 + freq) * 8 });
        }
      }
      ranked.sort((a, b) => b.score - a.score);
      return ranked.slice(0, n).map((r) => r.path);
    },
  },
});
