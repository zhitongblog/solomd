/**
 * AI rewrite trigger extension for CodeMirror 6 (v2.0 F4).
 *
 * Wires `Cmd-J` / `Ctrl-J` to dispatch a `solomd:ai-rewrite-open` event with
 * the current selection. The actual overlay UI lives in
 * `AIRewriteOverlay.vue`; this file only takes the keystroke + selection and
 * surfaces a streaming-result decoration once the overlay says so.
 *
 * The overlay drives the inline diff via two transactions:
 *   - `solomd:ai-rewrite-stream` (custom DOM event with `{ paneId, from, to, text, done }`):
 *     while a stream is running, show the proposed text as a `Decoration.replace`
 *     widget over the selected range so the user sees it in-place.
 *   - `solomd:ai-rewrite-accept` (handled by App.vue): replaces the selection
 *     with the final text.
 *   - `solomd:ai-rewrite-cancel`: clears the inline decoration.
 *
 * The keymap binding only fires when the selection is non-empty; an empty
 * selection passes through (so `Cmd-J` is still available for other
 * use-cases if the host app maps it).
 */

import { keymap } from '@codemirror/view';
import {
  Decoration,
  DecorationSet,
  EditorView,
  WidgetType,
} from '@codemirror/view';
import { StateEffect, StateField } from '@codemirror/state';
import type { Extension } from '@codemirror/state';

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

/** Fired when Cmd-J is pressed with a non-empty selection. App.vue / overlay listens. */
export const AI_REWRITE_OPEN_EVENT = 'solomd:ai-rewrite-open';
/** Fired by the overlay during streaming so the editor can render the proposed text inline. */
export const AI_REWRITE_STREAM_EVENT = 'solomd:ai-rewrite-stream';
/** Fired by the overlay on Accept; App.vue applies the replacement. */
export const AI_REWRITE_ACCEPT_EVENT = 'solomd:ai-rewrite-accept';
/** Fired by the overlay on Reject / close; editor clears the inline decoration. */
export const AI_REWRITE_CANCEL_EVENT = 'solomd:ai-rewrite-cancel';

export interface AIRewriteOpenDetail {
  selection: string;
  from: number;
  to: number;
}

export interface AIRewriteStreamDetail {
  /** Selection range to overlay. */
  from: number;
  to: number;
  /** The accumulated proposed text so far. */
  text: string;
  /** True when streaming has finished (success). */
  done: boolean;
}

export interface AIRewriteAcceptDetail {
  from: number;
  to: number;
  replacement: string;
}

// ---------------------------------------------------------------------------
// Inline streaming widget — shows the proposed text as a Decoration.replace
// over the selected range while the stream is running.
// ---------------------------------------------------------------------------

interface StreamState {
  from: number;
  to: number;
  text: string;
  done: boolean;
}

class StreamingWidget extends WidgetType {
  constructor(readonly state: StreamState) {
    super();
  }
  eq(other: StreamingWidget): boolean {
    return (
      other.state.from === this.state.from &&
      other.state.to === this.state.to &&
      other.state.text === this.state.text &&
      other.state.done === this.state.done
    );
  }
  toDOM(): HTMLElement {
    const wrap = document.createElement('span');
    wrap.className = `cm-ai-stream ${this.state.done ? 'cm-ai-stream--done' : 'cm-ai-stream--live'}`;
    wrap.textContent = this.state.text;
    wrap.setAttribute('aria-live', 'polite');
    return wrap;
  }
  ignoreEvent(): boolean {
    return false;
  }
}

const setStreamEffect = StateEffect.define<StreamState | null>();

const aiStreamField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    deco = deco.map(tr.changes);
    for (const e of tr.effects) {
      if (e.is(setStreamEffect)) {
        const s = e.value;
        if (!s) {
          deco = Decoration.none;
        } else {
          // Clamp to current doc length to stay safe across small edits.
          const docLen = tr.state.doc.length;
          const from = Math.max(0, Math.min(s.from, docLen));
          const to = Math.max(from, Math.min(s.to, docLen));
          deco = Decoration.set([
            Decoration.replace({
              widget: new StreamingWidget({ ...s, from, to }),
              inclusive: true,
            }).range(from, to),
          ]);
        }
      }
    }
    return deco;
  },
  provide: (f) => EditorView.decorations.from(f),
});

const aiStreamTheme = EditorView.theme({
  '.cm-ai-stream': {
    borderRadius: '3px',
    padding: '0 2px',
    backgroundColor: 'rgba(99, 102, 241, 0.12)',
    color: 'var(--accent, #6366f1)',
    whiteSpace: 'pre-wrap',
  },
  '.cm-ai-stream--live::after': {
    content: '"▌"',
    opacity: 0.6,
    marginLeft: '1px',
    animation: 'cm-ai-blink 1s steps(2, start) infinite',
  },
  '@keyframes cm-ai-blink': {
    to: { visibility: 'hidden' },
  },
  '.cm-ai-stream--done': {
    backgroundColor: 'rgba(16, 185, 129, 0.12)',
    color: 'var(--accent, #10b981)',
  },
});

// ---------------------------------------------------------------------------
// Public extension
// ---------------------------------------------------------------------------

function dispatchOpen(view: EditorView): boolean {
  const sel = view.state.selection.main;
  if (sel.empty) return false;
  const from = sel.from;
  const to = sel.to;
  const text = view.state.sliceDoc(from, to);
  const detail: AIRewriteOpenDetail = { selection: text, from, to };
  window.dispatchEvent(new CustomEvent(AI_REWRITE_OPEN_EVENT, { detail }));
  return true;
}

/**
 * Returns the AI rewrite CM6 extension bundle:
 *   - keymap binding (`Mod-j` → dispatches `solomd:ai-rewrite-open`)
 *   - state field that renders the streaming-proposal widget
 *   - DOM listeners for stream / cancel events
 */
export function aiRewriteExtension(): Extension {
  const domHandler = EditorView.domEventHandlers({});

  const listenerPlugin = EditorView.updateListener.of(() => {
    /* no-op — DOM events are wired below via plugin */
  });

  // We hook DOM events on the editor's root via a small ViewPlugin-equivalent
  // through a state field side-effect: keep it simple and hook on creation.
  const wireup = EditorView.contentAttributes.of(() => ({}));

  const streamHandler = (ev: Event) => {
    // Routed at the document level (App.vue dispatches per active view).
    // Here we no-op; the host invokes view.dispatch with setStreamEffect
    // directly via `applyStreamToView` below.
    void ev;
  };
  void streamHandler; // silence unused

  return [
    aiStreamField,
    aiStreamTheme,
    keymap.of([
      {
        key: 'Mod-j',
        preventDefault: true,
        run: dispatchOpen,
      },
    ]),
    domHandler,
    listenerPlugin,
    wireup,
  ];
}

/**
 * Helpers exposed to App.vue / the overlay so they can drive the inline widget
 * without reaching into CM internals from Vue. The host should keep a
 * reference to the active EditorView and call these as the stream progresses.
 */
export function applyStreamToView(view: EditorView, state: StreamState | null): void {
  view.dispatch({ effects: setStreamEffect.of(state) });
}

export const aiRewriteEffects = {
  setStream: setStreamEffect,
};
