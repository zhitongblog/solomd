/**
 * Focus mode & typewriter mode extensions for CodeMirror 6.
 *
 *   - focusModeExtension(): dims every visible line EXCEPT the one(s) that
 *     contain the current selection. Dimming is done with a line decoration
 *     carrying the `cm-line-dimmed` class plus an injected theme defining
 *     that class.
 *   - typewriterModeExtension(): keeps the current cursor line vertically
 *     centered in the viewport on every selection change.
 */

import { RangeSetBuilder } from '@codemirror/state';
import {
  Decoration,
  DecorationSet,
  EditorView,
  ViewPlugin,
  ViewUpdate,
} from '@codemirror/view';

const dimmedLine = Decoration.line({ class: 'cm-line-dimmed' });

const dimTheme = EditorView.theme({
  '.cm-line-dimmed': { opacity: '0.35' },
});

const focusPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;

    constructor(view: EditorView) {
      this.decorations = this.build(view);
    }

    update(update: ViewUpdate) {
      if (
        update.docChanged ||
        update.selectionSet ||
        update.viewportChanged
      ) {
        this.decorations = this.build(update.view);
      }
    }

    build(view: EditorView): DecorationSet {
      const builder = new RangeSetBuilder<Decoration>();
      const doc = view.state.doc;
      // Collect line numbers that hold any selection range's head/anchor.
      const activeLines = new Set<number>();
      for (const range of view.state.selection.ranges) {
        const from = doc.lineAt(range.from).number;
        const to = doc.lineAt(range.to).number;
        for (let n = from; n <= to; n++) activeLines.add(n);
      }

      for (const { from, to } of view.visibleRanges) {
        let pos = from;
        while (pos <= to) {
          const line = doc.lineAt(pos);
          if (!activeLines.has(line.number)) {
            builder.add(line.from, line.from, dimmedLine);
          }
          pos = line.to + 1;
          if (pos > doc.length) break;
        }
      }

      return builder.finish();
    }
  },
  {
    decorations: (v) => v.decorations,
  },
);

export function focusModeExtension() {
  return [dimTheme, focusPlugin];
}

const typewriterPlugin = ViewPlugin.fromClass(
  class {
    constructor(_view: EditorView) {}

    update(update: ViewUpdate) {
      if (!update.selectionSet && !update.docChanged) return;
      // Only react to selection moves (docChanged usually implies
      // selectionSet too; filter redundant scrolls).
      if (!update.selectionSet) return;
      const view = update.view;
      const head = update.state.selection.main.head;
      // Defer to avoid re-entrant dispatch inside an update pass.
      queueMicrotask(() => {
        try {
          view.dispatch({
            effects: EditorView.scrollIntoView(head, { y: 'center' }),
          });
        } catch {
          /* view may have been destroyed */
        }
      });
    }
  },
);

export function typewriterModeExtension() {
  return [typewriterPlugin];
}
