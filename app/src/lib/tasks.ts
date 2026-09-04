/**
 * Task metadata — priority and due date — parsed out of a task's text.
 *
 * The Rust index finds `- [ ]` lines and hands the text over verbatim
 * (`workspace_index::extract_tasks`); everything about what that text *means*
 * lives here, so the syntax is defined once instead of in two languages that
 * drift.
 *
 * Two spellings are accepted for each field, on purpose:
 *
 *   - The Obsidian Tasks emoji (`⏫ 🔼 🔽`, `📅 2026-09-10`), so a vault that
 *     already uses them keeps working when it is opened here.
 *   - A plain-ASCII form (`!!!`, `[#A]`, `due:2026-09-10`) for everyone who is
 *     not going to reach for an emoji picker mid-sentence.
 *
 * Anything not recognised is left in the text. A parser that silently eats
 * words it does not understand is worse than one that shows them.
 */

export type TaskPriority = 'high' | 'medium' | 'low' | null;

export interface TaskMeta {
  /** Display text, with the tokens this module consumed removed. */
  title: string;
  priority: TaskPriority;
  /** `YYYY-MM-DD`, or null. */
  due: string | null;
  /** `#tags` mentioned in the task (kept in `title` as well). */
  tags: string[];
}

const PRIORITY_RANK: Record<Exclude<TaskPriority, null>, number> = {
  high: 0,
  medium: 1,
  low: 2,
};

/** `2026-09-10` and nothing else — no `10/09/2026` ambiguity to guess at. */
const DATE = /(\d{4}-\d{2}-\d{2})/;

const DUE_PATTERNS: RegExp[] = [
  new RegExp(`📅\\s*${DATE.source}`, 'u'),
  new RegExp(`\\bdue\\s*:\\s*${DATE.source}`, 'iu'),
];

const EMOJI_PRIORITY: Array<[RegExp, Exclude<TaskPriority, null>]> = [
  [/⏫/u, 'high'],
  [/🔼/u, 'medium'],
  [/🔽/u, 'low'],
];

const BRACKET_PRIORITY: Array<[RegExp, Exclude<TaskPriority, null>]> = [
  [/\[#A\]/iu, 'high'],
  [/\[#B\]/iu, 'medium'],
  [/\[#C\]/iu, 'low'],
];

/**
 * `!`, `!!`, `!!!` as a standalone token.
 *
 * The word-boundary requirement is what keeps "Ship it!" a plain sentence:
 * the bang there is attached to a word, and only a bang standing on its own is
 * a priority marker.
 */
const BANG_PRIORITY = /(^|\s)(!{1,3})(?=\s|$)/u;

export function parseTaskMeta(text: string): TaskMeta {
  let rest = text;
  let priority: TaskPriority = null;
  let due: string | null = null;

  for (const pattern of DUE_PATTERNS) {
    const m = pattern.exec(rest);
    if (m) {
      due = m[1];
      rest = rest.replace(pattern, ' ');
      break;
    }
  }

  for (const [pattern, level] of [...EMOJI_PRIORITY, ...BRACKET_PRIORITY]) {
    if (pattern.test(rest)) {
      priority = level;
      rest = rest.replace(pattern, ' ');
      break;
    }
  }

  if (!priority) {
    const m = BANG_PRIORITY.exec(rest);
    if (m) {
      priority = m[2].length === 3 ? 'high' : m[2].length === 2 ? 'medium' : 'low';
      rest = rest.replace(BANG_PRIORITY, ' ');
    }
  }

  const tags = [...rest.matchAll(/(?:^|\s)#([\w一-鿿/-]+)/gu)].map((m) => m[1]);

  return {
    title: rest.replace(/\s{2,}/g, ' ').trim(),
    priority,
    due,
    tags,
  };
}

/** `YYYY-MM-DD` for a Date, in local time — `toISOString` would shift the day
 *  for anyone east or west of UTC, which is exactly who reports "it says my
 *  task is overdue and it isn't". */
export function localDateKey(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Due strictly before today. Today itself is due, not overdue. */
export function isOverdue(due: string | null, today: string): boolean {
  return !!due && due < today;
}

export interface SortableTask {
  done: boolean;
  meta: TaskMeta;
}

/**
 * Panel order: unfinished first, then by due date (soonest, undated last),
 * then by priority, then alphabetically so the list does not shuffle between
 * renders.
 */
export function compareTasks(a: SortableTask, b: SortableTask): number {
  if (a.done !== b.done) return a.done ? 1 : -1;
  const aDue = a.meta.due ?? '￿';
  const bDue = b.meta.due ?? '￿';
  if (aDue !== bDue) return aDue < bDue ? -1 : 1;
  const aP = a.meta.priority ? PRIORITY_RANK[a.meta.priority] : 3;
  const bP = b.meta.priority ? PRIORITY_RANK[b.meta.priority] : 3;
  if (aP !== bP) return aP - bP;
  return a.meta.title.localeCompare(b.meta.title);
}

/**
 * Flip `[ ]` ↔ `[x]` on one line of a document.
 *
 * Returns null when that line is not a task — the caller must not write the
 * file back in that case, because a mismatch means the index is stale and the
 * line now holds something else entirely.
 */
export function toggleTaskLine(content: string, line1Based: number): string | null {
  const lines = content.split('\n');
  const idx = line1Based - 1;
  if (idx < 0 || idx >= lines.length) return null;
  const m = /^(\s*[-*+]\s+\[)([ xX])(\]\s+.*)$/.exec(lines[idx]);
  if (!m) return null;
  lines[idx] = `${m[1]}${m[2] === ' ' ? 'x' : ' '}${m[3]}`;
  return lines.join('\n');
}
