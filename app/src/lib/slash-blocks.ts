/**
 * slash-blocks.ts — catalog of "/" slash-command insertable blocks.
 *
 * Each entry is a self-contained Markdown snippet the user can insert
 * by typing `/` in the editor and picking from the popup. Snippets
 * support two placeholders:
 *
 *   ${cursor}    — final cursor position after insert (placeholder is
 *                  stripped from the inserted text)
 *   ${selection} — replaced with the current editor selection (or
 *                  with `${cursor}` semantics if there is no selection)
 *
 * Labels and hints are localized at render time via the i18n catalog;
 * the strings here are English fallbacks used when a key is missing.
 *
 * Used by `cm-slash-commands.ts` (CodeMirror 6 extension) and rendered
 * by the matching popup. NOT used outside the editor.
 *
 * v2.5 — bonus feature from GitHub Discussion #30.
 */

export interface SlashBlock {
  /** Stable id, e.g. `h1`, `code`, `table`. Used for i18n keys + tests. */
  id: string;
  /** Single-glyph icon. ASCII / unicode — no font lib. */
  icon: string;
  /** Default English label (i18n fallback). */
  label: string;
  /** Default English hint (i18n fallback). Shown muted to the right of the label. */
  hint: string;
  /**
   * Snippet to insert. May contain `${cursor}` and / or `${selection}`.
   * `${selection}` falls back to `${cursor}` when there is no selection.
   * Keep snippets *single-string* — the renderer interpolates literally.
   */
  snippet: string;
  /**
   * Lookup keywords used by the fuzzy-filter scoring layer. Adding
   * synonyms (`bullet` → `list`, `code` → `pre`) keeps the popup useful
   * when the user can't remember the canonical id.
   */
  keywords?: string[];
}

export const SLASH_BLOCKS: SlashBlock[] = [
  // -------- Headings --------
  {
    id: 'h1',
    icon: 'H1',
    label: 'Heading 1',
    hint: '# Title',
    snippet: '# ${cursor}',
    keywords: ['h1', 'heading', 'title', 'header'],
  },
  {
    id: 'h2',
    icon: 'H2',
    label: 'Heading 2',
    hint: '## Title',
    snippet: '## ${cursor}',
    keywords: ['h2', 'heading', 'subtitle', 'header'],
  },
  {
    id: 'h3',
    icon: 'H3',
    label: 'Heading 3',
    hint: '### Title',
    snippet: '### ${cursor}',
    keywords: ['h3', 'heading', 'header'],
  },

  // -------- Lists --------
  {
    id: 'bullet',
    icon: '•',
    label: 'Bullet list',
    hint: '- item',
    snippet: '- ${cursor}',
    keywords: ['bullet', 'list', 'unordered', 'ul'],
  },
  {
    id: 'numbered',
    icon: '1.',
    label: 'Numbered list',
    hint: '1. item',
    snippet: '1. ${cursor}',
    keywords: ['numbered', 'ordered', 'list', 'ol'],
  },
  {
    id: 'todo',
    icon: '☐',
    label: 'Todo',
    hint: '- [ ] task',
    snippet: '- [ ] ${cursor}',
    keywords: ['todo', 'task', 'checkbox', 'check'],
  },

  // -------- Blocks --------
  {
    id: 'code',
    icon: '</>',
    label: 'Code block',
    hint: '```lang',
    // Triple-backtick fence with cursor on the inner blank line. The
    // outer triple-backticks of THIS template literal are not present —
    // we build the snippet by string concat so the file itself parses.
    snippet: '```\n${cursor}\n```',
    keywords: ['code', 'block', 'fence', 'pre'],
  },
  {
    id: 'quote',
    icon: '"',
    label: 'Quote',
    hint: '> text',
    snippet: '> ${cursor}',
    keywords: ['quote', 'blockquote', 'callout'],
  },
  {
    id: 'divider',
    icon: '—',
    label: 'Divider',
    hint: '---',
    snippet: '---\n${cursor}',
    keywords: ['divider', 'hr', 'rule', 'separator', 'horizontal'],
  },
  {
    id: 'table',
    icon: '⊞',
    label: 'Table 3×3',
    hint: '| | | |',
    snippet:
      '| ${cursor} | Header | Header |\n' +
      '| --- | --- | --- |\n' +
      '| Cell | Cell | Cell |\n' +
      '| Cell | Cell | Cell |',
    keywords: ['table', 'grid', 'rows', 'columns'],
  },

  // -------- Math + diagrams --------
  {
    id: 'math_block',
    icon: '∑',
    label: 'Math block',
    hint: '$$ … $$',
    snippet: '$$\n${cursor}\n$$',
    keywords: ['math', 'latex', 'equation', 'tex', 'block'],
  },
  {
    id: 'math_inline',
    icon: '∫',
    label: 'Inline math',
    hint: '$x$',
    snippet: '$${cursor}$',
    keywords: ['math', 'latex', 'inline', 'equation', 'tex'],
  },
  {
    id: 'mermaid',
    icon: '◇',
    label: 'Mermaid diagram',
    hint: 'flowchart',
    snippet:
      '```mermaid\nflowchart TD\n  A[${cursor}] --> B[End]\n```',
    keywords: ['mermaid', 'diagram', 'flowchart', 'graph'],
  },

  // -------- Links + media --------
  {
    id: 'link',
    icon: '🔗',
    label: 'Link',
    hint: '[text](url)',
    snippet: '[${selection}](url)',
    keywords: ['link', 'url', 'href', 'anchor'],
  },
  {
    id: 'image',
    icon: '🖼',
    label: 'Image',
    hint: '![alt](src)',
    snippet: '![${selection}](src)',
    keywords: ['image', 'img', 'picture', 'media'],
  },

  // -------- Inline styles --------
  {
    id: 'bold',
    icon: 'B',
    label: 'Bold',
    hint: '**text**',
    snippet: '**${selection}**',
    keywords: ['bold', 'strong', 'emphasis'],
  },
  {
    id: 'italic',
    icon: 'I',
    label: 'Italic',
    hint: '*text*',
    snippet: '*${selection}*',
    keywords: ['italic', 'em', 'emphasis'],
  },
  {
    id: 'strikethrough',
    icon: 'S',
    label: 'Strikethrough',
    hint: '~~text~~',
    snippet: '~~${selection}~~',
    keywords: ['strikethrough', 'strike', 'del'],
  },
  {
    id: 'inline_code',
    icon: '`',
    label: 'Inline code',
    hint: '`code`',
    snippet: '`${selection}`',
    keywords: ['inline', 'code', 'mono', 'tt'],
  },

  // -------- Frontmatter --------
  {
    id: 'frontmatter',
    icon: '⊟',
    label: 'Front matter',
    hint: '--- yaml ---',
    snippet: '---\ntitle: ${cursor}\n---\n',
    keywords: ['frontmatter', 'yaml', 'meta', 'header'],
  },
];

