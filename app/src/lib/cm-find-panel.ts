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
import {
  EditorSelection,
  type EditorState,
  type SelectionRange,
  type Transaction,
} from '@codemirror/state';
import { runScopeHandlers, type EditorView, type Panel, type ViewUpdate } from '@codemirror/view';

export interface FindPanelLabels {
  find: string;
  replace: string;
  toggleReplace?: string;
  prev: string;
  next: string;
  matchCase: string;
  regexp: string;
  wholeWord: string;
  replaceOne: string;
  replaceAll: string;
  close: string;
}

/**
 * #419 — Expand or collapse the Replace row inside an open `.cm-find` panel.
 */
export function setFindPanelReplaceExpanded(host: ParentNode, open: boolean): void {
  const panel = host.querySelector<HTMLElement>('.cm-find');
  if (!panel) return;
  const row = panel.querySelector<HTMLElement>('.cm-find__row--replace');
  const btn = panel.querySelector<HTMLButtonElement>('button[name="toggleReplace"]');
  if (!row || !btn) return;
  row.hidden = !open;
  panel.classList.toggle('cm-find--replace-open', open);
  btn.textContent = open ? '▾' : '▸';
  btn.setAttribute('aria-expanded', String(open));
}

/**
 * #436 — Select all occurrences of the current selection (or word at caret)
 * across the document, even when multiple cursors are already active (unlike
 * `@codemirror/search`'s `selectSelectionMatches`, which bails out whenever
 * `ranges.length > 1` or `main.empty`).
 */
export function selectAllOccurrencesCommand(target: {
  state: EditorState;
  dispatch: (tr: Transaction) => void;
}): boolean {
  const { state } = target;
  let main = state.selection.main;
  if (main.empty) {
    const word = state.wordAt(main.head);
    if (!word) return false;
    main = EditorSelection.range(word.from, word.to);
  }
  const needle = state.sliceDoc(main.from, main.to);
  if (!needle || needle.includes('\n')) return false;
  const query = new SearchQuery({ search: needle });
  if (!query.valid) return false;
  const ranges: SelectionRange[] = [];
  let mainIdx = 0;
  const cur = query.getCursor(state, 0);
  for (let step = cur.next(); !step.done; step = cur.next()) {
    if (ranges.length >= COUNT_LIMIT) break;
    if (step.value.from === main.from) mainIdx = ranges.length;
    ranges.push(EditorSelection.range(step.value.from, step.value.to));
  }
  if (ranges.length === 0) return false;
  target.dispatch(
    state.update({
      selection: EditorSelection.create(ranges, mainIdx),
      userEvent: 'select.search.matches',
    }),
  );
  return true;
}

