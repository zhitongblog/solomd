/**
 * #591 — Helpers for preparing Markdown input and `--from` reader flags before
 * invoking Pandoc (`epub`, `odt`, `latex`, `rtf`, custom templates).
 *
 * Pandoc's default `markdown` reader enables `multiline_tables`, `simple_tables`,
 * and `grid_tables`. When a note has a horizontal rule `---` above a footer/disclaimer
 * paragraph and another `---` below it (such as merged-book section dividers),
 * Pandoc misinterprets `--- ... ---` as a 3-character-wide `multiline_table`
 * (`<table style="width:6%">`), crushing the footer into a vertical narrow strip.
 * Disabling those legacy ASCII table extensions while keeping `pipe_tables`
 * matches SoloMD's CommonMark/GFM preview semantics.
 */
export function buildPandocFromArg(hardBreaks: boolean): string {
  // #683 — Enable `lists_without_preceding_blankline` and disable
  // `blank_before_blockquote` so lists inside blockquotes (e.g. `> text\n> - item`)
  // parse identically to CommonMark/GFM instead of rendering as raw Markdown in EPUB.
  return (
    '--from=markdown-multiline_tables-simple_tables-grid_tables+lists_without_preceding_blankline-blank_before_blockquote' +
    (hardBreaks ? '+hard_line_breaks' : '')
  );
}

/**
 * Strip SoloMD internal TOC / merged-book HTML markers and ensure standalone
 * `---` horizontal rules outside leading YAML front matter and fenced code blocks
 * are surrounded by blank lines so Pandoc never parses them as setext headings
 * or mid-document YAML metadata blocks.
 */
export function prepareMarkdownForPandoc(preprocessedMarkdown: string): string {
  let frontMatter = '';
  let body = preprocessedMarkdown ?? '';

  const fmMatch = body.match(/^(---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$))/);
  if (fmMatch) {
    frontMatter = fmMatch[1].replace(/\r?\n$/, '') + '\n\n';
    body = body.slice(fmMatch[1].length);
  }

  body = body
    .replace(/^[ \t]*\[toc\][ \t]*\r?$/gim, '')
    .replace(/^[ \t]*<!--\s*solomd-page-break\s*-->[ \t]*\r?$/gim, '')
    .replace(/[ \t]*<!--\s*solomd-toc-(?:level:\d+|folder)\s*-->/g, '');

  const lines = body.split(/\r?\n/);
  const out: string[] = [];
  let fenceChar = '';
  let fenceLen = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!fenceChar) {
      const m = line.match(/^\s*(?:(?:[-+*]|\d+[.)])\s+)*(`{3,}|~{3,})(.*)$/);
      if (m && (m[1][0] !== '`' || !m[2].includes('`'))) {
        fenceChar = m[1][0];
        fenceLen = m[1].length;
        out.push(line);
        continue;
      }
      if (/^[ \t]*---+[ \t]*$/.test(line)) {
        if (out.length > 0 && out[out.length - 1].trim() !== '') {
          out.push('');
        }
        out.push('---');
        if (i + 1 < lines.length && lines[i + 1].trim() !== '') {
          out.push('');
        }
        continue;
      }
      out.push(line);
    } else {
      out.push(line);
      const closeRe = new RegExp(
        `^\\s*(?:(?:[-+*]|\\d+[.)])\\s+)*${fenceChar}{${fenceLen},}\\s*$`,
      );
      if (closeRe.test(line)) {
        fenceChar = '';
        fenceLen = 0;
      }
    }
  }

  return frontMatter + out.join('\n');
}
