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
      // ===== AI citation / reference markers =====
      // Gemini / Google AI / NotebookLM
      .replace(/\[cite_start\]/gi, '')
      .replace(/\[cite:\s*[\d,\s]+\]/gi, '')
      // ChatGPT / GPT-4 web browsing citations: 【1†source】【oai_citation:1|title】
      .replace(/【[^】]*†[^】]*】/g, '')
      .replace(/【oai_citation:[^】]*】/g, '')
      .replace(/【\d+:\d+†[^】]*】/g, '')
      // Perplexity-style inline citations: [1] [2] [3] at end of sentences
      // (only strip when they look like citation clusters, not markdown footnotes)
      .replace(/(?<=\S)\s*\[\d+\](?:\s*\[\d+\])*/g, '')
      // Generic "Source:" / "Sources:" trailing blocks at end of text
      .replace(/\n{2,}(?:Sources?|References?|Citations?):\s*\n[\s\S]*$/i, '')

      // ===== Unicode normalization =====
      // 1. Strip BOM at start of file (sometimes copied along with text)
      .replace(/^\uFEFF/, '')
      // 2. Strip zero-width / bidi / format-control invisible characters
      .replace(/[\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]/g, '')
      // 3. Non-breaking space → regular space
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

      // ===== Whitespace cleanup =====
      // 9. Trim trailing whitespace on each line
      .replace(/[ \t]+$/gm, '')
      // 10. Collapse 3+ consecutive blank lines → 2
      .replace(/\n{3,}/g, '\n\n')
      // 11. Collapse 2+ spaces between words (but preserve indentation)
      .replace(/(\S) {2,}(\S)/g, '$1 $2')
  );
}

/**
 * Strip Markdown syntax (and unescape Markdown backslash escapes like `\#`,
 * `\*`, `1\.`, `\[`) outside of fenced/inline code, leaving plain text.
 * Shared by `stripMarkdownToPlain` and clipboard plain-text / Word copy.
 */
export function stripMarkdownFormatting(text: string): string {
  if (!text) return text;

  const codeBlocks: string[] = [];
  const inlineCodes: string[] = [];
  const escapes: string[] = [];

  let out = text
    // 1. Protect fenced code blocks (drop fences, keep inner code verbatim)
    .replace(/(?:```|~~~)[a-zA-Z0-9_-]*[ \t]*\r?\n([\s\S]*?)(?:```|~~~)/g, (_m, inner: string) => {
      const idx = codeBlocks.push(inner.replace(/\r?\n$/, '')) - 1;
      return `\uE000CB${idx}\uE001`;
    })
    // 2. Protect inline code spans (drop backticks, keep inner code verbatim)
    .replace(/`([^`\n]+)`/g, (_m, inner: string) => {
      const idx = inlineCodes.push(inner) - 1;
      return `\uE000IC${idx}\uE001`;
    })
    // 3. Protect backslash-escaped Markdown punctuation (`\#` -> `#`, `\*` -> `*`, etc.)
    // so they are neither treated as unescaped Markdown markers nor left with a stray `\`.
    .replace(
      /\\([!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~＃＊＿～｀［］（）｛｝｜！＞＋－．、【】《》“”‘’：；，。？])/g,
      (_m, ch: string) => {
        const idx = escapes.push(ch) - 1;
        return `\uE000ES${idx}\uE001`;
      },
    );

  out = out
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
    // Underline HTML tags: <u>x</u> → x
    .replace(/<\/?u>/gi, '')
    // Headings: # x → x
    .replace(/^[ \t]{0,3}#{1,6}[ \t]+/gm, '')
    // Blockquote markers
    .replace(/^[ \t]*>[ \t]?/gm, '')
    // List markers (bullet, ordered, task)
    .replace(/^[ \t]*[-*+][ \t]+(?:\[[ xX]\][ \t]+)?/gm, '')
    .replace(/^[ \t]*\d+[.)][ \t]+(?:\[[ xX]\][ \t]+)?/gm, '')
    // Horizontal rules
    .replace(/^[ \t]*[-*_]{3,}[ \t]*$/gm, '')
    // Footnote definitions and inline refs
    .replace(/\[\^[^\]]+\]:[^\n]*/g, '')
    .replace(/\[\^[^\]]+\]/g, '');

  // Restore escaped characters (without the leading `\`), inline code, and code blocks
  out = out
    .replace(/\uE000ES(\d+)\uE001/g, (_m, i) => escapes[Number(i)] ?? '')
    .replace(/\uE000IC(\d+)\uE001/g, (_m, i) => inlineCodes[Number(i)] ?? '')
    .replace(/\uE000CB(\d+)\uE001/g, (_m, i) => codeBlocks[Number(i)] ?? '');

  return out;
}

/**
 * Heavy pass: clean AI artifacts AND strip all markdown formatting,
 * leaving plain prose. Useful when you want to paste the result into a
 * non-markdown context (email, plain text editor, presentation, etc.).
 */
export function stripMarkdownToPlain(text: string): string {
  return stripMarkdownFormatting(cleanAIArtifacts(text))
    // Final cleanup: collapse blank lines again, trim
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
