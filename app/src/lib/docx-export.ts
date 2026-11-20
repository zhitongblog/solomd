/**
 * Convert markdown source to a DOCX Blob using the `docx` library.
 * Walks markdown-it tokens and emits Word paragraphs / runs.
 *
 * Supports: headings (h1-h6), paragraphs, bold, italic, inline code, links,
 * fenced code blocks, ordered/bullet lists, blockquotes, horizontal rules,
 * math (as LaTeX source),
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
  Header,
  Footer,
  PageNumber,
  PageBreak,
  TableOfContents,
  LineRuleType,
  Bookmark,
} from 'docx';
import { mermaidToPng } from './diagram-export';
import { md, extractImageRoot, preprocessMarkdown } from './markdown';
import { parseImageAltSize } from './md-image-url';
import {
  resolveDocxTemplate,
  renderHeaderText,
  type DocxPreset,
  type DocxTemplate,
} from './docx-template';
import { resolveImagePath } from './image-resolve';
import { blobToPng, loadImageBlob } from './image-clipboard';
import { isPlantumlLang, plantumlSvgUrl } from './plantuml';
import { unzipSync, zipSync, strFromU8, strToU8 } from 'fflate';
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

/** A loaded image, ready for an ImageRun. */
interface ImageCache {
  data: Uint8Array;
  width: number;
  height: number;
  type: 'jpg' | 'png' | 'gif' | 'bmp';
}


/**
 * Every image in the document, keyed by its markdown `src`, loaded BEFORE the
 * body is built (buildRuns is synchronous). Before this, only an image alone
 * in its paragraph AND on the local disk made it into the .docx: remote
 * (image-host) URLs, `data:` URIs, images inside a sentence / list / table
 * cell and HTML `<img>` tags all became "[image …]" text — "导出的 word 文档
 * 没有图片".
 */
const srcImages = new Map<string, ImageCache | null>();

/** Image type from the file header, not the name: image-host URLs often
 *  have no extension, and a .png that is really a JPEG is common. */
function sniffImageType(b: Uint8Array): ImageCache['type'] | null {
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'png';
  if (b[0] === 0xff && b[1] === 0xd8) return 'jpg';
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return 'gif';
  if (b[0] === 0x42 && b[1] === 0x4d) return 'bmp';
  return null; // webp / svg / avif / … → converted to PNG
}

const HTML_IMG_RE = /<img\b[^>]*?\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>/gi;

function htmlImageSrcs(html: string): string[] {
  const out: string[] = [];
  for (const m of html.matchAll(HTML_IMG_RE)) {
    const src = m[1] ?? m[2] ?? m[3] ?? '';
    if (src) out.push(src);
  }
  return out;
}

/** Set per export run; buildBody's fence branch reads it. */
let plantumlServerForRun: string | null = null;
let mediaAlignmentForRun: (typeof AlignmentType)[keyof typeof AlignmentType] = AlignmentType.CENTER;

function plantumlUrlFor(tok: Token): string | null {
  if (!plantumlServerForRun || tok.type !== 'fence') return null;
  if (!isPlantumlLang((tok.info || '').trim().split(/\s+/)[0])) return null;
  return plantumlSvgUrl(plantumlServerForRun, (tok.content || '').trim());
}

function collectImageSrcs(tokens: Token[], into: Set<string>) {
  for (const tok of tokens) {
    const puml = plantumlUrlFor(tok);
    if (puml) into.add(puml);
    if (tok.type === 'image') {
      const src = tok.attrGet('src');
      if (src) into.add(src);
    } else if (tok.type === 'html_inline' || tok.type === 'html_block') {
      for (const src of htmlImageSrcs(tok.content || '')) into.add(src);
    }
    if (tok.children) collectImageSrcs(tok.children, into);
  }
}

async function loadDocxImage(src: string, imageRoot: string | null, filePath?: string): Promise<ImageCache | null> {
  try {
    const isUrl = /^(https?|data|blob):/i.test(src);
    const local = isUrl ? null : resolveImagePath(src, imageRoot, filePath);
    const blob = await loadImageBlob(local && !/^(https?|data|blob|asset|tauri):/i.test(local) ? local : src,
      local && !/^(https?|data|blob|asset|tauri):/i.test(local) ? local : null);
    let bytes = new Uint8Array(await blob.arrayBuffer());
    let type = sniffImageType(bytes);
    if (!type) {
      bytes = new Uint8Array(await (await blobToPng(blob)).arrayBuffer());
      type = 'png';
    }
    const { width, height } = readImageDimensions(bytes) ?? { width: 400, height: 300 };
    return { data: bytes, width, height, type };
  } catch (e) {
    console.warn('[docx] image not embedded', src, e);
    return null;
  }
}

async function prefetchImages(tokens: Token[], imageRoot: string | null, filePath?: string) {
  const srcs = new Set<string>();
  collectImageSrcs(tokens, srcs);
  await Promise.all(
    [...srcs].map(async (src) => srcImages.set(src, await loadDocxImage(src, imageRoot, filePath))),
  );
}

