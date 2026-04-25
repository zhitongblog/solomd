/**
 * Convert markdown source to a DOCX Blob using the `docx` library.
 * Walks markdown-it tokens and emits Word paragraphs / runs.
 *
 * Supports: headings (h1-h6), paragraphs, bold, italic, inline code, links,
 * fenced code blocks, ordered/bullet lists, blockquotes, horizontal rules,
 * tables, and embedded images (local + remote).
 */

import {
  Document,
  Packer,
  Paragraph,
  TextRun,
  ImageRun,
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
import { invoke } from '@tauri-apps/api/core';
import { md, extractImageRoot } from './markdown';
import { resolveImagePath } from './image-resolve';
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

/** Image cache: absolute path → { data, width, height, type } */
interface ImageCache {
  data: Uint8Array;
  width: number;
  height: number;
  type: 'jpg' | 'png' | 'gif' | 'bmp';
}
const imageCache = new Map<string, ImageCache>();

function imageTypeFromPath(path: string): 'jpg' | 'png' | 'gif' | 'bmp' {
  const ext = path.split('.').pop()?.toLowerCase() ?? '';
  if (ext === 'jpg' || ext === 'jpeg') return 'jpg';
  if (ext === 'gif') return 'gif';
  if (ext === 'bmp') return 'bmp';
  return 'png';
}

async function fetchImageBytes(absPath: string): Promise<ImageCache | null> {
  const cached = imageCache.get(absPath);
  if (cached) return cached;

  try {
    const data = await invoke<number[]>('read_binary_file', { path: absPath });
    const bytes = new Uint8Array(data);

    const { width, height } = readImageDimensions(bytes) ?? { width: 400, height: 300 };

    const result: ImageCache = {
      data: bytes,
      width,
      height,
      type: imageTypeFromPath(absPath),
    };
    imageCache.set(absPath, result);
    return result;
  } catch {
    return null;
  }
}

/** Read width/height from PNG/JPEG/GIF/BMP headers without decoding the full image. */
function readImageDimensions(data: Uint8Array): { width: number; height: number } | null {
  // PNG: bytes 16-23 are width (4B BE) + height (4B BE)
  if (data[0] === 0x89 && data[1] === 0x50 /* P */) {
    const w = (data[16] << 24) | (data[17] << 16) | (data[18] << 8) | data[19];
    const h = (data[20] << 24) | (data[21] << 16) | (data[22] << 8) | data[23];
    if (w > 0 && h > 0) return { width: w, height: h };
  }
  // JPEG: scan SOF0/SOF2 marker (0xFFC0 / 0xFFC2)
  if (data[0] === 0xFF && data[1] === 0xD8) {
    let i = 2;
    while (i < data.length - 8) {
      if (data[i] !== 0xFF) break;
      const marker = data[i + 1];
      if (marker === 0xC0 || marker === 0xC2) {
        const h = (data[i + 5] << 8) | data[i + 6];
        const w = (data[i + 7] << 8) | data[i + 8];
        if (w > 0 && h > 0) return { width: w, height: h };
      }
      const segLen = ((data[i + 2] << 8) | data[i + 3]) + 2;
      if (segLen < 3) break;
      i += segLen;
    }
  }
  // GIF: little-endian width/height at offset 6-9
  if (data[0] === 0x47 && data[1] === 0x49 && data[2] === 0x46 /* GIF */) {
    const w = data[6] | (data[7] << 8);
    const h = data[8] | (data[9] << 8);
    if (w > 0 && h > 0) return { width: w, height: h };
  }
  // BMP: little-endian at offset 18-25
  if (data[0] === 0x42 && data[1] === 0x4D) {
    const w = data[18] | (data[19] << 8) | (data[20] << 16) | (data[21] << 24);
    const h = Math.abs(data[22] | (data[23] << 8) | (data[24] << 16) | (data[25] << 24));
    if (w > 0 && h > 0) return { width: w, height: h };
  }
  return null;
}

/** Max image width in the DOCX (pixels at 96dpi). */
const MAX_IMG_WIDTH = 580;

function scaleDimensions(w: number, h: number): { width: number; height: number } {
  if (w > MAX_IMG_WIDTH) {
    const ratio = MAX_IMG_WIDTH / w;
    w = MAX_IMG_WIDTH;
    h = Math.round(h * ratio);
  }
  return { width: w, height: h };
}

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
      case 'image':
        // Images are handled at the block level (see buildBody), but if an
        // image appears inline we emit a placeholder.
        push(new TextRun({ text: `[${tok.content || 'image'}]`, italics: true, color: '888888' }));
        break;
      default:
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

/** Resolve an image src from markdown to an absolute local path. Returns null for remote URLs. */
function resolveLocalImagePath(src: string, imageRoot: string | null, filePath?: string): string | null {
  if (!src || /^(https?|data|blob|asset|tauri):/i.test(src)) return null;
  const resolved = resolveImagePath(src, imageRoot, filePath);
  if (/^(https?|data|blob|asset|tauri):/i.test(resolved)) return null;
  return resolved;
}

async function buildBody(tokens: Token[], imageRoot: string | null, filePath?: string): Promise<BlockChild[]> {
  const out: BlockChild[] = [];
  let i = 0;
  const listStack: { type: 'bullet' | 'ordered'; index: number }[] = [];

  while (i < tokens.length) {
    const tok = tokens[i];
    switch (tok.type) {
      case 'heading_open': {
        const level = tok.tag;
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

        // Check if this paragraph contains a standalone image (image-only paragraph)
        if (inline && isImageOnlyParagraph(inline)) {
          const imgTok = inline.children!.find(c => c.type === 'image')!;
          const src = imgTok.attrGet('src') || '';
          const alt = imgTok.content || imgTok.attrGet('alt') || '';
          const absPath = resolveLocalImagePath(src, imageRoot, filePath);

          if (absPath) {
            const img = await fetchImageBytes(absPath);
            if (img) {
              const dim = scaleDimensions(img.width, img.height);
              out.push(
                new Paragraph({
                  children: [
                    new ImageRun({
                      type: img.type,
                      data: img.data,
                      transformation: { width: dim.width, height: dim.height },
                      altText: { name: alt, description: alt },
                    }),
                  ],
                  alignment: AlignmentType.CENTER,
                  spacing: { before: 160, after: 160 },
                })
              );
              break;
            }
          }

          // Fallback: placeholder for remote or unreadable images
          out.push(
            new Paragraph({
              children: [
                new TextRun({
                  text: src ? `[image: ${alt}] (${src})` : `[image: ${alt}]`,
                  italics: true,
                  color: '888888',
                }),
              ],
              alignment: AlignmentType.CENTER,
              spacing: { before: 160, after: 160 },
            })
          );
          break;
        }

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
        const innerBlocks = await buildBody(inner, imageRoot, filePath);
        for (const block of innerBlocks) {
          if (block instanceof Paragraph) {
            out.push(
              new Paragraph({
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

/** Check if an inline token's children consist of only a single image (possibly wrapped in a link). */
function isImageOnlyParagraph(inline: Token): boolean {
  if (!inline.children) return false;
  const nonWhitespace = inline.children.filter(
    c => !(c.type === 'text' && !c.content.trim()) && c.type !== 'softbreak'
  );
  if (nonWhitespace.length === 1 && nonWhitespace[0].type === 'image') return true;
  // Link wrapping an image: link_open → image → link_close
  if (nonWhitespace.length === 3
    && nonWhitespace[0].type === 'link_open'
    && nonWhitespace[1].type === 'image'
    && nonWhitespace[2].type === 'link_close') return true;
  return false;
}

/**
 * Build a docx Table from the tokens BETWEEN `table_open` and `table_close`
 * (exclusive).
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

export async function markdownToDocxBlob(source: string, _title = 'Document', filePath?: string): Promise<Blob> {
  imageCache.clear();
  const tokens = md.parse(source ?? '', {});
  const imageRoot = extractImageRoot(source || '');
  const blocks = await buildBody(tokens, imageRoot, filePath);
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
