/**
 * Convert markdown source to a DOCX Blob using the `docx` library.
 * Walks markdown-it tokens and emits Word paragraphs / runs.
 *
 * Supports: headings (h1-h6), paragraphs, bold, italic, inline code, links,
 * fenced code blocks, ordered/bullet lists, blockquotes, horizontal rules.
 */

import {
  Document,
  Packer,
  Paragraph,
  TextRun,
  HeadingLevel,
  AlignmentType,
  ExternalHyperlink,
  ShadingType,
  BorderStyle,
  Table,
  TableRow,
  TableCell,
  WidthType,
} from 'docx';
import { md } from './markdown';
import type Token from 'markdown-it/lib/token.mjs';

type BlockChild = Paragraph | Table;

interface RunStyle {
  bold?: boolean;
  italic?: boolean;
  strike?: boolean;
  code?: boolean;
  link?: string;
}

const HEADING_LEVELS: Record<string, (typeof HeadingLevel)[keyof typeof HeadingLevel]> = {
  h1: HeadingLevel.HEADING_1,
  h2: HeadingLevel.HEADING_2,
  h3: HeadingLevel.HEADING_3,
  h4: HeadingLevel.HEADING_4,
  h5: HeadingLevel.HEADING_5,
  h6: HeadingLevel.HEADING_6,
};

function buildRuns(inlineToken: Token, style: RunStyle = {}): (TextRun | ExternalHyperlink)[] {
  const out: (TextRun | ExternalHyperlink)[] = [];
  if (!inlineToken.children) {
    if (inlineToken.content) {
      out.push(new TextRun({ text: inlineToken.content, ...toRunOpts(style) }));
    }
    return out;
  }

  const stack: RunStyle[] = [{ ...style }];
  let pendingLink: { href: string; runs: (TextRun | ExternalHyperlink)[] } | null = null;

  const push = (run: TextRun) => {
    if (pendingLink) {
      pendingLink.runs.push(run);
    } else {
      out.push(run);
    }
  };

  for (const tok of inlineToken.children) {
    const cur = { ...stack[stack.length - 1] };
    switch (tok.type) {
      case 'text':
        if (tok.content) push(new TextRun({ text: tok.content, ...toRunOpts(cur) }));
        break;
      case 'softbreak':
        push(new TextRun({ text: ' ', ...toRunOpts(cur) }));
        break;
      case 'hardbreak':
        push(new TextRun({ text: '', break: 1, ...toRunOpts(cur) }));
        break;
      case 'strong_open':
        stack.push({ ...cur, bold: true });
        break;
      case 'strong_close':
        stack.pop();
        break;
      case 'em_open':
        stack.push({ ...cur, italic: true });
        break;
      case 'em_close':
        stack.pop();
        break;
      case 's_open':
        stack.push({ ...cur, strike: true });
        break;
      case 's_close':
        stack.pop();
        break;
      case 'code_inline':
        push(new TextRun({ text: tok.content, ...toRunOpts({ ...cur, code: true }) }));
        break;
      case 'link_open': {
        const href = tok.attrGet('href') ?? '';
        pendingLink = { href, runs: [] };
        break;
      }
      case 'link_close':
        if (pendingLink) {
          out.push(
            new ExternalHyperlink({
              link: pendingLink.href,
              children: pendingLink.runs as TextRun[],
            })
          );
          pendingLink = null;
        }
        break;
      case 'image': {
        // Actual image embedding would require fetching bytes + knowing
        // dimensions, which is out of scope here. Emit a styled placeholder
        // that still conveys the intent in the resulting document.
        const alt = tok.content || tok.attrGet('alt') || 'image';
        const src = tok.attrGet('src') || '';
        const label = src ? `[image: ${alt}] (${src})` : `[image: ${alt}]`;
        push(new TextRun({ text: label, italics: true, color: '888888' }));
        break;
      }
      default:
        // Unknown inline → fall back to its raw content
        if (tok.content) push(new TextRun({ text: tok.content, ...toRunOpts(cur) }));
    }
  }
  return out;
}

function toRunOpts(s: RunStyle) {
  const opts: any = {};
  if (s.bold) opts.bold = true;
  if (s.italic) opts.italics = true;
  if (s.strike) opts.strike = true;
  if (s.code) {
    opts.font = 'JetBrains Mono';
    opts.color = '8A4A00';
    opts.shading = { type: ShadingType.SOLID, color: 'F3EFE7', fill: 'F3EFE7' };
  }
  return opts;
}

