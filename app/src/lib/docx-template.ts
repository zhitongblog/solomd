/**
 * What a DOCX export should look like, before anything is written.
 *
 * The exporter used to emit a bare stream of paragraphs: no cover, no table of
 * contents, no header or footer, body text at whatever Word's default is. That
 * is fine for "get this into Word" and useless for the thing people actually
 * export for — a document to hand to somebody.
 *
 * Three presets cover the common cases, and a `docx:` front-matter block
 * overrides individual keys per document, mirroring how `pdf:` already works
 * (`pdf-options.ts`). Resolution is separated from generation because it is
 * the part worth testing: the generation is `docx` library calls.
 */

export type DocxPreset = 'plain' | 'report' | 'academic';

export interface DocxTemplate {
  preset: DocxPreset;
  /** Title page with title / author / date, followed by a page break. */
  cover: boolean;
  /** Insert a Word table-of-contents field (Word offers to update it on open). */
  toc: boolean;
  /** Running header text. Empty means no header. `{title}` is substituted. */
  header: string;
  /** Page numbers in the footer. */
  pageNumbers: boolean;
  /** Body font family; empty means leave Word's default alone. */
  fontFamily: string;
  /** Body font size in points. */
  fontSizePt: number;
  /** 1 = single, 1.5, 2 = double. */
  lineSpacing: number;
  /** Space after each paragraph, in points. */
  paragraphSpacingPt: number;
  /** Cover fields; empty strings are skipped rather than printed blank. */
  title: string;
  author: string;
  date: string;
}

export const DOCX_PRESETS: Record<DocxPreset, Omit<DocxTemplate, 'title' | 'author' | 'date'>> = {
  // What the exporter did before templates existed. Kept as the default so an
  // upgrade never changes an existing user's output without them asking.
  plain: {
    preset: 'plain',
    cover: false,
    toc: false,
    header: '',
    pageNumbers: false,
    fontFamily: '',
    fontSizePt: 11,
    lineSpacing: 1,
    paragraphSpacingPt: 0,
  },
  report: {
    preset: 'report',
    cover: true,
    toc: true,
    header: '{title}',
    pageNumbers: true,
    fontFamily: '',
    fontSizePt: 11,
    lineSpacing: 1.15,
    paragraphSpacingPt: 8,
  },
  // Double-spaced, no running header — the shape most submission guidelines
  // ask for.
  academic: {
    preset: 'academic',
    cover: true,
    toc: true,
    header: '',
    pageNumbers: true,
    fontFamily: 'Times New Roman',
    fontSizePt: 12,
    lineSpacing: 2,
    paragraphSpacingPt: 0,
  },
};

/** Front-matter values that can override the preset, per document. */
interface DocxFrontMatter {
  preset?: DocxPreset;
  cover?: boolean;
  toc?: boolean;
  header?: string;
  pageNumbers?: boolean;
  font?: string;
  fontSize?: number;
  lineSpacing?: number;
  paragraphSpacing?: number;
  title?: string;
  author?: string;
  date?: string;
}

function parseBool(v: string): boolean | undefined {
  const t = v.trim().toLowerCase();
  if (['true', 'yes', 'on', '1'].includes(t)) return true;
  if (['false', 'no', 'off', '0'].includes(t)) return false;
  return undefined;
}

function unquote(v: string): string {
  const t = v.trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    return t.slice(1, -1);
  }
  return t;
}

/**
 * Read the `docx:` block out of a document's front matter.
 *
 * Same shape as `pdf-options.ts`'s reader — a nested mapping or an inline
 * `{ … }` — deliberately, so a user who has learned one knows the other.
 */
