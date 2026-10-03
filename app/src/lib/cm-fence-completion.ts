import { EditorView, keymap } from '@codemirror/view';
import { Prec, type Extension } from '@codemirror/state';
import {
  acceptCompletion,
  completionStatus,
  startCompletion,
  type CompletionContext,
  type CompletionResult,
} from '@codemirror/autocomplete';
// Explicit .ts for the same reason as in fence-languages.ts: fence-languages.test.ts
// loads fenceLanguageComplete with plain `node --test`.
import {
  filterFenceLanguages,
  isInsideFenceBefore,
  matchFenceOpener,
} from './fence-languages.ts';

/**
 * Issue #297 — the fence-language source for the CodeMirror editor.
 *
 * Unlike the other three markdown sources (wikilinks, tags, citations), this
 * one *is* woken by typing: `fenceLanguageExtension` opens it on the third
 * backtick. It also filters the catalogue itself, because CM's built-in filter
 * only looks at `label` and would drop exactly the rows that make aliases
 * useful (`rs` → rust, `py` → python).
 */
export function fenceLanguageComplete(context: CompletionContext): CompletionResult | null {
  // #108: bail during IME composition — see cm-wikilink.ts wikilinkComplete.
  if (context.view?.composing) return null;

  const line = context.state.doc.lineAt(context.pos);
  const opener = matchFenceOpener(context.state.doc.sliceString(line.from, context.pos));
  if (!opener) return null;
  // A closing fence must not offer a language; Enter belongs to the line there.
  if (isInsideFenceBefore(context.state.doc.sliceString(0, line.from))) return null;

  const options = filterFenceLanguages(opener.query).map((lang) => ({
    label: lang.name,
    detail: lang.hint,
    type: lang.special ? 'class' : 'keyword',
  }));
  if (options.length === 0) return null;

  return {
    from: line.from + opener.queryStart,
    to: context.pos,
    options,
    // Already filtered, by alias and keyword as well as by name.
    filter: false,
    validFor: /^[A-Za-z0-9_+.#-]*$/,
  };
}

/**
 * Opens the picker on the third backtick of a line-start fence, and lets Tab
 * accept a row.
 *
 * A trigger of our own rather than `activateOnTyping: true`: that flag wakes
 * *every* source on *every* keystroke, which is the IME-hostile churn the
 * config in Editor.vue deliberately turned off. This only ever fires for the
 * one keystroke that opens a fence.
 */
export function fenceLanguageExtension(enabled: () => boolean = () => true): Extension {
  return [
    EditorView.updateListener.of((update) => {
      if (!enabled() || !update.docChanged || update.view.composing) return;

      const view = update.view;
      // Dispatching straight from an update listener is unsupported, so defer
      // a frame — the same deferral the incremental-find listener in Editor.vue
      // uses for the same reason.
      requestAnimationFrame(() => {
        if (!enabled() || !view.dom.isConnected) return;
        const pos = view.state.selection.main.head;
        const line = view.state.doc.lineAt(pos);
        const opener = matchFenceOpener(view.state.doc.sliceString(line.from, pos));
        if (!opener) return;
        // A closing fence is not a language, and its Enter belongs to the line.
        if (isInsideFenceBefore(view.state.doc.sliceString(0, line.from))) return;

        if (completionStatus(view.state) !== null) {
          // Already open, so re-ask on every keystroke. With `filter: false`
          // and `activateOnTyping: false` CM treats the open options as still
          // valid while the text keeps matching `validFor` and never re-runs
          // the source itself — the list would sit there stale while `rs`
          // typed underneath it, and the first row (mermaid) is what Enter
          // would then insert.
          startCompletion(view);
          return;
        }

        // Closed: open it only for a *typed* backtick, and only when this
        // change is what formed the opener. Checking the query is empty
        // instead would lose a fast typist — by the time the deferred frame
        // runs, a whole ```` ```py ```` can already be in the document — and
        // checking only "is an opener" would re-open the list on every
        // keystroke of someone typing the language by hand after Esc.
        let inserted = '';
        update.changes.iterChanges((_fromA, _toA, _fromB, _toB, ins) => {
          if (!inserted && ins.length) inserted = ins.toString();
        });
        // A paste lands as a longer insertion and is left alone.
        if (inserted !== '`') return;
        const startPos = update.startState.selection.main.head;
        const startLine = update.startState.doc.lineAt(startPos);
        if (matchFenceOpener(update.startState.doc.sliceString(startLine.from, startPos))) {
          return;
        }
        startCompletion(view);
      });
    }),

    // CM binds Ctrl-Space, Enter, Escape, ↑/↓ and PgUp/PgDn for completions but
    // not Tab. Tab already means "indent" here, so this only claims the key
    // while a completion is actually open and hands it straight back otherwise.
    Prec.highest(
      keymap.of([
        {
          key: 'Tab',
          run: (view) =>
            completionStatus(view.state) === 'active' ? acceptCompletion(view) : false,
        },
      ]),
    ),
  ];
}
