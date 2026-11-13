/**
 * #552 — PDF page-break reference lines & page indicator for the editor.
 *
 * Computes where PDF pages will break across source lines using the active PDF
 * page setup (`Settings → PDF` + per-note YAML `pdf:` front matter) and renders
 * optional visual page-break guide lines in both CodeMirror and the plain
 * block editor.
 */

import { EditorView, Decoration, WidgetType, type DecorationSet } from '@codemirror/view';
import { StateField, RangeSetBuilder, type Extension, type EditorState } from '@codemirror/state';
import { defaultPdfDefaults, type PdfDefaults } from '../stores/settings';
import { resolvePdfOptions } from './pdf-options';
import { printableBox } from './print-pages';

export interface PdfPageBreak {
  /** 1-based editor line number where `page` begins (for `page >= 2`). */
  line: number;
  /** 1-based PDF page number starting at `line` (2, 3, ...). */
  page: number;
}

export interface PdfPageBreakResult {
  /** Total number of PDF pages (>= 1). */
  totalPages: number;
  /** Human-readable paper label, e.g. `A4`, `Letter`, `Custom`. */
  pageSizeLabel: string;
  /** Ordered page breaks for page 2..N. */
  breaks: PdfPageBreak[];
  /** Return the 1-based PDF page number containing 1-based editor line `line`. */
  pageForLine(line: number): number;
}

const PT_TO_PX = 96 / 72;

