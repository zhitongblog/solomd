/**
 * CodeMirror 6 extension for `[[wikilink]]` syntax (F1 of v2.0).
 *
 * Provides:
 *   - Decoration: `[[X]]` rendered as a styled span (resolved → green, unresolved → red dashed).
 *   - Click handling: Cmd/Ctrl+click on a wikilink resolves the target via the
 *     workspace index store and emits `solomd:wiki-open` (App.vue listens and
 *     opens the file).
 *   - Autocomplete: typing `[[` opens a dropdown of matching workspace files.
 *
 * Resolution is fuzzy: stem (case-insensitive) → title (H1 / front-matter
 * title) → substring of stem. Misses are still rendered (red dashed) so the
 * user can act.
 */
import {
  Decoration,
  EditorView,
  MatchDecorator,
  ViewPlugin,
  ViewUpdate,
  WidgetType,
} from '@codemirror/view';
import type { DecorationSet } from '@codemirror/view';
import type {
  CompletionContext,
  CompletionResult,
  Completion,
} from '@codemirror/autocomplete';
import type { Extension } from '@codemirror/state';
import { useWorkspaceIndexStore } from '../stores/workspaceIndex';

const WIKILINK_RE = /\[\[([^\[\]\n]+?)\]\]/g;

function parseInner(inner: string): { target: string; alias?: string; heading?: string } {
  let target = inner.trim();
  let alias: string | undefined;
  let heading: string | undefined;
  const pipeIdx = target.indexOf('|');
  if (pipeIdx >= 0) {
    alias = target.slice(pipeIdx + 1).trim() || undefined;
    target = target.slice(0, pipeIdx).trim();
  }
  const hashIdx = target.indexOf('#');
  if (hashIdx >= 0) {
    heading = target.slice(hashIdx + 1).trim() || undefined;
    target = target.slice(0, hashIdx).trim();
  }
  return { target, alias, heading };
}

function isResolved(target: string): boolean {
  if (!target) return false;
  try {
    const idx = useWorkspaceIndexStore();
    if (!idx.ready || idx.entries.length === 0) return true; // assume valid until index ready
    return idx.byStem.has(target.toLowerCase());
  } catch {
    return true;
  }
}

class WikilinkWidget extends WidgetType {
  constructor(readonly inner: string, readonly resolved: boolean, readonly display: string) {
    super();
  }
  toDOM(): HTMLElement {
    const span = document.createElement('span');
    span.className = `cm-wikilink ${this.resolved ? 'cm-wikilink--ok' : 'cm-wikilink--missing'}`;
    span.textContent = this.display;
    span.title = this.resolved
      ? `Open ${this.inner} (Cmd/Ctrl+click)`
      : `${this.inner} not found in workspace — Cmd/Ctrl+click to create`;
    span.setAttribute('data-wikilink', this.inner);
    return span;
  }
  ignoreEvent(): boolean {
    return false;
  }
  eq(other: WidgetType): boolean {
    return (
      other instanceof WikilinkWidget &&
      other.inner === this.inner &&
      other.resolved === this.resolved &&
      other.display === this.display
    );
  }
}

const wikilinkMatcher = new MatchDecorator({
  regexp: WIKILINK_RE,
  decoration: (m) => {
    const inner = m[1] || '';
    const parsed = parseInner(inner);
    const display = parsed.alias || (parsed.heading ? `${parsed.target}#${parsed.heading}` : parsed.target);
    const resolved = isResolved(parsed.target);
    return Decoration.replace({
      widget: new WikilinkWidget(parsed.target, resolved, display),
    });
  },
});

class WikilinkPluginValue {
  decorations: DecorationSet;
  constructor(view: EditorView) {
    this.decorations = wikilinkMatcher.createDeco(view);
  }
  update(update: ViewUpdate) {
    this.decorations = wikilinkMatcher.updateDeco(update, this.decorations);
  }
}

