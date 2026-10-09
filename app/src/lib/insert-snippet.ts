/**
 * Insert-menu snippet markers (the File/Paragraph Insert menu, the toolbar's
 * Insert dropdown).
 *
 *   `$|$`             — the caret lands here (marker stripped).
 *   `$|$Label$|$`     — two markers: the text between them is inserted and
 *                       left selected, so the first keystroke replaces it.
 *
 * The placeholder form exists so a snippet can be *valid as inserted*: the
 * Mermaid template used to be `A[$|$]`, and an empty `A[]` is a mermaid
 * syntax error the moment the user switches to Preview without typing.
 *
 * No marker → the caret goes to the end of the inserted text.
 */
export const CARET_MARKER = '$|$';

export interface ParsedSnippet {
  /** Text to insert, markers removed. */
  text: string;
  /** Selection anchor, as an offset into `text`. */
  anchor: number;
  /** Selection head (== anchor for a plain caret). */
  head: number;
}

export function parseInsertSnippet(snippet: string): ParsedSnippet {
  const first = snippet.indexOf(CARET_MARKER);
  if (first < 0) return { text: snippet, anchor: snippet.length, head: snippet.length };
  const rest = snippet.slice(first + CARET_MARKER.length);
  const second = rest.indexOf(CARET_MARKER);
  if (second < 0) {
    const text = snippet.slice(0, first) + rest;
    return { text, anchor: first, head: first };
  }
  const text = snippet.slice(0, first) + rest.slice(0, second) + rest.slice(second + CARET_MARKER.length);
  return { text, anchor: first, head: first + second };
}

/** The Insert > Mermaid template: a valid two-node flowchart with the first
 *  label selected. Shared by the native menu and the toolbar. */
export const MERMAID_INSERT_SNIPPET = '\n```mermaid\ngraph TD\n  A[$|$Start$|$] --> B[End]\n```\n';