const EXPLICIT_PAGE_BREAK_RE =
  /^(?:<!--\s*page[-_ ]?break\s*-->|\\pagebreak\b|\\newpage\b|<div\b[^>]*(?:page-break-(?:after|before)\s*:\s*always|break-(?:after|before)\s*:\s*page)[^>]*>\s*<\/div>|<hr\b[^>]*class=["'][^"']*page-break[^"']*["'][^>]*\/?>)\s*$/i;

/** Estimate visual width in `em` units for one line of Markdown text. */
function visualEmWidth(text: string): number {
  // Strip common inline markdown markers so syntax characters don't inflate print width
  const clean = text
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/(\*\*|__|~~|`)/g, '');
  let em = 0;
  for (const ch of clean) {
    const code = ch.codePointAt(0) ?? 0;
    if (
      (code >= 0x2e80 && code <= 0x9fff) ||
      (code >= 0xac00 && code <= 0xd7af) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xff00 && code <= 0xffef) ||
      (code >= 0x20000 && code <= 0x2fa1f)
    ) {
      em += 1.0;
    } else if (ch === '\t') {
      em += 2.0;
    } else {
      em += 0.54;
    }
  }
  return Math.max(0.5, em);
}

function estimateImageHeightPx(lineText: string, maxPrintableHeight: number): number {
  // Check for `#w200`, `|300`, `|300x180`, or `height="200"` / `width="300"`
  const dimMatch =
    lineText.match(/\|(\d+)(?:x(\d+))?\s*\]/) ||
    lineText.match(/#w(\d+)/i);
  if (dimMatch) {
    const w = Number(dimMatch[1]);
    const h = dimMatch[2] ? Number(dimMatch[2]) : Math.round(w * 0.62);
    if (Number.isFinite(h) && h > 0) {
      return Math.min(maxPrintableHeight * 0.75, Math.max(48, h));
    }
  }
  const htmlH = lineText.match(/\bheight=["']?(\d+)/i);
  if (htmlH) {
    const h = Number(htmlH[1]);
    if (Number.isFinite(h) && h > 0) {
      return Math.min(maxPrintableHeight * 0.75, Math.max(48, h));
    }
  }
  return Math.min(maxPrintableHeight * 0.45, 220);
}

/**
 * Compute PDF page breaks and per-line page numbers for `markdown`.
 */
export function computePdfPageBreaks(
  markdown: string,
  pdfDefaults: PdfDefaults = defaultPdfDefaults(),
): PdfPageBreakResult {
  const opts = resolvePdfOptions(pdfDefaults, markdown, true);
  const box = printableBox(
    opts.pageSizeMm ?? { width: 210, height: 297 },
    opts.marginMm ?? { top: 15, right: 15, bottom: 15, left: 15 },
  ) ?? { width: 680, height: 1009 };

  const fontSizePx = Math.max(8, opts.fontSizePt || 11) * PT_TO_PX;
  const bodyLineHeight = fontSizePx * 1.68;
  const paragraphGap = fontSizePx * 0.85;
  // Reserve footer space when footer is enabled
  const footerReserve = opts.footer ? 28 : 0;
  const pageHeight = Math.max(180, box.height - footerReserve);
  const lineEmCapacity = Math.max(12, box.width / fontSizePx);

  const rawLines = markdown.split(/\r?\n/);
  const totalLines = rawLines.length;

  const breaks: PdfPageBreak[] = [];
  let currentPage = 1;
  let y = 0;

  const startNewPageAt = (lineNum1: number) => {
    const clampedLine = Math.max(1, Math.min(totalLines, lineNum1));
    if (breaks.length > 0 && breaks[breaks.length - 1].line === clampedLine) {
      return;
    }
    currentPage += 1;
    breaks.push({ line: clampedLine, page: currentPage });
    y = 0;
  };

  // Detect YAML front matter at the top of the document (not rendered in PDF)
  let startIdx = 0;
  if (rawLines[0]?.replace(/^\uFEFF/, '').trim() === '---') {
    for (let i = 1; i < rawLines.length; i++) {
      if (rawLines[i].trim() === '---' || rawLines[i].trim() === '...') {
        startIdx = i + 1;
        break;
      }
    }
  }

  // If `opts.toc` is enabled at the PDF settings/frontmatter level, reserve TOC space at top of page 1
  if (opts.toc) {
    let headingCount = 0;
    let inFence = false;
    for (let i = startIdx; i < rawLines.length; i++) {
      const t = rawLines[i].trim();
      if (/^(```|~~~)/.test(t)) {
        inFence = !inFence;
        continue;
      }
      if (!inFence && /^#{1,6}\s+\S/.test(t)) headingCount++;
    }
    if (headingCount > 0) {
      const tocHeight = 44 + headingCount * (fontSizePx * 1.55);
      y += tocHeight;
      while (y >= pageHeight && startIdx < rawLines.length) {
        y -= pageHeight;
        currentPage += 1;
      }
    }
  }

  let i = startIdx;
  while (i < rawLines.length) {
    const lineNum = i + 1;
    const raw = rawLines[i];
    const trimmed = raw.trim();

    // Blank line
    if (!trimmed) {
      i++;
      continue;
    }

    // Explicit page break marker
    if (EXPLICIT_PAGE_BREAK_RE.test(trimmed)) {
      let nextLine = i + 1;
      while (nextLine < rawLines.length && !rawLines[nextLine].trim()) {
        nextLine++;
      }
      if (nextLine < rawLines.length) {
        startNewPageAt(nextLine + 1);
      }
      i = nextLine;
      continue;
    }

    // Inline [TOC] / [[toc]] marker
    if (/^(?:\[toc\]|\[\[toc\]\])$/i.test(trimmed)) {
      let headingCount = 0;
      for (let k = startIdx; k < rawLines.length; k++) {
        if (/^#{1,6}\s+\S/.test(rawLines[k].trim())) headingCount++;
      }
      const tocH = 40 + Math.max(1, headingCount) * (fontSizePx * 1.5);
      if (y > 0 && y + Math.min(tocH, 120) > pageHeight) {
        startNewPageAt(lineNum);
      }
      y += tocH;
      while (y > pageHeight) {
        y -= pageHeight;
        if (i + 1 < rawLines.length) startNewPageAt(i + 2);
      }
      i++;
      continue;
    }

    // Fenced code block or diagram fence (``` / ~~~)
    const fenceMatch = trimmed.match(/^(```+|~~~+)\s*([\w-]*)/);
    if (fenceMatch) {
      const fenceMarker = fenceMatch[1][0];
      const fenceLen = fenceMatch[1].length;
      const lang = (fenceMatch[2] || '').toLowerCase();
      const fenceStartLine = lineNum;
      let end = i + 1;
      const closeRe = new RegExp(`^\\s*${fenceMarker}{${fenceLen},}\\s*$`);
      while (end < rawLines.length && !closeRe.test(rawLines[end])) {
        end++;
      }
      const innerLineCount = Math.max(1, end - (i + 1));
      const isDiagram =
        lang === 'mermaid' ||
        lang === 'markmap' ||
        lang === 'excalidraw' ||
        lang === 'tldraw' ||
        lang === 'board';

      if (isDiagram) {
        const diagH = Math.min(pageHeight * 0.55, Math.max(140, innerLineCount * 22 + 48));
        if (y > 0 && y + diagH > pageHeight) {
          startNewPageAt(fenceStartLine);
        }
        y += diagH + paragraphGap;
      } else {
        const codeLineH = fontSizePx * 1.42;
        const padV = 24;
        // Opening padding + first line
        if (y > 0 && y + padV + codeLineH > pageHeight) {
          startNewPageAt(fenceStartLine);
        }
        y += padV / 2;
        for (let k = i + 1; k < end; k++) {
          const codeText = rawLines[k] ?? '';
          const wrapped = Math.max(1, Math.ceil(visualEmWidth(codeText) / (lineEmCapacity * 1.08)));
          const h = wrapped * codeLineH;
          if (y > 0 && y + h > pageHeight) {
            startNewPageAt(k + 1);
          }
          y += h;
        }
        y += padV / 2 + paragraphGap;
      }
      i = Math.min(rawLines.length, end + 1);
      continue;
    }

    // Display math block ($$ ... $$)
    if (trimmed.startsWith('$$')) {
      const mathStartLine = lineNum;
      let end = i;
      if (!(trimmed.length > 2 && trimmed.endsWith('$$'))) {
        end = i + 1;
        while (end < rawLines.length && !rawLines[end].trim().endsWith('$$')) {
          end++;
        }
      }
      const mathLines = Math.max(1, end - i + 1);
      const mathH = 28 + mathLines * (fontSizePx * 1.45);
      if (y > 0 && y + mathH > pageHeight) {
        startNewPageAt(mathStartLine);
      }
      y += mathH + paragraphGap;
      i = Math.min(rawLines.length, end + 1);
      continue;
    }

    // Heading (# .. ######)
    const headingMatch = trimmed.match(/^(#{1,6})\s+(.*)$/);
    if (headingMatch) {
      const level = headingMatch[1].length;
      const scale = [1.85, 1.5, 1.25, 1.1, 1.0, 0.95][level - 1] ?? 1.0;
      const hFontSize = fontSizePx * scale;
      const hLineHeight = hFontSize * 1.35;
      const wrapped = Math.max(
        1,
        Math.ceil(visualEmWidth(headingMatch[2]) / Math.max(8, box.width / hFontSize)),
      );
      const marginTop = y === 0 ? 0 : hFontSize * 0.9;
      const marginBottom = hFontSize * 0.45;
      const headingH = marginTop + wrapped * hLineHeight + marginBottom;
      // CSS `break-after: avoid`: keep heading with at least ~2 lines of the following block
      const keepWithNextH = bodyLineHeight * 2;
      if (y > 0 && y + headingH + keepWithNextH > pageHeight) {
        startNewPageAt(lineNum);
        y += wrapped * hLineHeight + marginBottom;
      } else {
        y += headingH;
      }
      i++;
      continue;
    }

    // Horizontal rule
    if (/^(?:---|\*\*\*|___)\s*$/.test(trimmed)) {
      const hrH = 24;
      if (y > 0 && y + hrH > pageHeight) {
        startNewPageAt(lineNum);
      }
      y += hrH;
      i++;
      continue;
    }

    // Standalone image (`![alt](url)` or `<img ...>`)
    if (
      (/^!\[[^\]]*\]\([^)]+\)\s*$/.test(trimmed) || /^<img\b[^>]*>\s*$/i.test(trimmed))
    ) {
      const imgH = estimateImageHeightPx(trimmed, pageHeight);
      if (y > 0 && y + imgH > pageHeight) {
        startNewPageAt(lineNum);
      }
      y += imgH + paragraphGap;
      i++;
      continue;
    }

    // Markdown table (`| ... |` followed by separator row)
    if (
      trimmed.startsWith('|') &&
      i + 1 < rawLines.length &&
      /^\s*\|?(?:\s*:?-{2,}:?\s*\|)+\s*:?-{2,}:?\s*\|?\s*$/.test(rawLines[i + 1])
    ) {
      const rowHeightFor = (rowText: string) => {
        const cells = rowText
          .replace(/^\s*\|/, '')
          .replace(/\|\s*$/, '')
          .split('|');
        const colCount = Math.max(1, cells.length);
        const colEmCap = Math.max(4, (lineEmCapacity - colCount * 2) / colCount);
        let maxLines = 1;
        for (const c of cells) {
          maxLines = Math.max(maxLines, Math.ceil(visualEmWidth(c.trim()) / colEmCap));
        }
        return maxLines * (fontSizePx * 1.45) + 14;
      };

      const headerH = rowHeightFor(rawLines[i]);
      let rowIdx = i + 2;
      const firstBodyH =
        rowIdx < rawLines.length && rawLines[rowIdx].trim().startsWith('|')
          ? rowHeightFor(rawLines[rowIdx])
          : 0;

      if (y > 0 && y + headerH + firstBodyH > pageHeight) {
        startNewPageAt(lineNum);
      }
      y += headerH;

      while (rowIdx < rawLines.length && rawLines[rowIdx].trim().startsWith('|')) {
        const rH = rowHeightFor(rawLines[rowIdx]);
        if (y > 0 && y + rH > pageHeight) {
          startNewPageAt(rowIdx + 1);
          // Print repeats the table header row at the top of the new page (#337)
          y += headerH;
        }
        y += rH;
        rowIdx++;
      }
      y += paragraphGap;
      i = rowIdx;
      continue;
    }

    // Paragraph, list item, or blockquote line
    const isListOrQuote =
      /^(?:>\s*|[-+*]\s+|\d+[.)]\s+)/.test(trimmed);
    const effectiveCap = isListOrQuote ? Math.max(10, lineEmCapacity - 2.5) : lineEmCapacity;
    const wrappedLines = Math.max(1, Math.ceil(visualEmWidth(trimmed) / effectiveCap));
    const lineBlockH = wrappedLines * bodyLineHeight;

    // Check if the next line is blank (end of paragraph) to add paragraph bottom margin
    const nextIsBlank = i + 1 >= rawLines.length || !rawLines[i + 1].trim();
    const extraGap = nextIsBlank ? paragraphGap : isListOrQuote ? fontSizePx * 0.25 : 0;

    if (y > 0 && y + lineBlockH > pageHeight) {
      startNewPageAt(lineNum);
    }
    y += lineBlockH + extraGap;
    i++;
  }

  const pageForLine = (line: number): number => {
    const target = Math.max(1, line);
    let p = 1;
    for (const br of breaks) {
      if (target >= br.line) p = br.page;
      else break;
    }
    return p;
  };

  return {
    totalPages: Math.max(1, currentPage),
    pageSizeLabel: opts.pageSizeLabel || 'A4',
    breaks,
    pageForLine,
  };
}

class PdfPageBreakWidget extends WidgetType {
  readonly page: number;
  readonly label: string;

  constructor(page: number, label: string) {
    super();
    this.page = page;
    this.label = label;
  }

  override eq(other: PdfPageBreakWidget): boolean {
    return this.page === other.page && this.label === other.label;
  }

  override toDOM(): HTMLElement {
    const wrap = document.createElement('div');
    wrap.className = 'cm-pdf-page-break';
    wrap.setAttribute('aria-hidden', 'true');
    const badge = document.createElement('span');
    badge.className = 'cm-pdf-page-break__badge';
    badge.textContent = this.label;
    wrap.appendChild(badge);
    return wrap;
  }

  override ignoreEvent(): boolean {
    return true;
  }
}

export interface PdfPageBreaksExtensionOptions {
  isEnabled: () => boolean;
  getPdfDefaults: () => PdfDefaults;
  formatLabel: (page: number, totalPages: number, pageSizeLabel: string) => string;
}

/**
 * CodeMirror 6 extension that renders non-intrusive dashed PDF page-break
 * lines above each line where a new PDF page begins.
 */
export function pdfPageBreaksExtension(options: PdfPageBreaksExtensionOptions): Extension {
  const buildDecos = (state: EditorState): DecorationSet => {
    if (!options.isEnabled()) return Decoration.none;
    const text = state.doc.toString();
    if (!text.trim()) return Decoration.none;
    const res = computePdfPageBreaks(text, options.getPdfDefaults());
    if (res.breaks.length === 0) return Decoration.none;

    const builder = new RangeSetBuilder<Decoration>();
    for (const br of res.breaks) {
      if (br.line < 1 || br.line > state.doc.lines) continue;
      const pos = state.doc.line(br.line).from;
      const label = options.formatLabel(br.page, res.totalPages, res.pageSizeLabel);
      builder.add(
        pos,
        pos,
        Decoration.widget({
          widget: new PdfPageBreakWidget(br.page, label),
          block: true,
          side: -1,
        }),
      );
    }
    return builder.finish();
  };

  const field = StateField.define<DecorationSet>({
    create(state) {
      return buildDecos(state);
    },
    update(decos, tr) {
      if (tr.docChanged || tr.reconfigured) {
        return buildDecos(tr.state);
      }
      return decos;
    },
    provide: (f) => EditorView.decorations.from(f),
  });

  return field;
}
