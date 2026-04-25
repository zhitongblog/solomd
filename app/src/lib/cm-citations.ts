/**
 * F5 CodeMirror 6 extension: typing `@` opens an autocomplete popup of
 * matching citation keys from the loaded bibliography.
 *
 * Inserted form is `@key` — bare, **no** brackets. Pandoc's citeproc
 * understands `@key` as a citation by default (`[@key]` is the bracketed
 * form for inline citations); we leave the choice of bracketing to the
 * user since they may want narrative-style `@key` ("As @smith2020 says…")
 * vs. parenthetical `[@key]`.
 *
 * Preview-side rendering of citations is **not** done here — pandoc handles
 * citation rendering on export. In live preview the user just sees `@key`
 * which is fine and unambiguous.
 */
import {
  autocompletion,
  type CompletionContext,
  type CompletionResult,
  type Completion,
} from '@codemirror/autocomplete';
import { EditorView } from '@codemirror/view';
import type { Extension } from '@codemirror/state';
import type { CitationEntry } from './citations';
import { searchCitations } from './citations';

function citationDetail(e: CitationEntry): string {
  const bits: string[] = [];
  if (e.author) bits.push(shortAuthorList(e.author));
  if (e.year) bits.push(e.year);
  return bits.join(' · ');
}

function citationInfo(e: CitationEntry): string | undefined {
  // Shown in the side panel of the autocomplete popup.
  const lines: string[] = [];
  if (e.title) lines.push(e.title);
  const venue = e.journal || e.booktitle || e.publisher;
  if (venue) lines.push(venue);
  if (e.author) lines.push(e.author);
  return lines.length > 0 ? lines.join('\n') : undefined;
}

function shortAuthorList(author: string): string {
  const parts = author.split(/\s+and\s+/i).map((s) => s.trim()).filter(Boolean);
  if (parts.length === 0) return author;
  const surnames = parts.map((p) => (p.includes(',') ? p.split(',')[0].trim() : p.split(/\s+/).slice(-1)[0]));
  if (surnames.length === 1) return surnames[0];
  if (surnames.length === 2) return `${surnames[0]} & ${surnames[1]}`;
  return `${surnames[0]} et al.`;
}

export function citationsExtension(getEntries: () => CitationEntry[]): Extension {
  function complete(context: CompletionContext): CompletionResult | null {
    // Match `@key` (or `@partial`) before the cursor. We also need to
    // ensure the `@` isn't preceded by a word character (e.g. an email
    // "user@host" should NOT trigger).
    const match = context.matchBefore(/@[\w:.\-]*/);
    if (!match) return null;
    // Look one char before the match for a word char — if so, bail.
    if (match.from > 0) {
      const prev = context.state.doc.sliceString(match.from - 1, match.from);
      if (/\w/.test(prev)) return null;
    }
    const query = match.text.slice(1);
    if (!context.explicit && query.length === 0) return null;

    let entries: CitationEntry[] = [];
    try {
      entries = getEntries();
    } catch {
      return null;
    }
    if (entries.length === 0) return null;

    const matched = searchCitations(entries, query);
    if (matched.length === 0) return null;

    const options: Completion[] = matched.map((e) => ({
      label: `@${e.key}`,
      detail: citationDetail(e) || undefined,
      info: citationInfo(e),
      apply: (view: EditorView, _completion: Completion, from: number, to: number) => {
        const insert = `@${e.key}`;
        view.dispatch({
          changes: { from, to, insert },
          selection: { anchor: from + insert.length },
        });
      },
    }));

    return {
      from: match.from,
      to: match.to,
      options,
      // Only stay valid while the user keeps typing key-ish chars.
      validFor: /^@[\w:.\-]*$/,
    };
  }

  return autocompletion({
    override: [complete],
    defaultKeymap: true,
    activateOnTyping: true,
  });
}