function resolveDocxImageDim(
  img: ImageCache,
  alt: string,
  maxWidth: number,
  tok?: Token,
): { cleanAlt: string; width: number; height: number } {
  const parsed = parseImageAltSize(alt);
  const meta = (tok?.meta || {}) as { eqWidth?: string | null; eqHeight?: string | null };
  const rawW = meta.eqWidth || parsed.width;
  const rawH = meta.eqHeight || parsed.height;
  const parseDimPx = (spec: string | null | undefined, base: number): number | null => {
    if (!spec) return null;
    if (spec.endsWith('%')) {
      const pct = Number.parseFloat(spec.slice(0, -1));
      return pct > 0 ? Math.max(1, Math.round((base * pct) / 100)) : null;
    }
    const px = Number.parseFloat(spec.replace(/px$/i, ''));
    return px > 0 ? Math.max(1, Math.round(px)) : null;
  };
  const explicitW = parseDimPx(rawW, maxWidth);
  const explicitH = parseDimPx(rawH, img.height);
  let w = img.width;
  let h = img.height;
  if (explicitW && explicitH) {
    w = explicitW;
    h = explicitH;
  } else if (explicitW) {
    const ratio = img.width > 0 ? explicitW / img.width : 1;
    w = explicitW;
    h = Math.max(1, Math.round(img.height * ratio));
  } else if (explicitH) {
    const ratio = img.height > 0 ? explicitH / img.height : 1;
    h = explicitH;
    w = Math.max(1, Math.round(img.width * ratio));
  }
  const scaled = scaleDimensions(w, h, maxWidth);
  return { cleanAlt: parsed.alt, width: scaled.width, height: scaled.height };
}

function imageRun(img: ImageCache, alt: string, maxWidth = MAX_IMG_WIDTH, tok?: Token): ImageRun {
  const dim = resolveDocxImageDim(img, alt, maxWidth, tok);
  return new ImageRun({
    type: img.type,
    data: img.data,
    transformation: { width: dim.width, height: dim.height },
    altText: { name: dim.cleanAlt || 'image', description: dim.cleanAlt || 'image' },
  });
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

function scaleDimensions(w: number, h: number, max = MAX_IMG_WIDTH): { width: number; height: number } {
  if (w > max) {
    const ratio = max / w;
    w = max;
    h = Math.round(h * ratio);
  }
  return { width: w, height: h };
}

function buildRuns(inlineToken: Token, style: RunStyle = {}): (TextRun | ImageRun | ExternalHyperlink)[] {
  const out: (TextRun | ImageRun | ExternalHyperlink)[] = [];
  if (!inlineToken.children) {
    if (inlineToken.content) {
      out.push(new TextRun({ text: inlineToken.content, ...toRunOpts(style) }));
    }
    return out;
  }

  const stack: RunStyle[] = [{ ...style }];
  let pendingLink: { href: string; runs: (TextRun | ImageRun | ExternalHyperlink)[] } | null = null;

  const push = (run: TextRun | ImageRun) => {
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
        // #141 — DOCX builds from tokens, so markdown-it's `breaks` renderer
        // option doesn't apply here; honor it manually to match the preview
        // (hard breaks on → single newline is a real line break).
        if (md.options.breaks) {
          push(new TextRun({ text: '', break: 1, ...toRunOpts(cur) }));
        } else {
          push(new TextRun({ text: ' ', ...toRunOpts(cur) }));
        }
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
      case 'math_inline':
        // LaTeX source in a math font, so it reads as a formula rather than
        // as stray prose (Word has no KaTeX).
        push(new TextRun({ text: tok.content, ...toRunOpts(cur), font: MATH_FONT }));
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
              children: pendingLink.runs as (TextRun | ImageRun)[],
            })
          );
          pendingLink = null;
        }
        break;
      case 'image': {
        // An image inside running text (or a list item / table cell). Alone
        // in its paragraph it is handled by buildBody (centered block).
        const src = tok.attrGet('src') || '';
        const img = srcImages.get(src);
        if (img) push(imageRun(img, tok.content || '', MAX_IMG_WIDTH, tok));
        else push(new TextRun({ text: `[${tok.content || 'image'}]`, italics: true, color: '888888' }));
        break;
      }
      case 'html_inline': {
        // A task item's checkbox (markdown.ts task_lists rule): Word has no
        // checkbox run, so write the ballot glyph — readable in Word, and
        // what the DOCX importer turns back into `- [ ]` / `- [x]`.
        if (/task-list-item-checkbox/.test(tok.content || '')) {
          push(new TextRun({ text: /\bchecked\b/.test(tok.content) ? '☑ ' : '☐ ', ...toRunOpts(cur) }));
          break;
        }
        const srcs = htmlImageSrcs(tok.content || '');
        for (const src of srcs) {
          const img = srcImages.get(src);
          if (img) push(imageRun(img, ''));
        }
        break;
      }
      default:
        if (tok.content) push(new TextRun({ text: tok.content, ...toRunOpts(cur) }));
    }
  }
  return out;
}

const MATH_FONT = 'Cambria Math';

