/**
 * Clean up "AI artifacts" — invisible characters, smart quotes, em-dashes,
 * non-breaking spaces, and other Unicode oddities that LLM chat interfaces
 * (ChatGPT, Claude, Gemini, etc.) tend to leak into copied text.
 *
 * Two functions:
 *   - cleanAIArtifacts(text): light pass that normalizes special characters
 *     while preserving the original markdown structure.
 *   - stripMarkdownToPlain(text): heavy pass that ALSO strips all markdown
 *     formatting (asterisks, hashes, code fences, etc.) for users who want
 *     pure prose.
 */

/** The light pass: normalize special characters, preserve markdown. */
export function cleanAIArtifacts(text: string): string {
  if (!text) return text;

  return (
    text
      // 1. Strip BOM at start of file (sometimes copied along with text)
      .replace(/^\uFEFF/, '')
      // 2. Strip zero-width / bidi / format-control invisible characters
      //    Includes: ZWSP, ZWNJ, ZWJ, LRM, RLM, LRE, RLE, PDF, LRO, RLO,
      //              LRI, RLI, FSI, PDI, WJ, etc., and lingering BOMs.
      .replace(/[\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]/g, '')
      // 3. Non-breaking space → regular space (NBSP confuses search/copy)
      .replace(/\u00A0/g, ' ')
      // 4. "Smart" double quotes → straight ASCII double quote
      .replace(/[\u201C\u201D\u201E\u201F\u2033\u2036]/g, '"')
      // 5. "Smart" single quotes / apostrophes → straight ASCII apostrophe
      .replace(/[\u2018\u2019\u201A\u201B\u2032\u2035]/g, "'")
      // 6. En dash → regular hyphen
      .replace(/\u2013/g, '-')
      // 7. Em dash → " - " (with spaces around)
      .replace(/\u2014/g, ' - ')
      // 8. Horizontal ellipsis → three dots
      .replace(/\u2026/g, '...')
      // 9. Trim trailing whitespace on each line
      .replace(/[ \t]+$/gm, '')
      // 10. Collapse 3+ consecutive blank lines → 2
      .replace(/\n{3,}/g, '\n\n')
      // 11. Collapse 2+ spaces between words (but preserve indentation)
      .replace(/(\S) {2,}(\S)/g, '$1 $2')
  );
}

/**
 * Heavy pass: clean AI artifacts AND strip all markdown formatting,
 * leaving plain prose. Useful when you want to paste the result into a
 * non-markdown context (email, plain text editor, presentation, etc.).
 */
export function stripMarkdownToPlain(text: string): string {
  return cleanAIArtifacts(text)
    // Fenced code blocks: keep contents, drop the fences
    .replace(/```[a-zA-Z0-9_-]*\n([\s\S]*?)```/g, '$1')
    // Inline code: drop backticks
    .replace(/`([^`]+)`/g, '$1')
    // Images: ![alt](url) → alt
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1')
    // Links: [text](url) → text
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    // Reference-style links: [text][ref] → text
    .replace(/\[([^\]]+)\]\[[^\]]*\]/g, '$1')
    // Bold: **x** / __x__ → x
    .replace(/(\*\*|__)(.+?)\1/g, '$2')
    // Italic: *x* / _x_ → x
    .replace(/(\*|_)(.+?)\1/g, '$2')
    // Strikethrough: ~~x~~ → x
    .replace(/~~(.+?)~~/g, '$1')
    // Highlight: ==x== → x
    .replace(/==(.+?)==/g, '$1')
    // Headings: # x → x
    .replace(/^#{1,6}\s+/gm, '')
    // Blockquote markers
    .replace(/^>\s?/gm, '')
    // List markers (bullet, ordered, task)
    .replace(/^\s*[-*+]\s+(?:\[[ xX]\]\s+)?/gm, '')
    .replace(/^\s*\d+\.\s+/gm, '')
    // Horizontal rules
    .replace(/^[-*_]{3,}\s*$/gm, '')
    // Footnote definitions and inline refs
    .replace(/\[\^[^\]]+\]:[^\n]*/g, '')
    .replace(/\[\^[^\]]+\]/g, '')
    // Final cleanup: collapse blank lines again, trim
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