/** Heading paragraph spacing, tuned to visually match our HTML/PDF cascade. */
const HEADING_SPACING: Record<string, { before: number; after: number }> = {
  h1: { before: 360, after: 180 },
  h2: { before: 320, after: 160 },
  h3: { before: 280, after: 140 },
  h4: { before: 240, after: 120 },
  h5: { before: 200, after: 100 },
  h6: { before: 200, after: 100 },
};

/**
 * Find the matching close token for `openType` starting at index `start`
 * (which should point AT the open token). Returns the index of the close.
 * Handles nested open/close pairs of the same type.
 */
function findMatchingClose(tokens: Token[], start: number, openType: string, closeType: string): number {
  let depth = 0;
  for (let j = start; j < tokens.length; j++) {
    if (tokens[j].type === openType) depth++;
    else if (tokens[j].type === closeType) {
      depth--;
      if (depth === 0) return j;
    }
  }
  return tokens.length - 1;
}

function buildBody(tokens: Token[]): BlockChild[] {
  const out: BlockChild[] = [];
  let i = 0;
  // List nesting state: depth + counters per level
  const listStack: { type: 'bullet' | 'ordered'; index: number }[] = [];

  while (i < tokens.length) {
    const tok = tokens[i];
    switch (tok.type) {
      case 'heading_open': {
        const level = tok.tag; // h1..h6
        const inline = tokens[i + 1];
        i += 3;
        out.push(
          new Paragraph({
            heading: HEADING_LEVELS[level],
            children: buildRuns(inline),
            spacing: HEADING_SPACING[level] ?? { before: 240, after: 120 },
            keepNext: true,
          })
        );
        break;
      }
      case 'paragraph_open': {
        const inline = tokens[i + 1];
        i += 3;
        const isInList = listStack.length > 0;
        out.push(
          new Paragraph({
            children: buildRuns(inline),
            spacing: isInList ? { before: 60, after: 60 } : { before: 120, after: 120 },
            ...(isInList && {
              numbering:
                listStack[listStack.length - 1].type === 'ordered'
                  ? { reference: 'ordered-list', level: Math.min(listStack.length - 1, 8) }
                  : undefined,
              bullet:
                listStack[listStack.length - 1].type === 'bullet'
                  ? { level: Math.min(listStack.length - 1, 8) }
                  : undefined,
            }),
          })
        );
        break;
      }
      case 'fence':
      case 'code_block': {
        const lines = (tok.content || '').replace(/\n$/, '').split('\n');
        const last = lines.length - 1;
        lines.forEach((line, idx) => {
          out.push(
            new Paragraph({
              children: [
                new TextRun({
                  text: line || ' ',
                  font: 'JetBrains Mono',
                  size: 20,
                  color: '1F1D1A',
                }),
              ],
              shading: { type: ShadingType.SOLID, color: 'F3EFE7', fill: 'F3EFE7' },
              spacing: {
                before: idx === 0 ? 160 : 0,
                after: idx === last ? 160 : 0,
              },
              border: {
                left: { style: BorderStyle.SINGLE, size: 18, color: 'FF9F40', space: 6 },
              },
            })
          );
        });
        i += 1;
        break;
      }
      case 'hr':
        out.push(
          new Paragraph({
            text: '',
            spacing: { before: 240, after: 240 },
            border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: 'CCCCCC' } },
          })
        );
        i += 1;
        break;
      case 'blockquote_open': {
        const end = findMatchingClose(tokens, i, 'blockquote_open', 'blockquote_close');
        const inner = tokens.slice(i + 1, end);
        const innerBlocks = buildBody(inner);
        for (const block of innerBlocks) {
          if (block instanceof Paragraph) {
            out.push(
              new Paragraph({
                // Copy runs from the inner paragraph by re-reading its stored options.
                children: ((block as any).options?.children ?? []) as TextRun[],
                alignment: AlignmentType.LEFT,
                indent: { left: 360 },
                spacing: { before: 80, after: 80 },
                border: {
                  left: { style: BorderStyle.SINGLE, size: 18, color: 'FF9F40', space: 8 },
                },
              })
            );
          } else {
            out.push(block);
          }
        }
        i = end + 1;
        break;
      }
      case 'table_open': {
        const end = findMatchingClose(tokens, i, 'table_open', 'table_close');
        const table = buildTable(tokens.slice(i + 1, end));
        if (table) out.push(table);
        // Small spacer paragraph after the table so following text breathes.
        out.push(new Paragraph({ text: '', spacing: { before: 0, after: 120 } }));
        i = end + 1;
        break;
      }
      case 'bullet_list_open':
        listStack.push({ type: 'bullet', index: 0 });
        i += 1;
        break;
      case 'ordered_list_open':
        listStack.push({ type: 'ordered', index: 0 });
        i += 1;
        break;
      case 'bullet_list_close':
      case 'ordered_list_close':
        listStack.pop();
        i += 1;
        break;
      case 'list_item_open':
      case 'list_item_close':
        i += 1;
        break;
      default:
        i += 1;
    }
  }
  return out;
}