/** Stop counting here — "1000+" is all anyone needs past that. */
const COUNT_LIMIT = 1000;
/** Debounce live-typing query commits on large documents so rapid typing never stalls. */
const LARGE_DOC_DEBOUNCE_CHARS = 24_000;
const LARGE_DOC_DEBOUNCE_MS = 60;

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
  const beforeLen = view.state.doc.length;
  const replaced = replaceNext(view);
  // Guard zero-length regexp matches (`^`, `$`, `\b`, `a*`): if `target.from === target.to`
  // and `replaceNext` left the selection anchored at the same origin, advance by 1
  // past the inserted text so repeated Replace clicks progress instead of looping.
  if (replaced && target.from === target.to) {
    const delta = Math.max(0, view.state.doc.length - beforeLen);
    const curSel = view.state.selection.main;
    if (curSel.from <= target.from + delta && curSel.empty) {
      const nextAnchor = Math.min(view.state.doc.length, target.from + delta + 1);
      const nextHit = matchFrom(view.state, query, nextAnchor);
      if (nextHit && nextHit.from >= nextAnchor) {
        view.dispatch({ selection: { anchor: nextHit.from, head: nextHit.to } });
      }
    }
  }
  return replaced;
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
    const b = iconBtn(name, title, glyph, () => {
      flushPendingCommit();
      commit({ [key]: !query[key] });
    });
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

  let replaceRow: HTMLDivElement | null = null;
  let expandBtn: HTMLButtonElement | null = null;
  const isReplaceOpen = () => !!replaceRow && !replaceRow.hidden;

  const setReplaceOpen = (open: boolean) => {
    if (replaceRow) replaceRow.hidden = !open;
    dom.classList.toggle('cm-find--replace-open', open);
    if (expandBtn) {
      expandBtn.textContent = open ? '▾' : '▸';
      expandBtn.setAttribute('aria-expanded', String(open));
    }
  };

  const findRow = el('div', { class: 'cm-find__row' });
  if (!view.state.readOnly) {
    expandBtn = iconBtn(
      'toggleReplace',
      labels.toggleReplace || labels.replace,
      '▸',
      () => {
        const next = !isReplaceOpen();
        setReplaceOpen(next);
        if (!next && document.activeElement === replaceField) {
          findField.focus();
        }
      },
    );
    expandBtn.setAttribute('aria-expanded', 'false');
    findRow.append(expandBtn);
  }
  findRow.append(
    findField,
    count,
    iconBtn('prev', labels.prev, '‹', () => {
      flushPendingCommit();
      findPrevious(view);
    }),
    iconBtn('next', labels.next, '›', () => {
      flushPendingCommit();
      findNext(view);
    }),
    caseBtn,
    reBtn,
    wordBtn,
    iconBtn('close', labels.close, '✕', () => {
      clearCommitTimer();
      closeSearchPanel(view);
      view.focus();
    }),
  );
  const dom = el('div', { class: 'cm-search cm-find', role: 'search' });
  dom.append(findRow);
  if (!view.state.readOnly) {
    replaceRow = el('div', { class: 'cm-find__row cm-find__row--replace' });
    replaceRow.hidden = true;
    replaceRow.append(
      replaceField,
      textBtn('replace', labels.replaceOne, () => {
        flushPendingCommit();
        replaceCurrent(view);
      }),
      textBtn('replaceAll', labels.replaceAll, () => {
        flushPendingCommit();
        replaceAll(view);
      }),
    );
    dom.append(replaceRow);
  }

  let commitTimer: ReturnType<typeof setTimeout> | null = null;
  let recountTimer: ReturnType<typeof setTimeout> | null = null;
  function clearCommitTimer() {
    if (commitTimer !== null) {
      clearTimeout(commitTimer);
      commitTimer = null;
    }
    if (recountTimer !== null) {
      clearTimeout(recountTimer);
      recountTimer = null;
    }
  }
  function flushPendingCommit() {
    if (commitTimer !== null) {
      clearTimeout(commitTimer);
      commitTimer = null;
      commit();
    }
  }

  function commit(patch: Partial<{ caseSensitive: boolean; regexp: boolean; wholeWord: boolean }> = {}) {
    clearCommitTimer();
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

  function scheduleInputCommit() {
    if (
      findField.value.length > 0 &&
      (view.state.doc.length > LARGE_DOC_DEBOUNCE_CHARS || query.regexp)
    ) {
      if (commitTimer !== null) clearTimeout(commitTimer);
      commitTimer = setTimeout(() => {
        commitTimer = null;
        commit();
      }, LARGE_DOC_DEBOUNCE_MS);
      return;
    }
    commit();
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
      scheduleInputCommit();
    });
  }

  dom.addEventListener('keydown', (e) => {
    // An Enter that confirms an IME candidate is not "next match".
    if (e.isComposing || e.keyCode === 229) return;
    // #389 — pressing Ctrl+F / Cmd+F again while the search box is focused
    // closes the search panel and returns focus to the editor.
    if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey) {
      const k = e.key.toLowerCase();
      if (k === 'f' || e.code === 'KeyF') {
        e.preventDefault();
        e.stopPropagation();
        if (e.target === replaceField) {
          findField.focus();
          findField.select();
        } else {
          clearCommitTimer();
          closeSearchPanel(view);
          view.focus();
        }
        return;
      }
      if (k === 'h' || e.code === 'KeyH') {
        e.preventDefault();
        e.stopPropagation();
        if (!isReplaceOpen()) {
          setReplaceOpen(true);
          replaceField.focus();
          replaceField.select();
        } else if (e.target === replaceField) {
          clearCommitTimer();
          closeSearchPanel(view);
          view.focus();
        } else {
          replaceField.focus();
          replaceField.select();
        }
        return;
      }
    }
    if (runScopeHandlers(view, e, 'search-panel')) {
      clearCommitTimer();
      e.preventDefault();
      return;
    }
    if (e.key === 'Enter' && e.target === findField) {
      e.preventDefault();
      flushPendingCommit();
      (e.shiftKey ? findPrevious : findNext)(view);
    } else if (e.key === 'Enter' && e.target === replaceField) {
      e.preventDefault();
      flushPendingCommit();
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
    destroy() {
      clearCommitTimer();
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
      if (queryChanged) {
        if (recountTimer !== null) {
          clearTimeout(recountTimer);
          recountTimer = null;
        }
        recount();
      } else if (update.docChanged) {
        if (update.state.doc.length > LARGE_DOC_DEBOUNCE_CHARS) {
          if (recountTimer !== null) clearTimeout(recountTimer);
          recountTimer = setTimeout(() => {
            recountTimer = null;
            recount();
          }, 120);
        } else {
          recount();
        }
      } else if (update.selectionSet) {
        renderCount();
      }
    },
  };
}
