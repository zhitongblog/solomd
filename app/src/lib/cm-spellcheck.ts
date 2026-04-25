/**
 * CodeMirror 6 spell-check extension (F2 of v2.0).
 *
 * Walks the visible viewport, splits each line into Latin word runs in Rust
 * (`spellcheck_check`), and decorates misspellings with the `.cm-misspelled`
 * mark class (a red wavy underline — see `cm-spellcheck-theme.ts`).
 *
 * Performance:
 *   - Only the lines currently in the viewport are sent to Rust.
 *   - Each line's misspellings are cached keyed by the line's text. On doc
 *     changes, lines whose text didn't change reuse cached results; only
 *     edited lines round-trip to Rust.
 *   - Calls are debounced 300 ms so fast typing doesn't flood the bridge.
 *
 * The plugin is gated by an `enabled()` callback so the parent can wire it
 * up to a setting (`spellcheckEnabled`, default `false`) without rebuilding
 * the editor when the toggle flips. When `enabled()` returns false the
 * decoration set is empty.
 */

import { invoke } from '@tauri-apps/api/core';
import { RangeSetBuilder } from '@codemirror/state';
import type { Extension } from '@codemirror/state';
import {
  Decoration,
  EditorView,
  ViewPlugin,
  ViewUpdate,
} from '@codemirror/view';
import type { DecorationSet } from '@codemirror/view';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Misspelling {
  word: string;
  start: number; // byte offsets within the *line* text we sent to Rust
  end: number;
}

interface SpellcheckOptions {
  enabled: () => boolean;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Convert a byte offset (returned by the Rust regex over UTF-8 bytes) to a
 * UTF-16 code-unit offset (what CodeMirror works in).
 *
 * This matters because the doc may contain multi-byte chars (CJK, emoji).
 * The Rust side only flags Latin runs, but we still receive byte offsets,
 * and those Latin runs may sit *after* multi-byte chars on the same line.
 */
function byteToCharOffset(text: string, byteOffset: number): number {
  if (byteOffset <= 0) return 0;
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    if (bytes >= byteOffset) return i;
    const code = text.charCodeAt(i);
    if (code < 0x80) {
      bytes += 1;
    } else if (code < 0x800) {
      bytes += 2;
    } else if (code >= 0xd800 && code <= 0xdbff) {
      // High surrogate of a 4-byte UTF-8 char — count both halves together.
      bytes += 4;
      i++;
    } else {
      bytes += 3;
    }
  }
  return text.length;
}

const misspelledMark = Decoration.mark({ class: 'cm-misspelled' });

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

export function spellcheckExtension(opts: SpellcheckOptions): Extension {
  const plugin = ViewPlugin.fromClass(
    class {
      decorations: DecorationSet = Decoration.none;
      /** Per-line cache: key = line text, value = misspellings (char offsets, line-relative). */
      private cache = new Map<string, Misspelling[]>();
      private timer: ReturnType<typeof setTimeout> | null = null;
      private destroyed = false;

      constructor(private view: EditorView) {
        this.schedule();
      }

      update(update: ViewUpdate) {
        // Re-spell on doc edits, viewport scroll, or geometry shifts (font
        // resize, panel toggle…). Selection-only changes don't matter.
        if (
          update.docChanged ||
          update.viewportChanged ||
          update.geometryChanged
        ) {
          this.schedule();
        }
      }

      destroy() {
        this.destroyed = true;
        if (this.timer) {
          clearTimeout(this.timer);
          this.timer = null;
        }
      }

      private schedule() {
        if (this.timer) clearTimeout(this.timer);
        this.timer = setTimeout(() => {
          this.timer = null;
          if (this.destroyed) return;
          void this.recompute();
        }, 300);
      }

      private async recompute() {
        if (!opts.enabled()) {
          if (this.decorations.size > 0) {
            this.decorations = Decoration.none;
            this.view.requestMeasure();
          }
          return;
        }

        const view = this.view;
        const doc = view.state.doc;

        // Determine which line numbers are visible (1-based in CM6 doc API).
        const visibleLines = new Set<number>();
        for (const range of view.visibleRanges) {
          const startLine = doc.lineAt(range.from).number;
          const endLine = doc.lineAt(range.to).number;
          for (let n = startLine; n <= endLine; n++) {
            visibleLines.add(n);
          }
        }

        // Per visible line: use cache if text matches, else invoke Rust.
        type LineResult = { from: number; misses: Misspelling[] };
        const results: LineResult[] = [];

        for (const lineNo of visibleLines) {
          if (lineNo < 1 || lineNo > doc.lines) continue;
          const line = doc.line(lineNo);
          const text = line.text;
          if (text.length === 0) continue;

          // Cheap pre-filter: skip lines with no Latin letters at all.
          if (!/[A-Za-z]/.test(text)) {
            this.cache.set(text, []);
            continue;
          }

          const cached = this.cache.get(text);
          let misses: Misspelling[];
          if (cached) {
            misses = cached;
          } else {
            try {
              const raw = await invoke<Misspelling[]>('spellcheck_check', { text });
              // Convert byte offsets → UTF-16 char offsets.
              misses = raw.map((m: Misspelling) => ({
                word: m.word,
                start: byteToCharOffset(text, m.start),
                end: byteToCharOffset(text, m.end),
              }));
            } catch {
              misses = [];
            }
            this.cache.set(text, misses);
            // Bail out if the editor was destroyed while awaiting.
            if (this.destroyed) return;
          }
          if (misses.length > 0) {
            results.push({ from: line.from, misses });
          }
        }

        // Build decorations in document order. Iterate visible lines sorted
        // ascending so the RangeSetBuilder sees ranges in order.
        results.sort((a, b) => a.from - b.from);
        const builder = new RangeSetBuilder<Decoration>();
        for (const { from, misses } of results) {
          // Misses within a line are already in order (regex iteration), but
          // double-check just in case.
          const ordered = misses
            .slice()
            .sort((a, b) => a.start - b.start);
          for (const m of ordered) {
            const start = from + m.start;
            const end = from + m.end;
            if (end <= start) continue;
            if (end > view.state.doc.length) continue;
            builder.add(start, end, misspelledMark);
          }
        }
        this.decorations = builder.finish();
        // Trigger a redraw — `update()` itself doesn't run after we mutate
        // outside its lifecycle, so we ask CM to re-measure.
        this.view.requestMeasure();
      }
    },
    {
      decorations: (v) => v.decorations,
    },
  );

  return [plugin];
}
