/**
 * text-case.ts — case transforms shared by both editors.
 *
 * SoloMD runs CodeMirror on macOS/Linux and a plain <textarea> on Windows
 * (see `shouldUsePlainWindowsEditor`), and the plain path is itself split into
 * a block editor and a flat one. Any editing feature that lives in only one of
 * them silently does nothing for a whole platform — that is exactly how the
 * slash-command autocomplete stayed broken on Windows (Gitee IK6JCC). So the
 * logic lives here as pure functions over a string + range, and each editor
 * only supplies "what is selected" and "write this back".
 *
 * Requested in Gitee IK8QG3.
 */

export type CaseMode = 'upper' | 'lower' | 'title';

/**
 * Title Case: capitalise the first cased character of each word, lowercase the
 * rest. `\p{L}` rather than `[a-z]` so accented Latin behaves; CJK has no case
 * so those runs pass through untouched, which is what a mixed 中英 note wants.
 */
function toTitleCase(text: string): string {
  return text
    .toLowerCase()
    .replace(/(^|[^\p{L}\p{N}'])(\p{L})/gu, (_m, sep: string, ch: string) => sep + ch.toUpperCase());
}

export function transformCase(text: string, mode: CaseMode): string {
  if (mode === 'upper') return text.toUpperCase();
  if (mode === 'lower') return text.toLowerCase();
  return toTitleCase(text);
}

/**
 * Which transform the cycle shortcut should apply next, from the text's own
 * current shape: lower → UPPER → Title → lower.
 *
 * Text with no cased characters at all (pure CJK, digits, punctuation) reports
 * `upper`, but every transform is a no-op there anyway — callers can skip the
 * write when the result is unchanged rather than special-casing it here.
 */
export function nextCaseInCycle(text: string): CaseMode {
  const hasCased = /\p{Lu}|\p{Ll}/u.test(text);
  if (!hasCased) return 'upper';
  if (text === text.toLowerCase()) return 'upper';
  if (text === text.toUpperCase()) return 'title';
  return 'lower';
}

export interface CaseRange {
  from: number;
  to: number;
  text: string;
}

/**
 * The range a case transform should act on: the selection when there is one,
 * otherwise the word under the caret. Returns null when there is nothing to
 * act on, so callers can no-op instead of writing an identical document.
 *
 * "Word" spans letters, digits, underscore and apostrophes (so `doesn't`
 * survives as one word); it deliberately does NOT cross whitespace or
 * punctuation.
 */
export function caseTargetRange(
  doc: string,
  selFrom: number,
  selTo: number,
): CaseRange | null {
  if (selFrom !== selTo) {
    const from = Math.min(selFrom, selTo);
    const to = Math.max(selFrom, selTo);
    return { from, to, text: doc.slice(from, to) };
  }
  const isWordChar = (c: string) => /[\p{L}\p{N}_']/u.test(c);
  let from = selFrom;
  let to = selFrom;
  while (from > 0 && isWordChar(doc[from - 1])) from -= 1;
  while (to < doc.length && isWordChar(doc[to])) to += 1;
  if (from === to) return null;
  return { from, to, text: doc.slice(from, to) };
}
