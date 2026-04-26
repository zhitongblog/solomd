/**
 * cm-slash-commands.ts — Affine/Notion-style "/" slash command popup.
 *
 * Triggered when the user types `/` at the start of a line or after
 * whitespace in a markdown buffer. Pops a floating menu of insertable
 * Markdown blocks (heading, list, code, table, …); typing further
 * filters; ↑↓ navigate; Enter inserts; Esc dismisses.
 *
 * Implemented as:
 *   - StateField<SlashState | null>  — tracks the active query / range
 *   - showTooltip facet              — renders the floating popup near
 *                                      the trigger position
 *   - keymap Prec.highest            — captures ↑↓/Enter/Esc only when
 *                                      the popup is open
 *   - update listener                — opens / closes / refines query
 *                                      as the doc changes
 *
 * v2.5 — bonus feature for GitHub Discussion #30.
 *
 * No external deps — pure CodeMirror 6 + DOM.
 */

import {
  StateField,
  StateEffect,
  Prec,
  type Extension,
  type EditorState,
} from '@codemirror/state';
import {
  EditorView,
  keymap,
  showTooltip,
  type Tooltip,
  type TooltipView,
} from '@codemirror/view';
import { syntaxTree } from '@codemirror/language';

import {
  SLASH_BLOCKS,
  filterBlocks,
  expandSnippet,
  type SlashBlock,
} from './slash-blocks';

// ---------------------------------------------------------------------------
// Public types — keep label/hint overridable for i18n.
// ---------------------------------------------------------------------------