const wikilinkPlugin = ViewPlugin.fromClass(WikilinkPluginValue, {
  decorations: (v) => v.decorations,
  eventHandlers: {
    mousedown(e: MouseEvent) {
      const target = e.target as HTMLElement | null;
      if (!target) return false;
      const link = target.closest('.cm-wikilink');
      if (!link) return false;
      if (!(e.metaKey || e.ctrlKey)) return false;
      const inner = link.getAttribute('data-wikilink') || '';
      if (!inner) return false;
      e.preventDefault();
      // Defer resolution to App.vue (it has access to the files composable).
      window.dispatchEvent(new CustomEvent('solomd:wiki-open', { detail: { target: inner } }));
      return true;
    },
  },
});

const wikilinkTheme = EditorView.theme({
  '.cm-wikilink': {
    cursor: 'pointer',
    padding: '0 2px',
    borderRadius: '3px',
    transition: 'background 0.12s',
  },
  '.cm-wikilink--ok': {
    color: 'var(--accent, #ff9f40)',
    backgroundColor: 'color-mix(in srgb, var(--accent, #ff9f40) 12%, transparent)',
  },
  '.cm-wikilink--ok:hover': {
    backgroundColor: 'color-mix(in srgb, var(--accent, #ff9f40) 22%, transparent)',
    textDecoration: 'underline',
  },
  '.cm-wikilink--missing': {
    color: 'var(--text-muted, #888)',
    backgroundColor: 'transparent',
    border: '1px dashed color-mix(in srgb, currentColor 60%, transparent)',
    padding: '0 4px',
  },
  '.cm-wikilink--missing:hover': {
    color: '#d63939',
    borderColor: '#d63939',
  },
});

// ---- Autocomplete ---------------------------------------------------------

function wikilinkComplete(context: CompletionContext): CompletionResult | null {
  // Match `[[query` up to cursor.
  const match = context.matchBefore(/\[\[([^\[\]\n]*)$/);
  if (!match) return null;
  const query = match.text.slice(2);
  if (!context.explicit && query.length === 0) {
    // Don't autoshow on empty `[[`; user can press Ctrl+Space if they want to.
    return null;
  }
  let entries: { stem: string; name: string; title: string | null }[] = [];
  try {
    const idx = useWorkspaceIndexStore();
    entries = idx.entries.map((e) => ({
      stem: e.stem,
      name: e.name,
      title: e.title || null,
    }));
  } catch {
    return null;
  }
  const q = query.toLowerCase();
  const ranked = entries
    .map((e) => {
      const stemLc = e.stem.toLowerCase();
      const titleLc = (e.title || '').toLowerCase();
      let score = 0;
      if (stemLc === q) score = 100;
      else if (stemLc.startsWith(q)) score = 90;
      else if (titleLc === q) score = 80;
      else if (titleLc.startsWith(q)) score = 70;
      else if (stemLc.includes(q)) score = 50;
      else if (titleLc.includes(q)) score = 40;
      return { e, score };
    })
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score || a.e.stem.localeCompare(b.e.stem))
    .slice(0, 30);

  const options: Completion[] = ranked.map(({ e }) => ({
    label: e.stem,
    detail: e.title && e.title !== e.stem ? e.title : undefined,
    apply: (view: EditorView, _completion: Completion, from: number, to: number) => {
      // Insert `stem]]` and place cursor *after* the closing brackets.
      const insertText = `${e.stem}]]`;
      view.dispatch({
        changes: { from, to, insert: insertText },
        selection: { anchor: from + insertText.length },
      });
    },
  }));
  return {
    from: match.from + 2, // after the `[[`
    options,
    validFor: /^[^\[\]\n]*$/,
  };
}

/** Decoration + click + theme only (no autocompletion). The matching
 * `wikilinkComplete` source is exported separately and combined in
 * Editor.vue with the other markdown autocompletion sources, since CM6
 * doesn't allow multiple `autocompletion({ override })` extensions to
 * coexist. */
export function wikilinkExtension(): Extension {
  return [wikilinkPlugin, wikilinkTheme];
}

export { wikilinkComplete };