/**
 * Build a docx Table from the tokens BETWEEN `table_open` and `table_close`
 * (exclusive). markdown-it emits:
 *   thead_open, tr_open, th_open, inline, th_close, ..., tr_close, thead_close,
 *   tbody_open, tr_open, td_open, inline, td_close, ..., tr_close, tbody_close
 */
function buildTable(inner: Token[]): Table | null {
  const rows: { cells: TextRun[][]; isHeader: boolean }[] = [];
  let currentRow: { cells: TextRun[][]; isHeader: boolean } | null = null;
  let inHeader = false;

  for (let k = 0; k < inner.length; k++) {
    const t = inner[k];
    switch (t.type) {
      case 'thead_open':
        inHeader = true;
        break;
      case 'thead_close':
        inHeader = false;
        break;
      case 'tr_open':
        currentRow = { cells: [], isHeader: inHeader };
        break;
      case 'tr_close':
        if (currentRow) rows.push(currentRow);
        currentRow = null;
        break;
      case 'th_open':
      case 'td_open': {
        const inlineTok = inner[k + 1];
        const runs = inlineTok ? (buildRuns(inlineTok) as TextRun[]) : [];
        if (currentRow) currentRow.cells.push(runs);
        break;
      }
      default:
        // ignore th_close / td_close / inline (already consumed via lookahead)
        break;
    }
  }

  if (rows.length === 0) return null;

  const colCount = Math.max(...rows.map((r) => r.cells.length));

  const docxRows = rows.map(
    (row) =>
      new TableRow({
        tableHeader: row.isHeader,
        children: Array.from({ length: colCount }, (_, c) => {
          const runs = row.cells[c] ?? [];
          const cellChildren =
            runs.length > 0
              ? [new Paragraph({ children: runs, spacing: { before: 40, after: 40 } })]
              : [new Paragraph({ text: '' })];
          return new TableCell({
            children: cellChildren,
            shading: row.isHeader
              ? { type: ShadingType.SOLID, color: 'FFE7CC', fill: 'FFE7CC' }
              : undefined,
            margins: { top: 80, bottom: 80, left: 120, right: 120 },
          });
        }),
      })
  );

  return new Table({
    rows: docxRows,
    width: { size: 100, type: WidthType.PERCENTAGE },
    borders: {
      top: { style: BorderStyle.SINGLE, size: 4, color: 'E6E2D8' },
      bottom: { style: BorderStyle.SINGLE, size: 4, color: 'E6E2D8' },
      left: { style: BorderStyle.SINGLE, size: 4, color: 'E6E2D8' },
      right: { style: BorderStyle.SINGLE, size: 4, color: 'E6E2D8' },
      insideHorizontal: { style: BorderStyle.SINGLE, size: 4, color: 'E6E2D8' },
      insideVertical: { style: BorderStyle.SINGLE, size: 4, color: 'E6E2D8' },
    },
  });
}

export async function markdownToDocxBlob(source: string, _title = 'Document'): Promise<Blob> {
  const tokens = md.parse(source || '', {});
  const blocks = buildBody(tokens);
  if (blocks.length === 0) blocks.push(new Paragraph({ text: '' }));

  const doc = new Document({
    creator: 'SoloMD',
    title: _title,
    description: 'Exported from SoloMD',
    numbering: {
      config: [
        {
          reference: 'ordered-list',
          levels: [
            { level: 0, format: 'decimal', text: '%1.', alignment: AlignmentType.START },
            { level: 1, format: 'lowerLetter', text: '%2.', alignment: AlignmentType.START },
            { level: 2, format: 'lowerRoman', text: '%3.', alignment: AlignmentType.START },
          ],
        },
      ],
    },
    sections: [
      {
        properties: {},
        children: blocks,
      },
    ],
  });

  return Packer.toBlob(doc);
}
