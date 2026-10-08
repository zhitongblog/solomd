/**
 * 5.0 — the CodeMirror find bar, drawn like the Windows plain editor's
 * (Editor.vue `.plain-find`) instead of @codemirror/search's stock panel.
 *
 * The stock panel is English-only text buttons, bare checkboxes and a `<br>`,
 * unstyled — fine for a code editor, out of place in 5.0 (a tester saw it the
 * first time CodeMirror became the Windows default). Only the UI is ours:
 * the query, highlighting, next/previous and replace are @codemirror/search's
 * own commands, so behaviour matches what shipped.
 *
 * Contract kept from the stock panel, because other code relies on it:
 * - the root has class `cm-search`; the fields are `input[name=search]`
 *   (with `main-field`, which `openSearchPanel` focuses) and
 *   `input[name=replace]` (Editor.vue `openFind(replace)` focuses it);
 * - Enter / Shift+Enter in the find field step through matches, Enter in the
 *   replace field replaces, Esc closes (the `search-panel` keymap scope).
 *
 * Input-method safe: the query is not touched while a composition is open —
 * otherwise the half-typed pinyin becomes the search for a moment (#330).
 */
import {
  SearchQuery,
  closeSearchPanel,
  findNext,
  findPrevious,
  getSearchQuery,
  replaceAll,
  replaceNext,
  setSearchQuery,
} from '@codemirror/search';
import type { EditorState } from '@codemirror/state';
import { runScopeHandlers, type EditorView, type Panel, type ViewUpdate } from '@codemirror/view';

export interface FindPanelLabels {
  find: string;
  replace: string;
  prev: string;
  next: string;
  matchCase: string;
  regexp: string;
  wholeWord: string;
  replaceOne: string;
  replaceAll: string;
  close: string;
}

/** Stop counting here — "1000+" is all anyone needs past that. */
const COUNT_LIMIT = 1000;

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string> = {},
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  if (text !== undefined) node.textContent = text;
  return node;
}

/** The first match starting at or after `pos`, wrapping to the top. */
export function matchFrom(state: EditorState, query: SearchQuery, pos: number): { from: number; to: number } | null {
  if (!query.search || !query.valid) return null;
  for (const start of [pos, 0]) {
    const m = query.getCursor(state, start).next();
    if (!m.done) return { from: m.value.from, to: m.value.to };
  }
  return null;
}

/**
 * Replace (one), as VS Code does it: replace the current match and go to the
 * next. @codemirror/search's `replaceNext` only replaces a match that is
 * *exactly* selected; with the caret merely at one — the counter already
 * reading "1/2" — the first click just selected it and only the second
 * replaced (5.0 regression run, C2). So select the match at / after the caret
 * first, then let `replaceNext` replace it and move on.
 */
export function replaceCurrent(view: EditorView): boolean {
  const { state } = view;
  if (state.readOnly) return false;
  const query = getSearchQuery(state);
  const { from, to } = state.selection.main;
  const target = matchFrom(state, query, from);
  if (!target) return false;
  if (target.from !== from || target.to !== to) {
    view.dispatch({ selection: { anchor: target.from, head: target.to } });
  }
  return replaceNext(view);
}

