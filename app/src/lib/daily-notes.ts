/**
 * Pure helpers for the F3 Daily Notes feature.
 *
 * No Vue, no Tauri, no I/O — just date/string formatting so this module is
 * trivially unit-testable and reusable from settings UI / command palette /
 * editor. The composable `useDailyNotes` wires these into the file system.
 *
 * Filename format tokens (Moment-ish, kept tiny on purpose):
 *   YYYY  → 4-digit year (e.g. `2026`)
 *   MM    → 2-digit month (`01`–`12`)
 *   DD    → 2-digit day of month (`01`–`31`)
 *   dddd  → full English weekday (`Monday`)
 *   ddd   → short English weekday (`Mon`)
 *
 * Template tokens (Obsidian-ish):
 *   {{date}}     → ISO date (`2026-04-24`)
 *   {{day}}      → full weekday (`Friday`)
 *   {{week}}     → ISO week number (`17`)
 *   {{previous}} → wikilink to yesterday's daily note (`[[2026-04-23]]`)
 *   {{next}}     → wikilink to tomorrow's daily note (`[[2026-04-25]]`)
 */

const FULL_WEEKDAYS = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
] as const;

const SHORT_WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

function isoDate(date: Date): string {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

/**
 * Compute the ISO 8601 week number for a date (1–53).
 * Uses the standard "Thursday in the same week" trick.
 */
function isoWeek(date: Date): number {
  // Copy so we don't mutate the caller's date.
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = (d.getUTCDay() + 6) % 7; // Mon=0..Sun=6
  d.setUTCDate(d.getUTCDate() - dayNum + 3); // nearest Thursday
  const firstThursday = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
  const diff = (d.getTime() - firstThursday.getTime()) / 86400000;
  return 1 + Math.round((diff - 3 + ((firstThursday.getUTCDay() + 6) % 7)) / 7);
}

/**
 * Substitute filename tokens. Order matters: `dddd` must run before `ddd` so
 * the longer token isn't shadowed; same for `YYYY`/`YY` etc.
 */
export function formatDailyFilename(date: Date, format: string): string {
  const yyyy = String(date.getFullYear());
  const mm = pad2(date.getMonth() + 1);
  const dd = pad2(date.getDate());
  const fullDow = FULL_WEEKDAYS[date.getDay()];
  const shortDow = SHORT_WEEKDAYS[date.getDay()];
  return format
    .replace(/YYYY/g, yyyy)
    .replace(/MM/g, mm)
    .replace(/DD/g, dd)
    .replace(/dddd/g, fullDow)
    .replace(/ddd/g, shortDow);
}

/**
 * Substitute template tokens. `prevDateLink` / `nextDateLink` are normally the
 * stem of the previous/next day's note (without `.md`); we wrap in `[[…]]`.
 * If the caller already supplies a wikilink (`[[X]]`) we don't double-wrap.
 */
export function applyTemplate(
  template: string,
  date: Date,
  prevDateLink?: string,
  nextDateLink?: string,
): string {
  const dateStr = isoDate(date);
  const dayStr = FULL_WEEKDAYS[date.getDay()];
  const weekStr = String(isoWeek(date));

  function asWikilink(s: string | undefined): string {
    if (!s) return '';
    return /^\[\[.*\]\]$/.test(s) ? s : `[[${s}]]`;
  }

  return template
    .replace(/\{\{\s*date\s*\}\}/g, dateStr)
    .replace(/\{\{\s*day\s*\}\}/g, dayStr)
    .replace(/\{\{\s*week\s*\}\}/g, weekStr)
    .replace(/\{\{\s*previous\s*\}\}/g, asWikilink(prevDateLink))
    .replace(/\{\{\s*next\s*\}\}/g, asWikilink(nextDateLink));
}

/**
 * Reasonable starter template used when the user hasn't customised one.
 * Keep it short so it doesn't feel imposing. The H1 uses {{date}} so the
 * filename and heading stay in sync if the user renames the file later.
 */
export function defaultDailyTemplate(lang: 'en' | 'zh'): string {
  if (lang === 'zh') {
    return [
      '# {{date}}（{{day}}）',
      '',
      '> 上一篇：{{previous}} · 下一篇：{{next}}',
      '',
      '## 今日要事',
      '- ',
      '',
      '## 笔记',
      '',
      '## 复盘',
      '',
    ].join('\n');
  }
  return [
    '# {{date}} ({{day}})',
    '',
    '> Previous: {{previous}} · Next: {{next}}',
    '',
    '## Today',
    '- ',
    '',
    '## Notes',
    '',
    '## Reflections',
    '',
  ].join('\n');
}