/** Display math as its LaTeX source: centred, one line per source line. */
function mathBlockParagraph(latex: string): Paragraph {
  const lines = latex.trim().split('\n');
  return new Paragraph({
    children: lines.flatMap((line, idx) => [
      ...(idx > 0 ? [new TextRun({ break: 1 })] : []),
      new TextRun({ text: line, font: MATH_FONT }),
    ]),
    alignment: mediaAlignmentForRun,
    spacing: { before: 160, after: 160 },
  });
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

/**
 * #427 — `docx` groups paragraphs into a single Word `<w:num>` unless each
 * `<ol>` carries its own `instance` number. Without `instance`, every ordered
 * list in the entire document shares `ordered-list-undefined` and continues
 * numbering from the previous section (`1, 2, 3` → `4, 5` → … → `45`).
 */
interface CollectedDocxHeading {
  anchorId: string;
  level: number;
  text: string;
}

let nextOrderedListInstance = 0;
let nextHeadingAnchorId = 0;

function extractInlinePlainText(inlineToken?: Token): string {
  if (!inlineToken) return '';
  if (!inlineToken.children || inlineToken.children.length === 0) {
    return (inlineToken.content || '').replace(/\s+/g, ' ').trim();
  }
  const parts: string[] = [];
  for (const ch of inlineToken.children) {
    if (ch.type === 'text' || ch.type === 'code_inline' || ch.type === 'math_inline') {
      parts.push(ch.content || '');
    } else if (ch.type === 'softbreak' || ch.type === 'hardbreak') {
      parts.push(' ');
    }
  }
  return parts.join('').replace(/\s+/g, ' ').trim();
}

function escapeXmlText(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

async function buildBody(
  tokens: Token[],
  imageRoot: string | null,
  filePath?: string,
  tocHeadings?: CollectedDocxHeading[],
  hasReference = false,
): Promise<BlockChild[]> {
  const out: BlockChild[] = [];
  let i = 0;
  const listStack: { type: 'bullet' | 'ordered'; instance: number; itemParagraphs: number }[] = [];

  while (i < tokens.length) {
    const tok = tokens[i];
    switch (tok.type) {
      case 'heading_open': {
        const level = tok.tag;
        const inline = tokens[i + 1];
        i += 3;
        const rawLevelNum = Number(level.slice(1)) || 1;
        let effectiveTocLevel = rawLevelNum;
        if (inline?.content) {
          const customLvlMatch = /<!--\s*solomd-toc-level:(\d+)\s*-->/.exec(inline.content);
          if (customLvlMatch) {
            effectiveTocLevel = Math.max(1, Number(customLvlMatch[1]) || rawLevelNum);
          }
          inline.content = inline.content.replace(
            /\s*<!--\s*solomd-toc-(?:level:\d+|folder)\s*-->/g,
            '',
          );
        }
        if (inline?.children) {
          for (const ch of inline.children) {
            if ((ch.type === 'html_inline' || ch.type === 'text') && ch.content) {
              ch.content = ch.content.replace(
                /\s*<!--\s*solomd-toc-(?:level:\d+|folder)\s*-->/g,
                '',
              );
            }
          }
        }
        const headingRuns = buildRuns(inline);
        const anchorId = `_TocSolomd_${++nextHeadingAnchorId}`;
        const plainTitle = extractInlinePlainText(inline);
        if (tocHeadings && plainTitle) {
          tocHeadings.push({
            anchorId,
            level: Math.min(6, Math.max(1, effectiveTocLevel)),
            text: plainTitle,
          });
        }
        out.push(
          new Paragraph({
            heading: HEADING_LEVELS[level],
            ...(hasReference ? {} : { alignment: AlignmentType.LEFT }),
            children: [
              new Bookmark({
                id: anchorId,
                children: headingRuns as (TextRun | ImageRun)[],
              }),
            ],
            ...(hasReference ? {} : { spacing: HEADING_SPACING[level] ?? { before: 240, after: 120 } }),
            keepNext: true,
          })
        );
        break;
      }
      case 'paragraph_open': {
        const inline = tokens[i + 1];
        i += 3;
        const isInList = listStack.length > 0;
        const topList = isInList ? listStack[listStack.length - 1] : null;
        const listLevel = Math.min(Math.max(listStack.length - 1, 0), 8);
        const isFirstListParagraph = topList ? topList.itemParagraphs === 0 : false;
        if (topList) topList.itemParagraphs += 1;

        // Check if this paragraph contains a standalone image (image-only paragraph)
        if (inline && isImageOnlyParagraph(inline)) {
          const imgTok = inline.children!.find(c => c.type === 'image')!;
          const src = imgTok.attrGet('src') || '';
          const alt = imgTok.content || imgTok.attrGet('alt') || '';
          const img = srcImages.get(src);
          if (img) {
            out.push(
              new Paragraph({
                children: [imageRun(img, alt, MAX_IMG_WIDTH, imgTok)],
                alignment: mediaAlignmentForRun,
                spacing: { before: 160, after: 160 },
              })
            );
            break;
          }

          // Fallback: placeholder for an image that could not be read
          out.push(
            new Paragraph({
              children: [
                new TextRun({
                  text: src ? `[image: ${alt}] (${src})` : `[image: ${alt}]`,
                  italics: true,
                  color: '888888',
                }),
              ],
              alignment: mediaAlignmentForRun,
              spacing: { before: 160, after: 160 },
            })
          );
          break;
        }

        out.push(
          new Paragraph({
            alignment: AlignmentType.LEFT,
            children: buildRuns(inline),
            spacing: isInList ? { before: 60, after: 60 } : { before: 120, after: 120 },
            ...(isInList && isFirstListParagraph && topList && {
              numbering:
                topList.type === 'ordered'
                  ? { reference: 'ordered-list', level: listLevel, instance: topList.instance }
                  : undefined,
              bullet:
                topList.type === 'bullet'
                  ? { level: listLevel }
                  : undefined,
            }),
            ...(isInList && !isFirstListParagraph && {
              indent: { left: 720 * (listLevel + 1) },
            }),
          })
        );
        break;
      }
      case 'fence':
      case 'code_block': {
        // #256 — a mermaid fence becomes the diagram, as a PNG (Word has no
        // reliable SVG support). If it cannot be rendered the source falls
        // through to the ordinary code block below.
        // PlantUML (#163): the diagram from the configured server, fetched
        // with the other images before the body is built.
        const pumlImg = srcImages.get(plantumlUrlFor(tok) ?? '');
        if (pumlImg) {
          out.push(
            new Paragraph({
              children: [imageRun(pumlImg, 'PlantUML diagram')],
              alignment: mediaAlignmentForRun,
              spacing: { before: 160, after: 160 },
            })
          );
          i += 1;
          break;
        }
        if (tok.type === 'fence' && (tok.info || '').trim().split(/\s+/)[0].toLowerCase() === 'mermaid') {
          const png = await mermaidToPng(tok.content || '');
          if (png) {
            const dim = scaleDimensions(png.width, png.height);
            out.push(
              new Paragraph({
                children: [
                  new ImageRun({
                    type: 'png',
                    data: png.data,
                    transformation: { width: dim.width, height: dim.height },
                    altText: { name: 'Mermaid diagram', description: 'Mermaid diagram' },
                  }),
                ],
                alignment: mediaAlignmentForRun,
                spacing: { before: 160, after: 160 },
              })
            );
            i += 1;
            break;
          }
        }
        const lines = (tok.content || '').replace(/\n$/, '').split('\n');
        const last = lines.length - 1;
        lines.forEach((line, idx) => {
          out.push(
            new Paragraph({
              alignment: AlignmentType.LEFT,
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
      case 'html_block': {
        if (/<!--\s*solomd-page-break\s*-->/i.test(tok.content || '')) {
          out.push(new Paragraph({ children: [new PageBreak()] }));
          i += 1;
          break;
        }
        // A pasted `<img>` block (common when copying from the web). Other
        // raw HTML still has no DOCX equivalent and is skipped as before.
        const imgs = htmlImageSrcs(tok.content || '')
          .map((src) => srcImages.get(src))
          .filter((x): x is ImageCache => !!x);
        if (imgs.length) {
          out.push(
            new Paragraph({
              children: imgs.map((img) => imageRun(img, '')),
              alignment: mediaAlignmentForRun,
              spacing: { before: 160, after: 160 },
            })
          );
        }
        i += 1;
        break;
      }
      case 'math_block':
      case 'math_block_eqno': {
        // Word has no KaTeX: keep display math as its LaTeX source, one
        // centred Cambria Math line per source line, rather than dropping it
        // (same choice as the CLI exporter, scripts/solomd-export.mjs).
        out.push(mathBlockParagraph(tok.content || ''));
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
        // Build runs directly from each inner paragraph's inline tokens
        // instead of round-tripping through buildBody → Paragraph and
        // trying to re-extract `.options.children`. The `docx` library's
        // Paragraph instances don't expose constructor children publicly,
        // so the old extraction returned [] and produced empty
        // bordered paragraphs (issue: blockquotes vanished on docx export).
        let j = 0;
        while (j < inner.length) {
          const t = inner[j];
          if (t.type === 'paragraph_open') {
            const inlineTok = inner[j + 1];
            const runs = inlineTok && inlineTok.type === 'inline'
              ? buildRuns(inlineTok)
              : [];
            out.push(
              new Paragraph({
                children: runs.length > 0 ? (runs as TextRun[]) : [new TextRun({ text: ' ' })],
                alignment: AlignmentType.LEFT,
                indent: { left: 360 },
                spacing: { before: 80, after: 80 },
                border: {
                  left: { style: BorderStyle.SINGLE, size: 18, color: 'FF9F40', space: 8 },
                },
              })
            );
            // Skip paragraph_open, inline, paragraph_close
            j += 3;
          } else {
            // Non-paragraph children (nested lists, fenced code, headings,
            // tables) — recurse so they keep their structure. They render
            // without the blockquote indent, which matches how most docx
            // renderers handle nested non-paragraph blockquoted content.
            const sliceEnd = (() => {
              if (t.type.endsWith('_open')) {
                const closeType = t.type.replace(/_open$/, '_close');
                return findMatchingClose(inner, j, t.type, closeType) + 1;
              }
              return j + 1;
            })();
            const nestedBlocks = await buildBody(
              inner.slice(j, sliceEnd),
              imageRoot,
              filePath,
              tocHeadings,
            );
            for (const b of nestedBlocks) out.push(b);
            j = sliceEnd;
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
        listStack.push({ type: 'bullet', instance: 0, itemParagraphs: 0 });
        i += 1;
        break;
      case 'ordered_list_open':
        listStack.push({ type: 'ordered', instance: ++nextOrderedListInstance, itemParagraphs: 0 });
        i += 1;
        break;
      case 'bullet_list_close':
      case 'ordered_list_close':
        listStack.pop();
        i += 1;
        break;
      case 'list_item_open':
        if (listStack.length > 0) {
          listStack[listStack.length - 1].itemParagraphs = 0;
        }
        i += 1;
        break;
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
              ? [new Paragraph({ alignment: AlignmentType.LEFT, children: runs, spacing: { before: 40, after: 40 } })]
              : [new Paragraph({ alignment: AlignmentType.LEFT, text: '' })];
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

/** Title page: title, then author and date if the document names them. Ends
 *  with a page break so the body starts on page two. */
function buildCover(tpl: DocxTemplate): Paragraph[] {
  const out: Paragraph[] = [
    new Paragraph({ text: '', spacing: { before: 2400 } }),
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { after: 400 },
      children: [new TextRun({ text: tpl.title || 'Untitled', bold: true, size: 56 })],
    }),
  ];
  // Empty fields are skipped rather than printed as blank lines — a cover with
  // a stray gap where the author should be looks like a bug.
  if (tpl.author) {
    out.push(
      new Paragraph({
        alignment: AlignmentType.CENTER,
        spacing: { after: 120 },
        children: [new TextRun({ text: tpl.author, size: 28 })],
      }),
    );
  }
  if (tpl.date) {
    out.push(
      new Paragraph({
        alignment: AlignmentType.CENTER,
        children: [new TextRun({ text: tpl.date, size: 24 })],
      }),
    );
  }
  out.push(new Paragraph({ children: [new PageBreak()] }));
  return out;
}

/**
 * #553 — Apply a user's .docx as a Word "reference document".
 *
 * The `docx` library builds a document from scratch; it cannot open an
 * existing .docx as a template. Word's own "reference doc" convention (the
 * one pandoc's `--reference-doc` uses) needs only a handful of package parts,
 * so we swap those parts into the freshly generated zip:
 *
 *   - `word/styles.xml`  — Normal / Heading1..6 / caption / TOC styles, i.e.
 *     the fonts, sizes, colours and paragraph spacing the user set up.
 *   - `word/fontTable.xml`, `word/theme/theme1.xml` — fonts / theme colours
 *     those styles point at.
 *   - `<w:pgSz>` / `<w:pgMar>` from the template's `word/document.xml` —
 *     paper size and margins.
 *
 * Existing parts are replaced in place (the manifests stay valid); the theme
 * is added together with its content-type override and relationship because
 * the generator does not emit one. Numbering, headers and footers are
 * deliberately left alone: the generator's list numbering and preset-driven
 * header/footer would otherwise point at ids and media that were never copied
 * in. An unreadable / non-DOCX file is ignored rather than failing the whole
 * export.
 */
const REFERENCE_STYLE_PARTS = [
  'word/styles.xml',
  'word/stylesWithEffects.xml',
  'word/fontTable.xml',
];
const THEME_PART = 'word/theme/theme1.xml';

interface ParsedTemplateStyle {
  styleId: string;
  name: string;
  aliases: string[];
  outlineLvl: number | null;
  isDefault: boolean;
}

/**
 * #603 — Parse paragraph styles in the reference template's `word/styles.xml`
 * so `Heading1..Heading6` generated by `docx` can be remapped to the template's
 * actual `w:styleId` (e.g. WPS/Chinese Word templates where `<w:name w:val="heading 1"/>`
 * has `w:styleId="2"`, `<w:name w:val="heading 2"/>` has `w:styleId="5"`, etc.).
 */
function parseTemplateHeadingStyles(stylesXml: string): {
  headingIds: Record<number, string | null>;
  normalId: string | null;
} {
  const styles: ParsedTemplateStyle[] = [];
  const styleBlockRe = /<w:style\b([^>]*)>([\s\S]*?)<\/w:style>/g;
  let m: RegExpExecArray | null;
  while ((m = styleBlockRe.exec(stylesXml)) !== null) {
    const attrs = m[1];
    const body = m[2];
    const typeMatch = /\bw:type="([^"]+)"/.exec(attrs);
    const stype = typeMatch ? typeMatch[1] : 'paragraph';
    if (stype !== 'paragraph') continue;
    const idMatch = /\bw:styleId="([^"]+)"/.exec(attrs);
    if (!idMatch) continue;
    const isDefault = /\bw:default="(?:1|true)"/i.test(attrs);
    const nameMatch = /<w:name\b[^>]*\bw:val="([^"]+)"/.exec(body);
    const aliasMatch = /<w:aliases\b[^>]*\bw:val="([^"]+)"/.exec(body);
    const olMatch = /<w:outlineLvl\b[^>]*\bw:val="(\d+)"/.exec(body);
    styles.push({
      styleId: idMatch[1],
      name: nameMatch ? nameMatch[1].trim() : '',
      aliases: aliasMatch ? aliasMatch[1].split(',').map((s) => s.trim()).filter(Boolean) : [],
      outlineLvl: olMatch ? Number(olMatch[1]) : null,
      isDefault,
    });
  }

  const normalStyle =
    styles.find((s) => /^(?:normal|正文)$/i.test(s.name)) ||
    styles.find((s) => s.styleId === 'Normal') ||
    styles.find((s) => s.isDefault);

  const headingIds: Record<number, string | null> = {};
  for (let level = 1; level <= 6; level++) {
    const targetNames = new Set([
      `heading ${level}`,
      `heading${level}`,
      `标题 ${level}`,
      `标题${level}`,
      `überschrift ${level}`,
      `titre ${level}`,
      `título ${level}`,
    ]);
    const byName = styles.find((s) => {
      const candidates = [s.name, ...s.aliases].map((x) => x.toLowerCase());
      return candidates.some((c) => targetNames.has(c));
    });
    if (byName) {
      headingIds[level] = byName.styleId;
      continue;
    }
    const byExactId = styles.find((s) => s.styleId === `Heading${level}`);
    if (byExactId) {
      headingIds[level] = byExactId.styleId;
      continue;
    }
    const byOutline = styles.find(
      (s) => s.outlineLvl === level - 1 && !/^(?:toc\b|目录)/i.test(s.name),
    );
    headingIds[level] = byOutline ? byOutline.styleId : null;
  }

  return { headingIds, normalId: normalStyle ? normalStyle.styleId : null };
}

/**
 * #603 — Merge `word/numbering.xml` from the reference template with the
 * generated document's list numbering so heading multilevel numbering defined
 * in `template['word/styles.xml']` (`<w:numId w:val="1"/>` etc.) keeps working
 * without colliding with `docx` library's bullet/ordered list `numId`s.
 */
function mergeNumberingWithTemplate(
  merged: Record<string, Uint8Array>,
  templateNumberingBytes: Uint8Array,
): void {
  const tplNumXml = strFromU8(templateNumberingBytes);
  let maxId = 0;
  for (const m of tplNumXml.matchAll(/\bw:(?:abstractNumId|numId)="(\d+)"/g)) {
    const n = Number(m[1]);
    if (n > maxId) maxId = n;
  }
  const offset = maxId + 10;

  if (merged['word/numbering.xml'] && merged['word/document.xml']) {
    let genNumXml = strFromU8(merged['word/numbering.xml']);
    genNumXml = genNumXml
      .replace(/(\bw:abstractNumId=")(\d+)(")/g, (_all, p1, num, p3) => `${p1}${Number(num) + offset}${p3}`)
      .replace(/(<w:abstractNumId\b[^>]*\bw:val=")(\d+)(")/g, (_all, p1, num, p3) => `${p1}${Number(num) + offset}${p3}`)
      .replace(/(\bw:numId=")(\d+)(")/g, (_all, p1, num, p3) => `${p1}${Number(num) + offset}${p3}`);

    const absBlocks = genNumXml.match(/<w:abstractNum\b[\s\S]*?<\/w:abstractNum>/g) ?? [];
    const numBlocks = genNumXml.match(/<w:num\b[\s\S]*?<\/w:num>/g) ?? [];

    let combined = tplNumXml;
    if (absBlocks.length > 0) {
      const firstNumIdx = combined.indexOf('<w:num ');
      const firstNumIdx2 = combined.indexOf('<w:num>');
      const insertAt =
        firstNumIdx >= 0 && firstNumIdx2 >= 0
          ? Math.min(firstNumIdx, firstNumIdx2)
          : firstNumIdx >= 0
            ? firstNumIdx
            : firstNumIdx2;
      if (insertAt >= 0) {
        combined = combined.slice(0, insertAt) + absBlocks.join('') + combined.slice(insertAt);
      } else {
        combined = combined.replace('</w:numbering>', `${absBlocks.join('')}</w:numbering>`);
      }
    }
    if (numBlocks.length > 0) {
      combined = combined.replace('</w:numbering>', `${numBlocks.join('')}</w:numbering>`);
    }
    merged['word/numbering.xml'] = strToU8(combined);

    let docXml = strFromU8(merged['word/document.xml']);
    docXml = docXml.replace(
      /(<w:numId\b[^>]*\bw:val=")(\d+)(")/g,
      (_all, p1, num, p3) => `${p1}${Number(num) + offset}${p3}`,
    );
    merged['word/document.xml'] = strToU8(docXml);
  } else {
    merged['word/numbering.xml'] = templateNumberingBytes;
  }

  const typesName = '[Content_Types].xml';
  if (merged[typesName]) {
    let types = strFromU8(merged[typesName]);
    if (!types.includes('PartName="/word/numbering.xml"')) {
      types = types.replace(
        '</Types>',
        '<Override ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml" ' +
          'PartName="/word/numbering.xml"/></Types>',
      );
      merged[typesName] = strToU8(types);
    }
  }
  const relsName = 'word/_rels/document.xml.rels';
  if (merged[relsName]) {
    let rels = strFromU8(merged[relsName]);
    if (!rels.includes('/relationships/numbering"')) {
      rels = rels.replace(
        '</Relationships>',
        '<Relationship Id="rIdSolomdNumbering" ' +
          'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" ' +
          'Target="numbering.xml"/></Relationships>',
      );
      merged[relsName] = strToU8(rels);
    }
  }
}

async function applyDocxReference(blob: Blob, reference: Uint8Array): Promise<Blob> {
  let generated: Record<string, Uint8Array>;
  let template: Record<string, Uint8Array>;
  try {
    generated = unzipSync(new Uint8Array(await blob.arrayBuffer()));
    template = unzipSync(reference);
  } catch (e) {
    console.warn('[docx] reference template is not a readable .docx, ignoring it', e);
    return blob;
  }
  if (!template['word/styles.xml']) {
    console.warn('[docx] reference template has no word/styles.xml, ignoring it');
    return blob;
  }

  const merged: Record<string, Uint8Array> = {};
  for (const [name, data] of Object.entries(generated)) {
    if (!name.endsWith('/')) merged[name] = data;
  }
  for (const name of REFERENCE_STYLE_PARTS) {
    if (template[name] && merged[name]) merged[name] = template[name];
  }

  // The generated package has no theme part of its own, so the template's
  // theme has to be declared in both manifests before it can be added —
  // otherwise Word reports a corrupt document.
  if (template[THEME_PART]) {
    merged[THEME_PART] = template[THEME_PART];
    const typesName = '[Content_Types].xml';
    if (merged[typesName]) {
      let types = strFromU8(merged[typesName]);
      if (!types.includes(`PartName="/${THEME_PART}"`)) {
        types = types.replace(
          '</Types>',
          '<Override ContentType="application/vnd.openxmlformats-officedocument.theme+xml" ' +
            `PartName="/${THEME_PART}"/></Types>`,
        );
        merged[typesName] = strToU8(types);
      }
    }
    const relsName = 'word/_rels/document.xml.rels';
    if (merged[relsName]) {
      let rels = strFromU8(merged[relsName]);
      if (!rels.includes('/relationships/theme"')) {
        rels = rels.replace(
          '</Relationships>',
          '<Relationship Id="rIdSolomdTheme" ' +
            'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" ' +
            'Target="theme/theme1.xml"/></Relationships>',
        );
        merged[relsName] = strToU8(rels);
      }
    }
  }

  const tplDoc = template['word/document.xml'] ? strFromU8(template['word/document.xml']) : '';
  if (tplDoc && merged['word/document.xml']) {
    const lastMatch = (re: RegExp): string | null => {
      const found = tplDoc.match(re);
      return found && found.length ? found[found.length - 1] : null;
    };
    const pgSz = lastMatch(/<w:pgSz\b[^>]*\/>/g);
    const pgMar = lastMatch(/<w:pgMar\b[^>]*\/>/g);
    let docXml = strFromU8(merged['word/document.xml']);
    if (pgSz) docXml = docXml.replace(/<w:pgSz\b[^>]*\/>/g, pgSz);
    if (pgMar) docXml = docXml.replace(/<w:pgMar\b[^>]*\/>/g, pgMar);
    merged['word/document.xml'] = strToU8(docXml);
  }

  if (template['word/numbering.xml']) {
    mergeNumberingWithTemplate(merged, template['word/numbering.xml']);
  }

  // #603 — Remap `<w:pStyle w:val="Heading1..6"/>` to the reference template's
  // real heading `styleId`s, or inject `<w:outlineLvl w:val="N-1"/>` when the
  // template omits a style for that heading level so Word/WPS Navigation Pane
  // and TOC still recognize every heading level.
  if (merged['word/document.xml']) {
    const { headingIds, normalId } = parseTemplateHeadingStyles(strFromU8(template['word/styles.xml']));
    let docXml = strFromU8(merged['word/document.xml']);
    docXml = docXml.replace(/<w:pStyle\s+w:val="Heading([1-6])"\s*\/>/g, (_match, lvlStr) => {
      const lvl = Number(lvlStr);
      const mappedId = headingIds[lvl];
      if (mappedId) {
        return `<w:pStyle w:val="${escapeXmlText(mappedId)}"/>`;
      }
      const fallbackStyle = normalId
        ? `<w:pStyle w:val="${escapeXmlText(normalId)}"/>`
        : '';
      return `${fallbackStyle}<w:outlineLvl w:val="${lvl - 1}"/>`;
    });
    merged['word/document.xml'] = strToU8(docXml);
  }

  return new Blob([zipSync(merged, { level: 6 })], {
    type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  });
}

/**
 * #592 & #593 — Post-process the generated DOCX ZIP so that:
 * 1) `word/settings.xml` sets `<w:doNotExpandShiftReturn/>` (preventing Word/WPS
 *    from stretching lines ending in `<w:br/>` across the full page width) and
 *    `<w:updateFields w:val="true"/>` when a TOC is present;
 * 2) When a `TableOfContents` (`TOC \h \o "1-6"`) is present, pre-populate its
 *    cached field result between `separate` and `end` with indented, clickable
 *    `<w:hyperlink w:anchor="_TocSolomd_N">` entries so WPS Office, Word, Pages,
 *    and QuickLook display the full Table of Contents immediately on open (#593).
 */
async function postProcessDocxPackage(
  blob: Blob,
  wantToc: boolean,
  tocHeadings: CollectedDocxHeading[],
): Promise<Blob> {
  const archive = unzipSync(new Uint8Array(await blob.arrayBuffer()));

  if (archive['word/settings.xml']) {
    let settingsXml = strFromU8(archive['word/settings.xml']);
    if (!settingsXml.includes('<w:doNotExpandShiftReturn')) {
      if (settingsXml.includes('<w:compat>')) {
        settingsXml = settingsXml.replace('<w:compat>', '<w:compat><w:doNotExpandShiftReturn/>');
      } else {
        settingsXml = settingsXml.replace(
          '</w:settings>',
          '<w:compat><w:doNotExpandShiftReturn/></w:compat></w:settings>',
        );
      }
    }
    if (wantToc && !settingsXml.includes('<w:updateFields')) {
      settingsXml = settingsXml.replace('</w:settings>', '<w:updateFields w:val="true"/></w:settings>');
    }
    archive['word/settings.xml'] = strToU8(settingsXml);
  }

  if (wantToc && tocHeadings.length > 0 && archive['word/document.xml']) {
    let docXml = strFromU8(archive['word/document.xml']);
    const tocCachedXml = tocHeadings
      .map((h) => {
        const indentTwips = Math.max(0, (h.level - 1) * 320);
        const boldTag = h.level === 1 ? '<w:b/>' : '';
        const sizeHalfPt = h.level === 1 ? 24 : h.level === 2 ? 22 : 21;
        return (
          `<w:p><w:pPr><w:jc w:val="left"/>` +
          (indentTwips > 0 ? `<w:ind w:left="${indentTwips}"/>` : '') +
          `<w:spacing w:before="40" w:after="60"/></w:pPr>` +
          `<w:hyperlink w:history="1" w:anchor="${escapeXmlText(h.anchorId)}">` +
          `<w:r><w:rPr>${boldTag}<w:color w:val="1F2328"/><w:sz w:val="${sizeHalfPt}"/></w:rPr>` +
          `<w:t xml:space="preserve">${escapeXmlText(h.text)}</w:t></w:r>` +
          `</w:hyperlink></w:p>`
        );
      })
      .join('');
    docXml = docXml.replace(
      /(<w:instrText[^>]*>\s*TOC\b[\s\S]*?<w:fldChar w:fldCharType="separate"\s*\/>\s*<\/w:r>\s*<\/w:p>)/,
      `$1${tocCachedXml}`,
    );
    archive['word/document.xml'] = strToU8(docXml);
  }

  return new Blob([zipSync(archive, { level: 6 })], {
    type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  });
}

export async function markdownToDocxBlob(
  source: string,
  _title = 'Document',
  filePath?: string,
  preset: DocxPreset = 'plain',
  /** Heading printed above the table of contents. Passed in because this
   *  module has no access to the i18n store. */
  contentsLabel = 'Contents',
  /** PlantUML server when PlantUML is on (#163); fences become diagrams. */
  plantumlServer: string | null = null,
  /** #553 — bytes of the user's .docx reference template, when configured. */
  referenceDocx?: Uint8Array | null,
  /** #572 — explicit override for whether to generate a leading Table of Contents page. */
  includeTocPage?: boolean,
  /** #597 — merged folder book export: keep folder name as Page 1 cover title without adding a root Heading 1 bookmark. */
  isMergedBook?: boolean,
  /** #624 — alignment for images, diagrams, and display math blocks (`left` | `center` | `right`). */
  mediaAlign: 'left' | 'center' | 'right' = 'center',
): Promise<Blob> {
  srcImages.clear();
  nextOrderedListInstance = 0;
  nextHeadingAnchorId = 0;
  plantumlServerForRun = plantumlServer;
  mediaAlignmentForRun =
    mediaAlign === 'left'
      ? AlignmentType.LEFT
      : mediaAlign === 'right'
        ? AlignmentType.RIGHT
        : AlignmentType.CENTER;
  // Apply the same leniency preprocessors the HTML render path uses (malformed
  // table delimiters, list re-indent, inline-HTML blocks) so DOCX export
  // doesn't silently drop tables/lists the preview shows correctly.
  const cleanedSource = (source ?? '').replace(/^[ \t]*\[toc\][ \t]*\r?\n?/gim, '');
  const tokens = md.parse(preprocessMarkdown(cleanedSource), {});
  const imageRoot = extractImageRoot(source || '');
  await prefetchImages(tokens, imageRoot, filePath);
  const hasReference = Boolean(referenceDocx && referenceDocx.length > 0);
  const tocHeadings: CollectedDocxHeading[] = [];
  const blocks = await buildBody(tokens, imageRoot, filePath, tocHeadings, hasReference);
  if (blocks.length === 0) blocks.push(new Paragraph({ alignment: AlignmentType.LEFT, text: '' }));

  const tpl = resolveDocxTemplate(preset, source ?? '', _title, {
    preferFallbackTitle: Boolean(isMergedBook),
  });
  const headerText = renderHeaderText(tpl);
  const showCover = tpl.cover || Boolean(isMergedBook);

  const front: BlockChild[] = [];
  if (showCover) front.push(...buildCover(tpl));
  const wantToc = typeof includeTocPage === 'boolean' ? includeTocPage : tpl.toc;
  if (wantToc) {
    // Emit a real Word TOC field (`TOC \h \o "1-6"`) AND pre-populate its cached
    // `<w:sdtContent>` entries in `postProcessDocxPackage` (#593) so both WPS
    // Office and Word render the complete clickable TOC immediately on open.
    // #597 — Use a non-heading bold paragraph for the TOC title so "目录" does
    // not enter Word's outline/bookmark tree.
    front.push(
      new Paragraph({
        ...(hasReference ? {} : { alignment: AlignmentType.LEFT }),
        spacing: { before: 240, after: 180 },
        children: [new TextRun({ text: contentsLabel, bold: true, size: 32 })],
      }),
      new TableOfContents(contentsLabel, { hyperlink: true, headingStyleRange: '1-6' }),
      new Paragraph({ children: [new PageBreak()] }),
    );
  }

  const orderedFormats = ['decimal', 'lowerLetter', 'lowerRoman'] as const;
  const doc = new Document({
    creator: 'SoloMD',
    title: tpl.title || _title,
    description: 'Exported from SoloMD',
    features: wantToc ? { updateFields: true } : undefined,
    styles: {
      default: {
        document: {
          run: {
            size: tpl.fontSizePt * 2, // docx counts half-points
            ...(tpl.fontFamily ? { font: tpl.fontFamily } : {}),
          },
          paragraph: {
            alignment: AlignmentType.LEFT,
            spacing: {
              after: Math.round(tpl.paragraphSpacingPt * 20), // twips
              line: Math.round(tpl.lineSpacing * 240),
              lineRule: LineRuleType.AUTO,
            },
          },
        },
      },
    },
    numbering: {
      config: [
        {
          reference: 'ordered-list',
          levels: Array.from({ length: 9 }, (_, level) => ({
            level,
            format: orderedFormats[level % 3],
            text: `%${level + 1}.`,
            alignment: AlignmentType.START,
            style: {
              paragraph: {
                indent: { left: 720 * (level + 1), hanging: 360 },
              },
            },
          })),
        },
      ],
    },
    sections: [
      {
        properties: {
          // With a cover page, `titlePage` gives page one its own (empty)
          // header and footer — a running header across the title page is
          // the giveaway that a template was bolted on.
          titlePage: showCover,
        },
        headers: headerText
          ? {
              default: new Header({
                children: [
                  new Paragraph({
                    alignment: AlignmentType.RIGHT,
                    children: [new TextRun({ text: headerText, size: 18, color: '888888' })],
                  }),
                ],
              }),
              first: new Header({ children: [new Paragraph({ text: '' })] }),
            }
          : undefined,
        footers: tpl.pageNumbers
          ? {
              default: new Footer({
                children: [
                  new Paragraph({
                    alignment: AlignmentType.CENTER,
                    children: [
                      new TextRun({ children: [PageNumber.CURRENT], size: 18, color: '888888' }),
                    ],
                  }),
                ],
              }),
              first: new Footer({ children: [new Paragraph({ text: '' })] }),
            }
          : undefined,
        children: [...front, ...blocks],
      },
    ],
  });

  const rawGenerated = await Packer.toBlob(doc);
  const generated = await postProcessDocxPackage(rawGenerated, wantToc, tocHeadings);
  return referenceDocx ? applyDocxReference(generated, referenceDocx) : generated;
}