export interface SlashCommandsConfig {
  /** Reactive on/off. Returning false disables the trigger entirely. */
  enabled: () => boolean;
  /**
   * Per-id label overrides. Optional — falls back to the block's
   * built-in English label.
   */
  labelFor?: (id: string) => string | undefined;
  /** Per-id hint overrides. */
  hintFor?: (id: string) => string | undefined;
  /** Localized "no results" template — `{query}` is replaced. */
  emptyHint?: (query: string) => string;
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

interface SlashState {
  /** Position of the leading `/` character. */
  triggerPos: number;
  /** End of the typed query (cursor position). */
  end: number;
  /** Substring after `/`, lower-cased filter source. */
  query: string;
  /** Currently highlighted entry in the filtered list. */
  selectedIndex: number;
}

const setSlashState = StateEffect.define<SlashState | null>();

const slashStateField = StateField.define<SlashState | null>({
  create: () => null,
  update(value, tr) {
    // Explicit set-effects win.
    for (const e of tr.effects) {
      if (e.is(setSlashState)) {
        value = e.value;
      }
    }
    if (!value) return null;

    // If the doc changed, walk the change set and remap our trigger /
    // end positions. A change that removes the leading `/` cancels.
    if (tr.docChanged) {
      const triggerPos = tr.changes.mapPos(value.triggerPos, -1);
      if (triggerPos >= tr.state.doc.length) return null;
      const ch = tr.state.doc.sliceString(triggerPos, triggerPos + 1);
      if (ch !== '/') return null;
      // Cursor must still be on the same line as the trigger.
      const triggerLine = tr.state.doc.lineAt(triggerPos);
      const sel = tr.state.selection.main.head;
      if (sel < triggerPos || sel > triggerLine.to) return null;
      const newQuery = tr.state.doc.sliceString(triggerPos + 1, sel);
      // Cancel on whitespace / newlines / common terminators in the query.
      if (/[\s,;\n]/.test(newQuery)) return null;
      value = { ...value, end: sel, query: newQuery, selectedIndex: 0 };
      return value;
    }

    // No doc change — selection may still have moved (Esc / arrow).
    if (tr.selection) {
      const sel = tr.state.selection.main.head;
      if (sel < value.triggerPos) return null;
      const triggerLine = tr.state.doc.lineAt(value.triggerPos);
      if (sel > triggerLine.to) return null;
      // Cursor moved past the typed query end — accept it as the new end.
      const newEnd = Math.max(value.triggerPos + 1, sel);
      const newQuery = tr.state.doc.sliceString(value.triggerPos + 1, newEnd);
      if (/[\s,;\n]/.test(newQuery)) return null;
      value = { ...value, end: newEnd, query: newQuery };
    }
    return value;
  },
  provide: (f) =>
    showTooltip.compute([f], (state) => {
      const v = state.field(f);
      if (!v) return null;
      return buildTooltip(v);
    }),
});

// ---------------------------------------------------------------------------
// Tooltip rendering
// ---------------------------------------------------------------------------

let activeConfig: SlashCommandsConfig | null = null;

function buildTooltip(state: SlashState): Tooltip {
  return {
    pos: state.triggerPos,
    above: false,
    arrow: false,
    create: (view) => renderPopup(view, state),
  };
}

function labelOf(b: SlashBlock): string {
  return activeConfig?.labelFor?.(b.id) ?? b.label;
}

function hintOf(b: SlashBlock): string {
  return activeConfig?.hintFor?.(b.id) ?? b.hint;
}

function emptyHintFor(query: string): string {
  return (
    activeConfig?.emptyHint?.(query) ??
    `No commands match "${query}" · Esc to dismiss`
  );
}

function renderPopup(view: EditorView, initial: SlashState): TooltipView {
  const root = document.createElement('div');
  root.className = 'cm-slash-popup';
  root.setAttribute('role', 'listbox');
  root.setAttribute('aria-label', 'Slash commands');

  let lastQuery = '<NEVER>';
  let lastSelectedIndex = -1;

  const repaint = (s: SlashState) => {
    const filtered = filterBlocks(SLASH_BLOCKS, s.query);
    if (s.query === lastQuery && s.selectedIndex === lastSelectedIndex) {
      return;
    }
    lastQuery = s.query;
    lastSelectedIndex = clampIndex(s.selectedIndex, filtered.length);
    root.replaceChildren();

    if (filtered.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'cm-slash-empty';
      empty.textContent = emptyHintFor(s.query);
      root.appendChild(empty);
      return;
    }

    filtered.forEach((b, i) => {
      const row = document.createElement('div');
      row.className = 'cm-slash-row';
      if (i === lastSelectedIndex) row.classList.add('cm-slash-row--active');
      row.setAttribute('role', 'option');
      row.setAttribute('data-id', b.id);
      row.setAttribute('aria-selected', i === lastSelectedIndex ? 'true' : 'false');

      const icon = document.createElement('span');
      icon.className = 'cm-slash-icon';
      icon.textContent = b.icon;
      row.appendChild(icon);

      const label = document.createElement('span');
      label.className = 'cm-slash-label';
      label.textContent = labelOf(b);
      row.appendChild(label);

      const hint = document.createElement('span');
      hint.className = 'cm-slash-hint';
      hint.textContent = hintOf(b);
      row.appendChild(hint);

      row.addEventListener('mousedown', (ev) => {
        // Prevent the editor losing focus before our handler runs.
        ev.preventDefault();
      });
      row.addEventListener('click', () => {
        const cur = view.state.field(slashStateField, false);
        if (!cur) return;
        insertBlock(view, cur, b);
      });
      row.addEventListener('mouseenter', () => {
        const cur = view.state.field(slashStateField, false);
        if (!cur) return;
        view.dispatch({
          effects: setSlashState.of({ ...cur, selectedIndex: i }),
        });
      });

      root.appendChild(row);
    });
  };

  repaint(initial);

  return {
    dom: root,
    offset: { x: 0, y: 4 },
    update: (u) => {
      const s = u.state.field(slashStateField, false);
      if (!s) return;
      repaint(s);
    },
    mount: () => {
      // Nothing — initial render done above.
    },
    destroy: () => {
      lastQuery = '<NEVER>';
      lastSelectedIndex = -1;
    },
  };
}

function clampIndex(i: number, len: number): number {
  if (len === 0) return 0;
  if (i < 0) return 0;
  if (i >= len) return len - 1;
  return i;
}

// ---------------------------------------------------------------------------
// Inserting
// ---------------------------------------------------------------------------

function insertBlock(view: EditorView, state: SlashState, block: SlashBlock): void {
  const sel = view.state.selection.main;
  const replaceFrom = state.triggerPos;
  const replaceTo = Math.max(state.end, sel.head);
  // The selection-token needs the user's "live" selection. But by the time
  // the popup is up, the cursor IS the selection (typing `/foo` collapses).
  // The intended workflow for wrapping is: user selects → hits `/` → picks
  // bold. In that case, when `/` was typed the selection collapsed to the
  // trigger; we don't have the original selection any more. So treat
  // ${selection} as empty here. Wrappers fall back to ${cursor}-style
  // placement via expandSnippet.
  const expanded = expandSnippet(block.snippet, '');
  view.dispatch({
    changes: { from: replaceFrom, to: replaceTo, insert: expanded.text },
    selection: { anchor: replaceFrom + expanded.cursorOffset },
    effects: setSlashState.of(null),
    scrollIntoView: true,
  });
  view.focus();
}

// ---------------------------------------------------------------------------
// Trigger detection — runs on every doc change, opens the popup when
// the user types `/` at line start or after whitespace.
// ---------------------------------------------------------------------------

function isTriggerPosition(state: EditorState, pos: number): boolean {
  if (pos <= 0) return true;
  const line = state.doc.lineAt(pos);
  if (pos === line.from) return true;
  const prevCh = state.doc.sliceString(pos - 1, pos);
  return /\s/.test(prevCh);
}

function isInsideCodeContext(state: EditorState, pos: number): boolean {
  // Use the syntax tree so we get correct results inside fenced code,
  // inline code, and code blocks. `resolveInner` finds the deepest node
  // covering `pos`.
  const node = syntaxTree(state).resolveInner(pos, -1);
  for (let n: typeof node | null = node; n; n = n.parent) {
    const name = n.name;
    if (
      name === 'FencedCode' ||
      name === 'CodeBlock' ||
      name === 'InlineCode' ||
      name === 'CodeMark' ||
      name === 'CodeText' ||
      name === 'CodeInfo'
    ) {
      return true;
    }
  }
  return false;
}

function makeUpdateListener(config: SlashCommandsConfig) {
  return EditorView.updateListener.of((u) => {
    if (!u.docChanged) return;
    if (!config.enabled()) return;

    const cur = u.state.field(slashStateField, false);
    if (cur) return; // already open — the StateField update path handles refinement

    // Was the most recent change a single `/` insertion?
    let inserted = '';
    let insertPos = -1;
    u.changes.iterChanges((_fA, _tA, fB, tB, ins) => {
      if (insertPos !== -1) return;
      if (ins.length === 0) return;
      inserted = ins.toString();
      insertPos = tB;
      void fB;
    });
    if (inserted !== '/') return;
    const triggerPos = insertPos - 1;

    if (!isTriggerPosition(u.state, triggerPos)) return;
    if (isInsideCodeContext(u.state, triggerPos)) return;

    u.view.dispatch({
      effects: setSlashState.of({
        triggerPos,
        end: insertPos,
        query: '',
        selectedIndex: 0,
      }),
    });
  });
}

// ---------------------------------------------------------------------------
// Keymap — only active when popup is open.
// ---------------------------------------------------------------------------

function navigate(view: EditorView, delta: number): boolean {
  const s = view.state.field(slashStateField, false);
  if (!s) return false;
  const filtered = filterBlocks(SLASH_BLOCKS, s.query);
  if (filtered.length === 0) return true; // swallow but no-op
  const next = (s.selectedIndex + delta + filtered.length) % filtered.length;
  view.dispatch({ effects: setSlashState.of({ ...s, selectedIndex: next }) });
  return true;
}

function dismissPopup(view: EditorView): boolean {
  const s = view.state.field(slashStateField, false);
  if (!s) return false;
  view.dispatch({ effects: setSlashState.of(null) });
  return true;
}

function commitSelected(view: EditorView): boolean {
  const s = view.state.field(slashStateField, false);
  if (!s) return false;
  const filtered = filterBlocks(SLASH_BLOCKS, s.query);
  if (filtered.length === 0) return true; // swallow Enter so we don't insert a newline
  const block = filtered[clampIndex(s.selectedIndex, filtered.length)];
  insertBlock(view, s, block);
  return true;
}

const popupKeymap = Prec.highest(
  keymap.of([
    { key: 'ArrowDown', run: (v) => navigate(v, 1) },
    { key: 'ArrowUp', run: (v) => navigate(v, -1) },
    { key: 'Tab', run: (v) => navigate(v, 1) },
    { key: 'Shift-Tab', run: (v) => navigate(v, -1) },
    { key: 'Enter', run: commitSelected },
    { key: 'Escape', run: dismissPopup },
  ]),
);

// ---------------------------------------------------------------------------
// Theme
// ---------------------------------------------------------------------------

const slashTheme = EditorView.theme({
  '.cm-slash-popup': {
    width: '280px',
    maxHeight: '320px',
    overflowY: 'auto',
    background: 'var(--bg-elevated, var(--bg, #fff))',
    border: '1px solid var(--border, rgba(0, 0, 0, 0.12))',
    borderRadius: '6px',
    boxShadow: '0 8px 24px rgba(0, 0, 0, 0.18)',
    padding: '4px',
    fontSize: '13px',
    fontFamily: 'inherit',
    color: 'var(--text, #222)',
    userSelect: 'none',
  },
  '.cm-slash-row': {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    padding: '6px 8px',
    borderRadius: '4px',
    cursor: 'pointer',
    lineHeight: '1.3',
  },
  '.cm-slash-row--active': {
    background: 'var(--bg-hover, rgba(255, 159, 64, 0.18))',
  },
  '.cm-slash-icon': {
    display: 'inline-flex',
    width: '22px',
    height: '22px',
    minWidth: '22px',
    alignItems: 'center',
    justifyContent: 'center',
    background: 'var(--bg-soft, rgba(0, 0, 0, 0.04))',
    color: 'var(--text-muted, #666)',
    borderRadius: '4px',
    fontFamily: 'var(--font-mono, "JetBrains Mono", Menlo, monospace)',
    fontSize: '11px',
    fontWeight: '600',
  },
  '.cm-slash-label': {
    flex: '1 1 auto',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  '.cm-slash-hint': {
    flex: '0 0 auto',
    color: 'var(--text-faint, #999)',
    fontSize: '11px',
    fontFamily: 'var(--font-mono, "JetBrains Mono", Menlo, monospace)',
  },
  '.cm-slash-empty': {
    padding: '8px 10px',
    color: 'var(--text-faint, #999)',
    fontSize: '12px',
    lineHeight: '1.4',
  },
  // The CM6 tooltip wrapper itself — strip its default chrome so our
  // own panel styling shows through.
  '.cm-tooltip.cm-tooltip-below.cm-slash-tooltip': {
    background: 'transparent',
    border: 'none',
    padding: 0,
    boxShadow: 'none',
  },
});

// ---------------------------------------------------------------------------
// Public extension factory
// ---------------------------------------------------------------------------

/**
 * CodeMirror 6 extension that adds an Affine/Notion-style slash-command
 * popup to a markdown editor.
 *
 *   slashCommandsExtension({ enabled: () => settings.slashCommandsEnabled })
 */
export function slashCommandsExtension(config: SlashCommandsConfig): Extension {
  // We stash the active config in module scope so the popup renderer
  // can read it without each row capturing a closure. Multiple editors
  // in one window would each call this factory and overwrite — that's
  // fine because i18n keys are global and all editors share the same
  // catalog. (If a future feature wants per-editor overrides, swap the
  // module-scope ref for a Facet.)
  activeConfig = config;
  return [slashStateField, makeUpdateListener(config), popupKeymap, slashTheme];
}
