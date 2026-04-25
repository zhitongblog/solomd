/**
 * F3 — CodeMirror 6 autocomplete for `#tag` references in markdown.
 *
 * The completion source is sourced from the workspace index store
 * (`useWorkspaceIndexStore().tags`). Triggers as the user types `#`
 * followed by tag-name characters (letters, digits, `-`, `_`, `/`).
 *
 * Inserts plain `#tagname` — no closing token required, since `#tag` already
 * has a clean terminator (whitespace).
 *
 * Code-fence guard: completion is suppressed when the cursor sits inside an
 * indented code block (line starts with 4+ spaces / a tab) or a fenced code
 * block (between matching ```). We use a heuristic that scans only the
 * current document head up to the cursor — much cheaper than building a
 * full markdown syntax tree just for this.
 */
import {
  autocompletion,
  type CompletionContext,
  type CompletionResult,
  type Completion,
} from '@codemirror/autocomplete';
import type { Extension } from '@codemirror/state';
import { useWorkspaceIndexStore } from '../stores/workspaceIndex';

/** A tag-name char, matching what `workspace_index.rs` accepts. */
const TAG_CHAR = /[\p{L}\p{N}_/\-]/u;

/**
 * Heuristic: are we inside a fenced or indented code block?
 *
 * Walks doc lines from the start to the cursor's line. Toggles a fenced
 * flag on every line whose first non-space content is ``` or ~~~. If
 * we land in fenced=true, autocompletion is suppressed. Also suppresses
 * inside the cursor's own indented code line (4+ spaces / leading tab).
 */
interface DocLike {
  lineAt: (n: number) => { number: number; text: string };
  line: (n: number) => { number: number; text: string };
}

function inCodeContext(doc: DocLike, pos: number): boolean {
  const cursorLine = doc.lineAt(pos);
  // Indented code block: 4+ leading spaces or a tab on this very line.
  if (/^(    |\t)/.test(cursorLine.text)) return true;

  let fenced = false;
  for (let i = 1; i < cursorLine.number; i++) {
    const text = doc.line(i).text;
    // Skip leading spaces (≤3) per CommonMark before a fence opener.
    const trimmed = text.replace(/^ {0,3}/, '');
    if (/^(```|~~~)/.test(trimmed)) {
      fenced = !fenced;
    }
  }
  return fenced;
}

function tagComplete(context: CompletionContext): CompletionResult | null {
  // Match `#partial` immediately before the cursor. The regex captures the
  // partial after `#` so we can use it as both filter and the `from` anchor.
  const match = context.matchBefore(/#[\p{L}\p{N}_/\-]*/u);
  if (!match) return null;
  // `matchBefore` may return an empty match starting AT the cursor; ignore.
  if (match.from === match.to && !context.explicit) return null;

  // Don't trigger on `##` (markdown heading) or if `#` is mid-word like `a#b`.
  // matchBefore guarantees the `#` is at match.from. Look one char behind.
  if (match.from > 0) {
    const prev = context.state.doc.sliceString(match.from - 1, match.from);
    if (prev === '#') return null; // `##` heading
    if (TAG_CHAR.test(prev)) return null; // word boundary
  }

  // Skip code blocks.
  if (inCodeContext(context.state.doc as unknown as DocLike, context.pos)) {
    return null;
  }

  const partial = match.text.slice(1).toLowerCase();
  // Don't autoshow on a bare `#` (too noisy); user can hit Ctrl+Space.
  if (!context.explicit && partial.length === 0) return null;

  let tags: { tag: string; count: number }[] = [];
  try {
    const idx = useWorkspaceIndexStore();
    tags = idx.tags.map((t) => ({ tag: t.tag, count: t.count }));
  } catch {
    return null;
  }

  const ranked = tags
    .map((t) => {
      const lc = t.tag.toLowerCase();
      let score = 0;
      if (lc === partial) score = 100;
      else if (lc.startsWith(partial)) score = 80;
      else if (lc.includes(partial)) score = 50;
      return { t, score };
    })
    .filter((r) => r.score > 0)
    .sort(
      (a, b) =>
        b.score - a.score ||
        b.t.count - a.t.count ||
        a.t.tag.localeCompare(b.t.tag),
    )
    .slice(0, 30);

  const options: Completion[] = ranked.map(({ t }) => ({
    label: `#${t.tag}`,
    detail: String(t.count),
    // Replace the entire `#partial` match with `#tagname` so we don't end up
    // with `##tag` or `#par#tag` if the autocompleter's default text-insert
    // logic disagreed with our match boundaries.
    apply: (view, _completion, from, to) => {
      const insertText = `#${t.tag}`;
      view.dispatch({
        changes: { from, to, insert: insertText },
        selection: { anchor: from + insertText.length },
      });
    },
  }));

  return {
    from: match.from,
    to: match.to,
    options,
    validFor: /^#[\p{L}\p{N}_/\-]*$/u,
  };
}

export function tagAutocompleteExtension(): Extension {
  return [
    autocompletion({
      override: [tagComplete],
      defaultKeymap: true,
      activateOnTyping: true,
    }),
  ];
}