export function parseDocxFrontMatter(source: string): DocxFrontMatter {
  const fm = source.replace(/^﻿/, '').match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!fm) return {};
  const yaml = fm[1];
  const header = yaml.match(/^docx\s*:(.*)$/m);
  if (!header) return {};

  const after = yaml.slice(yaml.indexOf(header[0]) + header[0].length);
  let lines: string[];
  const inline = header[1].trim().match(/^\{([\s\S]*)\}$/);
  if (inline) {
    lines = inline[1].split(',');
  } else {
    lines = [];
    for (const line of after.split('\n')) {
      if (line.trim() === '') continue;
      // A column-0 key ends the block — the next front-matter entry.
      if (/^\S/.test(line)) break;
      lines.push(line);
    }
  }

  const out: DocxFrontMatter = {};
  for (const raw of lines) {
    const m = raw.match(/^\s*([A-Za-z][A-Za-z0-9_]*)\s*:\s*(.*)$/);
    if (!m) continue;
    const [, key, value] = m;
    switch (key) {
      case 'preset': {
        const v = unquote(value) as DocxPreset;
        if (v in DOCX_PRESETS) out.preset = v;
        break;
      }
      case 'cover':
        out.cover = parseBool(value);
        break;
      case 'toc':
        out.toc = parseBool(value);
        break;
      case 'header':
        out.header = unquote(value);
        break;
      case 'pageNumbers':
        out.pageNumbers = parseBool(value);
        break;
      case 'font':
        out.font = unquote(value);
        break;
      case 'fontSize': {
        const n = Number(unquote(value));
        if (Number.isFinite(n) && n > 0) out.fontSize = n;
        break;
      }
      case 'lineSpacing': {
        const n = Number(unquote(value));
        if (Number.isFinite(n) && n > 0) out.lineSpacing = n;
        break;
      }
      case 'paragraphSpacing': {
        const n = Number(unquote(value));
        if (Number.isFinite(n) && n >= 0) out.paragraphSpacing = n;
        break;
      }
      case 'title':
        out.title = unquote(value);
        break;
      case 'author':
        out.author = unquote(value);
        break;
      case 'date':
        out.date = unquote(value);
        break;
    }
  }
  return out;
}

/** First H1 in the body, used as a title when nothing better is given. */
export function firstHeading(source: string): string {
  let inFence = false;
  for (const line of source.split('\n')) {
    const t = line.trim();
    if (t.startsWith('```') || t.startsWith('~~~')) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const m = line.match(/^#\s+(.+?)\s*$/);
    if (m) return m[1].trim();
  }
  return '';
}

/** A plain `key: value` from front matter (title / author / date). */
function frontMatterScalar(source: string, key: string): string {
  const fm = source.replace(/^﻿/, '').match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!fm) return '';
  const m = fm[1].match(new RegExp(`^${key}\\s*:\\s*(.+)$`, 'm'));
  return m ? unquote(m[1]) : '';
}

/**
 * The template an export should use: preset, then the document's `docx:`
 * overrides, then cover fields filled in from whatever the document knows
 * about itself.
 */
export function resolveDocxTemplate(
  preset: DocxPreset,
  source: string,
  fallbackTitle = '',
): DocxTemplate {
  const fm = parseDocxFrontMatter(source);
  const base = DOCX_PRESETS[fm.preset ?? preset] ?? DOCX_PRESETS.plain;

  return {
    preset: base.preset,
    cover: fm.cover ?? base.cover,
    toc: fm.toc ?? base.toc,
    header: fm.header ?? base.header,
    pageNumbers: fm.pageNumbers ?? base.pageNumbers,
    fontFamily: fm.font ?? base.fontFamily,
    fontSizePt: fm.fontSize ?? base.fontSizePt,
    lineSpacing: fm.lineSpacing ?? base.lineSpacing,
    paragraphSpacingPt: fm.paragraphSpacing ?? base.paragraphSpacingPt,
    title:
      fm.title ||
      frontMatterScalar(source, 'title') ||
      firstHeading(source) ||
      fallbackTitle,
    author: fm.author || frontMatterScalar(source, 'author'),
    date: fm.date || frontMatterScalar(source, 'date'),
  };
}

/** `{title}` substitution for the running header. */
export function renderHeaderText(template: DocxTemplate): string {
  return template.header.replace(/\{title\}/g, template.title);
}
