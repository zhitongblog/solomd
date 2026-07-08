/**
 * Theme companion for `cm-spellcheck.ts` (F2 of v2.0).
 *
 * Adds the `.cm-misspelled` class — a red wavy underline that hugs the
 * misspelled word without altering its color or font weight. We use
 * `text-decoration: underline wavy` (broadly supported in modern WebKit /
 * Chromium / WebView2) plus a fallback `text-decoration-skip-ink: none` so
 * the wave doesn't get clipped under descenders like `g`/`y`/`p`.
 *
 * Exported as a CodeMirror `Extension` so callers can spread it into their
 * editor extensions array next to `spellcheckExtension(...)`.
 */

import { EditorView } from '@codemirror/view';
import type { Extension } from '@codemirror/state';

export const spellcheckTheme: Extension = EditorView.theme({
  '.cm-misspelled': {
    textDecoration: 'underline wavy red',
    textDecorationSkipInk: 'none',
    // Keep underline thickness consistent across platforms — Safari renders
    // the wave noticeably thicker than Chromium otherwise.
    textDecorationThickness: '1px',
    // Avoid cursor-style changes; the highlight is cosmetic, not interactive.
    cursor: 'inherit',
  },
});
