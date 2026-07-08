/**
 * Relative-date tokens for Saved Views (F5).
 *
 * Tolaria's view filters accept natural relative expressions like `today`,
 * `this week`, `@7d`. SoloMD's `bases.ts` date operators (`before` / `after`
 * / `on`) compare against an epoch — they don't know about relative phrasing.
 * Rather than touch the read-only `bases.ts`, we resolve a relative token to a
 * concrete value *before* the filter reaches the engine, so the on-disk YAML
 * keeps the human-readable token (`@this-week`) while evaluation sees a real
 * timestamp.
 *
 * Supported tokens (case-insensitive, leading `@` optional):
 *   - `today` / `now`           → start-of-today epoch ms
 *   - `yesterday`               → start-of-yesterday
 *   - `tomorrow`                → start-of-tomorrow
 *   - `this-week` / `this week` → start of the current week (Monday 00:00)
 *   - `this-month`              → first day of the current month, 00:00
 *   - `this-year`               → Jan 1 of the current year, 00:00
 *   - `Nd` / `Nw` / `Nmo` / `Ny` / `Nh` / `Nm`
 *                               → N units AGO from now (e.g. `7d` = 7 days ago)
 *
 * Pure, no DOM / Tauri. `now` is injectable so tests are deterministic.
 */

const DAY_MS = 24 * 3600 * 1000;

function startOfDay(d: Date): number {
  const c = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  return c.getTime();
}

/** True when a value is a relative-date token this module understands. */
export function isRelativeDateToken(v: unknown): boolean {
  if (typeof v !== 'string') return false;
  return resolveRelativeDate(v) != null;
}

/**
 * Resolve a relative-date token to an epoch-ms timestamp, or `null` when the
 * input isn't a recognized token. Non-token strings (e.g. a literal ISO date)
 * return null so the caller can fall back to passing the raw value through.
 */
export function resolveRelativeDate(v: unknown, now: Date = new Date()): number | null {
  if (typeof v !== 'string') return null;
  const tok = v.trim().toLowerCase().replace(/^@/, '').replace(/\s+/g, '-');
  if (!tok) return null;

  switch (tok) {
    case 'now':
    case 'today':
      return startOfDay(now);
    case 'yesterday':
      return startOfDay(new Date(now.getTime() - DAY_MS));
    case 'tomorrow':
      return startOfDay(new Date(now.getTime() + DAY_MS));
    case 'this-week': {
      // ISO week — Monday is day 1. getDay(): Sun=0..Sat=6.
      const dow = (now.getDay() + 6) % 7; // 0 = Monday
      const monday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - dow);
      return monday.getTime();
    }
    case 'this-month':
      return new Date(now.getFullYear(), now.getMonth(), 1).getTime();
    case 'this-year':
      return new Date(now.getFullYear(), 0, 1).getTime();
  }

  // `Nd` / `Nw` / `Nmo` / `Ny` / `Nh` / `Nm` → that many units ago.
  const m = tok.match(/^(\d+(?:\.\d+)?)-?(mo|[smhdwy])$/);
  if (m) {
    const n = Number(m[1]);
    if (!Number.isFinite(n)) return null;
    const unit = m[2];
    const SEC = 1000;
    const MIN = 60 * SEC;
    const HOUR = 60 * MIN;
    const span =
      unit === 's' ? n * SEC :
      unit === 'm' ? n * MIN :
      unit === 'h' ? n * HOUR :
      unit === 'd' ? n * DAY_MS :
      unit === 'w' ? n * 7 * DAY_MS :
      unit === 'mo' ? n * 30 * DAY_MS :
      unit === 'y' ? n * 365 * DAY_MS :
      null;
    if (span == null) return null;
    return now.getTime() - span;
  }

  return null;
}

/**
 * If `value` is a relative token, return its resolved epoch ms; otherwise
 * return the original value unchanged. Used by the saved-views store to
 * pre-resolve filter values before handing them to `bases.matchesGroup`.
 */
export function materializeFilterValue(value: unknown, now: Date = new Date()): unknown {
  const resolved = resolveRelativeDate(value, now);
  return resolved == null ? value : resolved;
}

/** The relative tokens offered in the filter-builder value dropdown. */
export const RELATIVE_DATE_PRESETS: { value: string; label: string }[] = [
  { value: '@today', label: 'Today' },
  { value: '@yesterday', label: 'Yesterday' },
  { value: '@this-week', label: 'This week' },
  { value: '@this-month', label: 'This month' },
  { value: '@this-year', label: 'This year' },
  { value: '@7d', label: '7 days ago' },
  { value: '@30d', label: '30 days ago' },
];
