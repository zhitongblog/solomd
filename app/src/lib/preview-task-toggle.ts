/**
 * Toggle a GFM task (`- [ ]` / `- [x]`) in the source from a click on its
 * rendered checkbox in the in-app preview.
 *
 * The preview's `<li class="task-list-item">` carries `data-line` (the
 * 1-based source line markdown-it mapped it to). That number is trusted only
 * when the source line really is a task in the state the checkbox showed
 * before the click — `preprocessMarkdown` can, in rare cases, shift lines, and
 * a split preview can be showing the saved text while the tab holds edits.
 * Otherwise fall back to the checkbox's index among all task lines (outside
 * code fences), again only if its state matches. When neither matches the
 * click is refused (null) rather than ticking some other box.
 */

/** Bullet or ordered marker (optionally inside blockquotes), then `[ ]`/`[x]` and a space. */
const TASK_LINE_RE = /^((?:[ \t]*>)*[ \t]*(?:[-*+]|\d{1,9}[.)])[ \t]+\[)([ xX])(\][ \t ])/;
const FENCE_RE = /^[ \t]*(`{3,}|~{3,})/;

/** 0-based indexes of the lines that are task items, skipping fenced code. */
export function taskLineIndexes(lines: string[]): number[] {
  const out: number[] = [];
  let fence: string | null = null;
  for (let i = 0; i < lines.length; i++) {
    const f = FENCE_RE.exec(lines[i]);
    if (f) {
      if (fence === null) fence = f[1][0];
      else if (f[1][0] === fence) fence = null;
      continue;
    }
    if (fence !== null) continue;
    if (TASK_LINE_RE.test(lines[i])) out.push(i);
  }
  return out;
}

/**
 * @param source       the document text to rewrite
 * @param dataLine     the `<li data-line>` value (1-based), 0/NaN if absent
 * @param taskIndex    index of the clicked checkbox among the preview's task checkboxes
 * @param wasChecked   checkbox state before the click
 * @returns the new source, or null when the task could not be located safely
 */
export function togglePreviewTask(
  source: string,
  dataLine: number,
  taskIndex: number,
  wasChecked: boolean,
): string | null {
  const lines = source.split('\n');
  const tasks = taskLineIndexes(lines);
  const matches = (i: number | undefined): i is number => {
    if (i === undefined || !tasks.includes(i)) return false;
    const m = TASK_LINE_RE.exec(lines[i]);
    return !!m && (m[2] !== ' ') === wasChecked;
  };
  let target: number | null = null;
  if (dataLine > 0 && matches(dataLine - 1)) target = dataLine - 1;
  else if (taskIndex >= 0 && matches(tasks[taskIndex])) target = tasks[taskIndex];
  if (target === null) return null;
  lines[target] = lines[target].replace(
    TASK_LINE_RE,
    (_all, pre: string, _mark: string, post: string) => `${pre}${wasChecked ? ' ' : 'x'}${post}`,
  );
  return lines.join('\n');
}