// ---------------------------------------------------------------------------
// Snippet expansion
// ---------------------------------------------------------------------------

export interface ExpandedSnippet {
  /** Final text to insert. */
  text: string;
  /** Offset (within `text`) where the cursor should land after insert. */
  cursorOffset: number;
}

/**
 * Expand a snippet template against the current selection.
 *
 *   - `${selection}` → the selection text (empty string if none).
 *   - `${cursor}`    → empty string; its index becomes the final cursor
 *                      position. If there's selection text and no
 *                      explicit `${cursor}`, the cursor lands at the
 *                      end of the inserted text.
 *
 * Selection-only snippets (`**${selection}**`) get an automatic
 * `${cursor}` placeholder if no selection: the caret lands inside the
 * wrappers (between the asterisks), ready for typing.
 */
export function expandSnippet(snippet: string, selection: string): ExpandedSnippet {
  const SELECTION_TOKEN = '${selection}';
  const CURSOR_TOKEN = '${cursor}';

  // If the template uses ${selection} and we have no selection, treat
  // ${selection} like ${cursor} (caret lands where the wrapped text
  // would go). This is the "select first → /bold" / "no selection →
  // /bold then type" symmetry.
  let template = snippet;
  if (template.includes(SELECTION_TOKEN)) {
    if (selection.length > 0) {
      template = template.split(SELECTION_TOKEN).join(selection);
    } else {
      // Replace the FIRST ${selection} with ${cursor}, others with empty.
      const idx = template.indexOf(SELECTION_TOKEN);
      template =
        template.slice(0, idx) +
        CURSOR_TOKEN +
        template.slice(idx + SELECTION_TOKEN.length).split(SELECTION_TOKEN).join('');
    }
  }

  const cursorIdx = template.indexOf(CURSOR_TOKEN);
  if (cursorIdx >= 0) {
    const text = template.slice(0, cursorIdx) + template.slice(cursorIdx + CURSOR_TOKEN.length);
    return { text, cursorOffset: cursorIdx };
  }

  return { text: template, cursorOffset: template.length };
}

// ---------------------------------------------------------------------------
// Filter / fuzzy-match scoring
// ---------------------------------------------------------------------------

interface ScoredBlock {
  block: SlashBlock;
  score: number;
}

/**
 * Filter the catalog against a user query (the substring after `/`).
 *
 * Scoring rules (highest first wins):
 *   - id starts with query              → 1000
 *   - id contains query                 → 500
 *   - any keyword starts with query     → 400
 *   - any keyword contains query        → 200
 *   - label (lowercased) starts with    → 300
 *   - label (lowercased) contains       → 100
 *   - subsequence match in id           → 50
 *
 * Empty query returns the catalog in original order.
 */
export function filterBlocks(blocks: SlashBlock[], query: string): SlashBlock[] {
  if (!query) return blocks.slice();
  const q = query.toLowerCase();
  const scored: ScoredBlock[] = [];
  for (const b of blocks) {
    const id = b.id.toLowerCase();
    const label = b.label.toLowerCase();
    let score = 0;

    if (id === q) score = Math.max(score, 1500);
    else if (id.startsWith(q)) score = Math.max(score, 1000);
    else if (id.includes(q)) score = Math.max(score, 500);

    if (label.startsWith(q)) score = Math.max(score, 300);
    else if (label.includes(q)) score = Math.max(score, 100);

    if (b.keywords) {
      for (const kw of b.keywords) {
        const k = kw.toLowerCase();
        if (k === q) score = Math.max(score, 600);
        else if (k.startsWith(q)) score = Math.max(score, 400);
        else if (k.includes(q)) score = Math.max(score, 200);
      }
    }

    if (score === 0 && isSubsequence(q, id)) score = 50;

    if (score > 0) scored.push({ block: b, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.map((s) => s.block);
}

function isSubsequence(needle: string, haystack: string): boolean {
  let i = 0;
  for (let j = 0; j < haystack.length && i < needle.length; j++) {
    if (haystack[j] === needle[i]) i++;
  }
  return i === needle.length;
}
