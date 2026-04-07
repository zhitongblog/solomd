/**
 * Task list checkbox interactivity for CodeMirror 6 + lezer-markdown GFM.
 *
 * Walks the syntax tree looking for `TaskMarker` nodes and replaces the
 * literal `[ ]` / `[x]` text with a real <input type="checkbox"> widget.
 * Clicking the checkbox toggles the marker in the underlying doc.
 *
 * Requires the markdown language to be configured with GFM (which is the
 * default when using `markdownLanguage` as the base from
 * `@codemirror/lang-markdown`).
 */

import { syntaxTree } from '@codemirror/language';
import { RangeSetBuilder } from '@codemirror/state';
import {
  Decoration,
  DecorationSet,
  EditorView,
  ViewPlugin,
  ViewUpdate,
  WidgetType,
} from '@codemirror/view';

const TOGGLE_EVENT = 'solomd-task-toggle';

interface ToggleDetail {
  from: number;
  to: number;
  checked: boolean;
}

class TaskWidget extends WidgetType {
  constructor(
    readonly checked: boolean,
    readonly from: number,
    readonly to: number,
  ) {
    super();
  }

  eq(other: TaskWidget): boolean {
    return (
      other.checked === this.checked &&
      other.from === this.from &&
      other.to === this.to
    );
  }

  toDOM(): HTMLElement {
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = this.checked;
    cb.className = 'cm-task-checkbox';
    cb.style.cursor = 'pointer';
    cb.style.verticalAlign = 'middle';
    cb.style.margin = '0 4px 0 0';
    cb.addEventListener('mousedown', (e) => e.preventDefault());
    cb.addEventListener('click', (e) => {
      e.stopPropagation();
      const detail: ToggleDetail = {
        from: this.from,
        to: this.to,
        checked: !this.checked,
      };
      cb.dispatchEvent(
        new CustomEvent<ToggleDetail>(TOGGLE_EVENT, {
          bubbles: true,
          detail,
        }),
      );
    });
    return cb;
  }

  ignoreEvent(): boolean {
    return false;
  }
}

function buildTaskDecorations(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  const doc = view.state.doc;

  for (const { from, to } of view.visibleRanges) {
    syntaxTree(view.state).iterate({
      from,
      to,
      enter: (node) => {
        if (node.name !== 'TaskMarker') return;
        // Text is either "[ ]" or "[x]"/"[X]".
        const text = doc.sliceString(node.from, node.to);
        const checked = /\[[xX]\]/.test(text);
        builder.add(
          node.from,
          node.to,
          Decoration.replace({
            widget: new TaskWidget(checked, node.from, node.to),
          }),
        );
      },
    });
  }

  return builder.finish();
}

export function taskListExtension() {
  const plugin = ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      private readonly onToggle: (ev: Event) => void;
      private readonly view: EditorView;

      constructor(view: EditorView) {
        this.view = view;
        this.decorations = buildTaskDecorations(view);
        this.onToggle = (ev: Event) => {
          const ce = ev as CustomEvent<ToggleDetail>;
          const d = ce.detail;
          if (!d) return;
          if (d.to > view.state.doc.length) return;
          const current = view.state.doc.sliceString(d.from, d.to);
          if (!/^\[[ xX]\]$/.test(current)) return;
          const replacement = d.checked ? '[x]' : '[ ]';
          view.dispatch({
            changes: { from: d.from, to: d.to, insert: replacement },
          });
        };
        view.dom.addEventListener(TOGGLE_EVENT, this.onToggle);
      }

      update(update: ViewUpdate) {
        if (
          update.docChanged ||
          update.viewportChanged ||
          syntaxTree(update.startState) !== syntaxTree(update.state)
        ) {
          this.decorations = buildTaskDecorations(update.view);
        }
      }

      destroy() {
        this.view.dom.removeEventListener(TOGGLE_EVENT, this.onToggle);
      }
    },
    {
      decorations: (v) => v.decorations,
    },
  );

  return [plugin];
}
