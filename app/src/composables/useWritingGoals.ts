/**
 * v2.5 — Word goals + writing stats (Ulysses-inspired).
 *
 * Lightweight per-document goal tracking driven by YAML front matter:
 *
 *     ---
 *     goal: 1500           # required to activate the feature for this doc
 *     goal_unit: words     # optional; "words" | "chars" | "cjk" — default "words"
 *     goal_set_at: 2026-04-26  # auto-stamped on first goal save (driven by Editor)
 *     ---
 *
 * If `goal` is missing, the feature stays inert for that doc.
 *
 * Pure parsing helpers live at the module level; a small composable wraps
 * them up for the Vue side and exposes the active doc's progress.
 */
import { computed } from 'vue';
import { useTabsStore } from '../stores/tabs';
import { cjkWordCount } from '../lib/chinese';

export type GoalUnit = 'words' | 'chars' | 'cjk';

export interface WritingGoal {
  goal: number;
  unit: GoalUnit;
  setAt: string | null;
}

const FRONT_MATTER_RE = /^﻿?---\r?\n([\s\S]*?)\r?\n---/;

/** Strip the front matter block from a body so word-counting only counts prose. */
export function bodyWithoutFrontMatter(body: string): string {
  if (!body) return '';
  const m = body.match(FRONT_MATTER_RE);
  if (!m) return body;
  return body.slice(m[0].length).replace(/^\r?\n/, '');
}

/**
 * Parse the goal-related fields out of a markdown body's YAML front matter.
 * Returns null if there's no front matter or no `goal:` key.
 */
export function readWritingGoal(body: string): WritingGoal | null {
  if (!body) return null;
  const m = body.match(FRONT_MATTER_RE);
  if (!m) return null;
  const yaml = m[1];

  // goal: 1500
  const goalMatch = yaml.match(/^\s*goal\s*:\s*(\d+)\s*$/m);
  if (!goalMatch) return null;
  const goal = parseInt(goalMatch[1], 10);
  if (!Number.isFinite(goal) || goal <= 0) return null;

  // goal_unit: words | chars | cjk
  const unitMatch = yaml.match(/^\s*goal_unit\s*:\s*(\S+)\s*$/m);
  let unit: GoalUnit = 'words';
  if (unitMatch) {
    const v = stripYamlQuotes(unitMatch[1]).toLowerCase();
    if (v === 'words' || v === 'chars' || v === 'cjk') unit = v;
  }

  // goal_set_at: 2026-04-26  (ISO-ish; we don't validate strictly)
  const setAtMatch = yaml.match(/^\s*goal_set_at\s*:\s*(.+?)\s*$/m);
  const setAt = setAtMatch ? stripYamlQuotes(setAtMatch[1]) : null;

  return { goal, unit, setAt };
}

function stripYamlQuotes(s: string): string {
  const t = s.trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    return t.slice(1, -1);
  }
  return t;
}

/**
 * Stamp `goal_set_at: <YYYY-MM-DD>` into front matter the first time a goal
 * is saved, so the streak counter has a stable origin date. Idempotent.
 *
 * Returns the (possibly unchanged) body. If the doc has no front matter or
 * no `goal:` key, returns the body untouched.
 */
export function stampGoalSetAtIfMissing(body: string, today: string = todayISO()): string {
  if (!body) return body;
  const m = body.match(FRONT_MATTER_RE);
  if (!m) return body;
  const yaml = m[1];
  if (!/^\s*goal\s*:\s*\d+\s*$/m.test(yaml)) return body;
  if (/^\s*goal_set_at\s*:/m.test(yaml)) return body;

  // Append `goal_set_at: <today>` at the end of the YAML block.
  const newYaml = yaml.replace(/\s*$/, '') + `\ngoal_set_at: ${today}`;
  return body.slice(0, m.index!) + `---\n${newYaml}\n---` + body.slice(m.index! + m[0].length);
}

export function todayISO(d: Date = new Date()): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * Count tokens in `body` (front matter excluded) per the requested unit.
 *
 * - words: whitespace-split tokens that contain at least one letter or digit
 *   (Western convention — same heuristic the existing word counter uses).
 * - chars: total characters excluding whitespace.
 * - cjk: CJK ideographs / kana / hangul syllables only.
 */
export function countForUnit(body: string, unit: GoalUnit): number {
  const text = bodyWithoutFrontMatter(body);
  const stats = cjkWordCount(text);
  switch (unit) {
    case 'cjk':
      return stats.cjk;
    case 'chars':
      return stats.chars;
    case 'words':
    default:
      return stats.total;
  }
}

/** Singleton key for compute-once-per-call stability. */
export function useWritingGoals() {
  const tabs = useTabsStore();

  const activeBody = computed(() => tabs.activeTab?.content ?? '');
  const activeSavedBody = computed(() => tabs.activeTab?.savedContent ?? '');
  const activeTabId = computed(() => tabs.activeTab?.id ?? '');
  const activeTabPath = computed(() => tabs.activeTab?.filePath ?? tabs.activeTab?.id ?? '');

  const goal = computed<WritingGoal | null>(() => readWritingGoal(activeBody.value));

  /** Current count under the active doc's chosen unit. 0 when no goal. */
  const current = computed(() => {
    if (!goal.value) return 0;
    return countForUnit(activeBody.value, goal.value.unit);
  });

  /** Count of the *saved* version of the doc — used to compute "since save" delta. */
  const savedCount = computed(() => {
    if (!goal.value) return 0;
    return countForUnit(activeSavedBody.value, goal.value.unit);
  });

  /** 0..1 progress fraction. Caps at 1 for display purposes (overshoot still allowed in raw count). */
  const progress = computed(() => {
    if (!goal.value || goal.value.goal <= 0) return 0;
    return Math.min(1, current.value / goal.value.goal);
  });

  const reachedGoal = computed(() => !!goal.value && current.value >= goal.value.goal);

  return {
    goal,
    current,
    savedCount,
    progress,
    reachedGoal,
    activeBody,
    activeSavedBody,
    activeTabId,
    activeTabPath,
  };
}
