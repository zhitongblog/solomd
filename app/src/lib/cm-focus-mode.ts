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
      // Expand active line set to the full paragraph (block of contiguous
      // non-empty lines) the cursor is in. Empty lines act as separators.
      const activeLines = new Set<number>();
      const isBlank = (n: number) => doc.line(n).text.trim().length === 0;
      for (const range of view.state.selection.ranges) {
        const from = doc.lineAt(range.from).number;
        const to = doc.lineAt(range.to).number;
        for (let n = from; n <= to; n++) activeLines.add(n);
        // Walk up until a blank line (paragraph start).
        let up = from - 1;
        while (up >= 1 && !isBlank(up)) {
          activeLines.add(up);
          up--;
        }
        // Walk down until a blank line (paragraph end).
        let down = to + 1;
        while (down <= doc.lines && !isBlank(down)) {
          activeLines.add(down);
          down++;
        }
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