export function createFindPanel(view: EditorView, labels: FindPanelLabels): Panel {
  let query = getSearchQuery(view.state);
  let composing = false;
  let matches: number[] = [];
  let truncated = false;

  const findField = el('input', {
    class: 'cm-textfield cm-find__input',
    name: 'search',
    'main-field': 'true',
    placeholder: labels.find,
    'aria-label': labels.find,
    autocomplete: 'off',
    spellcheck: 'false',
  });
  const replaceField = el('input', {
    class: 'cm-textfield cm-find__input',
    name: 'replace',
    placeholder: labels.replace,
    'aria-label': labels.replace,
    autocomplete: 'off',
    spellcheck: 'false',
  });
  findField.value = query.search;
  replaceField.value = query.replace;

  const count = el('span', { class: 'cm-find__count', 'aria-live': 'polite' });

  const iconBtn = (name: string, title: string, glyph: string, onClick: () => void) => {
    const b = el('button', { type: 'button', class: 'cm-find__btn', name, title, 'aria-label': title }, glyph);
    // mousedown.prevent: the caret stays in whichever field the user was in.
    b.addEventListener('mousedown', (e) => e.preventDefault());
    b.addEventListener('click', onClick);
    return b;
  };
  const toggle = (name: string, title: string, glyph: string, key: 'caseSensitive' | 'regexp' | 'wholeWord') => {
    const b = iconBtn(name, title, glyph, () => commit({ [key]: !query[key] }));
    b.setAttribute('aria-pressed', 'false');
    return b;
  };
  const textBtn = (name: string, label: string, onClick: () => void) => {
    const b = el('button', { type: 'button', class: 'cm-find__btn cm-find__btn--text', name }, label);
    b.addEventListener('mousedown', (e) => e.preventDefault());
    b.addEventListener('click', onClick);
    return b;
  };

  const caseBtn = toggle('case', labels.matchCase, 'Aa', 'caseSensitive');
  const reBtn = toggle('re', labels.regexp, '.*', 'regexp');
  const wordBtn = toggle('word', labels.wholeWord, 'W', 'wholeWord');

  const findRow = el('div', { class: 'cm-find__row' });
  findRow.append(
    findField,
    count,
    iconBtn('prev', labels.prev, '‹', () => findPrevious(view)),
    iconBtn('next', labels.next, '›', () => findNext(view)),
    caseBtn,
    reBtn,
    wordBtn,
    iconBtn('close', labels.close, '✕', () => {
      closeSearchPanel(view);
      view.focus();
    }),
  );
  const dom = el('div', { class: 'cm-search cm-find', role: 'search' });
  dom.append(findRow);
  if (!view.state.readOnly) {
    const replaceRow = el('div', { class: 'cm-find__row' });
    replaceRow.append(
      replaceField,
      textBtn('replace', labels.replaceOne, () => replaceCurrent(view)),
      textBtn('replaceAll', labels.replaceAll, () => replaceAll(view)),
    );
    dom.append(replaceRow);
  }

  function commit(patch: Partial<{ caseSensitive: boolean; regexp: boolean; wholeWord: boolean }> = {}) {
    const next = new SearchQuery({
      search: findField.value,
      replace: replaceField.value,
      caseSensitive: patch.caseSensitive ?? query.caseSensitive,
      regexp: patch.regexp ?? query.regexp,
      wholeWord: patch.wholeWord ?? query.wholeWord,
      literal: query.literal,
    });
    if (!next.eq(query)) view.dispatch({ effects: setSearchQuery.of(next) });
  }

  function recount() {
    matches = [];
    truncated = false;
    if (query.search && query.valid) {
      const cursor = query.getCursor(view.state);
      for (let m = cursor.next(); !m.done; m = cursor.next()) {
        if (matches.length >= COUNT_LIMIT) {
          truncated = true;
          break;
        }
        matches.push(m.value.from);
      }
    }
    renderCount();
  }

  function renderCount() {
    const invalid = !!query.search && !query.valid;
    dom.classList.toggle('cm-find--invalid', invalid);
    dom.classList.toggle('cm-find--none', !!query.search && query.valid && matches.length === 0);
    if (!query.search || invalid) {
      count.textContent = '';
      return;
    }
    const head = view.state.selection.main.from;
    const i = matches.indexOf(head);
    const total = truncated ? `${COUNT_LIMIT}+` : String(matches.length);
    count.textContent = i >= 0 ? `${i + 1}/${total}` : `0/${total}`;
  }

  function syncToggles() {
    caseBtn.setAttribute('aria-pressed', String(query.caseSensitive));
    reBtn.setAttribute('aria-pressed', String(query.regexp));
    wordBtn.setAttribute('aria-pressed', String(query.wholeWord));
  }

  for (const field of [findField, replaceField]) {
    field.addEventListener('compositionstart', () => (composing = true));
    field.addEventListener('compositionend', () => {
      composing = false;
      commit();
    });
    field.addEventListener('input', (e) => {
      if (composing || (e as InputEvent).isComposing) return;
      commit();
    });
  }

  dom.addEventListener('keydown', (e) => {
    // An Enter that confirms an IME candidate is not "next match".
    if (e.isComposing || e.keyCode === 229) return;
    if (runScopeHandlers(view, e, 'search-panel')) {
      e.preventDefault();
      return;
    }
    if (e.key === 'Enter' && e.target === findField) {
      e.preventDefault();
      (e.shiftKey ? findPrevious : findNext)(view);
    } else if (e.key === 'Enter' && e.target === replaceField) {
      e.preventDefault();
      replaceCurrent(view);
    }
  });

  syncToggles();
  recount();

  return {
    dom,
    top: true,
    // As the stock panel: a fresh bar takes the caret, text selected.
    mount() {
      findField.select();
    },
    update(update: ViewUpdate) {
      let queryChanged = false;
      for (const tr of update.transactions) {
        for (const effect of tr.effects) {
          if (effect.is(setSearchQuery) && !effect.value.eq(query)) {
            query = effect.value;
            queryChanged = true;
          }
        }
      }
      if (queryChanged) {
        // Set from outside (openSearchPanel's selection prefill, Ctrl+H):
        // show it, but never rewrite a field mid-composition.
        if (!composing) {
          if (findField.value !== query.search) findField.value = query.search;
          if (replaceField.value !== query.replace) replaceField.value = query.replace;
        }
        syncToggles();
      }
      if (queryChanged || update.docChanged) recount();
      else if (update.selectionSet) renderCount();
    },
  };
}
