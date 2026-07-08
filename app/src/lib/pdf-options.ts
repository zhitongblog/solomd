/**
 * v2.5 F3 — resolve effective PDF / print export options from
 * Settings → PDF defaults plus optional per-document YAML front matter.
 *
 * Per-document override is opt-in via a `pdf:` block, e.g.
 *
 * ```yaml
 * ---
 * pdf:
 *   pageSize: A4
 *   margin: 15mm
 *   font: 'PingFang SC'
 *   fontSize: 11
 *   footer: true
 * ---
 * ```
 *
 * When a `pdf:` block is present, individual keys win over Settings; keys
 * the user *didn't* set still come from Settings. When the user has not
 * touched Settings either, we return a "blank" preset that callers can
 * detect (`isBlankPreset`) and fall back to webview / jsPDF defaults —
 * preserving the pre-v2.5 behavior so we don't break anything for users
 * who never opened the new section.
 */
import type { PdfDefaults } from '../stores/settings';
import { defaultPdfDefaults } from '../stores/settings';

export interface ResolvedPdfOptions {
  /**
   * Effective page size in mm. `null` means "use the renderer's default" —
   * happens when the user has never touched Settings AND the doc has no
   * `pdf:` block. Callers should fall back to the engine's native default.
   */
  pageSizeMm: { width: number; height: number } | null;
  /** Human-readable preset label (`A4`, `Letter`, `Custom`, …) for telemetry / footer text. */
  pageSizeLabel: string;
  /** Effective margins in mm (top / right / bottom / left). */
  marginMm: { top: number; right: number; bottom: number; left: number } | null;
  /** Effective body font family. Empty string = let the stylesheet decide. */
  fontFamily: string;
  /** Effective body font size in pt. */
  fontSizePt: number;
  /** Whether to render the page-number footer. */
  footer: boolean;
  /** Code-block syntax theme override. */
  codeTheme: 'preview' | 'light' | 'dark';
}

const PAGE_SIZES_MM: Record<string, { width: number; height: number }> = {
  A4: { width: 210, height: 297 },
  A5: { width: 148, height: 210 },
  Letter: { width: 215.9, height: 279.4 },
  Legal: { width: 215.9, height: 355.6 },
};

const MARGIN_PRESETS_MM: Record<string, number> = {
  Narrow: 10,
  Normal: 15,
  Wide: 25,
};

/** Clamp a numeric mm value into [min, max]. NaN becomes `fallback`. */
function clampMm(n: unknown, min: number, max: number, fallback: number): number {
  const v = typeof n === 'number' && Number.isFinite(n) ? n : fallback;
  return Math.max(min, Math.min(max, v));
}

/**
 * Read the YAML `pdf:` block from a markdown body. Lightweight regex parse
 * (no YAML dep) — only handles the exact shape documented above. Unknown
 * keys are silently ignored.
 */
export function parsePdfFrontMatter(body: string): Partial<{
  pageSize: string;
  pageWidthMm: number;
  pageHeightMm: number;
  margin: string;
  marginTopMm: number;
  marginRightMm: number;
  marginBottomMm: number;
  marginLeftMm: number;
  fontFamily: string;
  fontSizePt: number;
  footer: boolean;
}> {
  const fmMatch = body.replace(/^﻿/, '').match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!fmMatch) return {};
  const yaml = fmMatch[1];
  // Find the `pdf:` block — either a single-line flow-style or a nested
  // mapping. We grab from `pdf:` to the next top-level key (column 0
  // non-whitespace ending in `:`) or end-of-yaml.
  const pdfHeader = yaml.match(/^pdf\s*:(.*)$/m);
  if (!pdfHeader) return {};

  const idx = yaml.indexOf(pdfHeader[0]);
  const after = yaml.slice(idx + pdfHeader[0].length);
  // Lines up until the next top-level key (no leading whitespace) or EOF.
  const blockLines: string[] = [];
  for (const line of after.split('\n')) {
    if (line === '') {
      blockLines.push(line);
      continue;
    }
    if (/^\S/.test(line)) {
      // Top-level key — break.
      break;
    }
    blockLines.push(line);
  }
  // Inline form (e.g. `pdf: { pageSize: A4 }`).
  const inline = pdfHeader[1].trim();
  const inlineMatch = inline.match(/^\{([\s\S]*)\}$/);
  if (inlineMatch) {
    return parsePdfBody(splitInline(inlineMatch[1]));
  }

  return parsePdfBody(blockLines.map((l) => l.replace(/^\s{2}|^\t/, '')));
}

function splitInline(body: string): string[] {
  // `pageSize: A4, margin: 15mm` → ["pageSize: A4", "margin: 15mm"]
  return body.split(',').map((s) => s.trim()).filter(Boolean);
}

function parsePdfBody(lines: string[]): Partial<{
  pageSize: string;
  pageWidthMm: number;
  pageHeightMm: number;
  margin: string;
  marginTopMm: number;
  marginRightMm: number;
  marginBottomMm: number;
  marginLeftMm: number;
  fontFamily: string;
  fontSizePt: number;
  footer: boolean;
}> {
  const out: Record<string, unknown> = {};
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = line.match(/^([A-Za-z][A-Za-z0-9_]*)\s*:\s*(.*)$/);
    if (!m) continue;
    const key = m[1];
    const val = stripYaml(m[2]);
    switch (key) {
      case 'pageSize':
      case 'page_size':
        out.pageSize = val;
        break;
      case 'pageWidth':
      case 'page_width':
        out.pageWidthMm = parseMmNumber(val);
        break;
      case 'pageHeight':
      case 'page_height':
        out.pageHeightMm = parseMmNumber(val);
        break;
      case 'margin':
        out.margin = val;
        break;
      case 'marginTop':
      case 'margin_top':
        out.marginTopMm = parseMmNumber(val);
        break;
      case 'marginRight':
      case 'margin_right':
        out.marginRightMm = parseMmNumber(val);
        break;
      case 'marginBottom':
      case 'margin_bottom':
        out.marginBottomMm = parseMmNumber(val);
        break;
      case 'marginLeft':
      case 'margin_left':
        out.marginLeftMm = parseMmNumber(val);
        break;
      case 'font':
      case 'fontFamily':
      case 'font_family':
        out.fontFamily = val;
        break;
      case 'fontSize':
      case 'font_size':
        out.fontSizePt = parseFloat(val);
        break;
      case 'footer':
        if (/^(true|yes|on|1)$/i.test(val)) out.footer = true;
        else if (/^(false|no|off|0)$/i.test(val)) out.footer = false;
        break;
      default:
        break;
    }
  }
  return out as Partial<{
    pageSize: string;
    pageWidthMm: number;
    pageHeightMm: number;
    margin: string;
    marginTopMm: number;
    marginRightMm: number;
    marginBottomMm: number;
    marginLeftMm: number;
    fontFamily: string;
    fontSizePt: number;
    footer: boolean;
  }>;
}

function stripYaml(s: string): string {
  const t = s.trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    return t.slice(1, -1);
  }
  return t;
}

/** Parse `15mm` / `15` / `1.5cm` / `0.59in` into mm. */
function parseMmNumber(s: string): number {
  const m = s.match(/^([\d.]+)\s*(mm|cm|in)?$/i);
  if (!m) return NaN;
  const n = parseFloat(m[1]);
  const unit = (m[2] || 'mm').toLowerCase();
  if (unit === 'cm') return n * 10;
  if (unit === 'in') return n * 25.4;
  return n;
}

/**
 * Resolve effective PDF options from settings + frontmatter.
 *
 * `userTouchedDefaults` lets the caller distinguish "user explicitly opted
 * into v2.5 PDF defaults" (in which case we return concrete numbers) from
 * "user has never touched Settings" (return `null` so the renderer falls
 * back to its native defaults — pre-v2.5 behavior).
 */
export function resolvePdfOptions(
  settingsDefaults: PdfDefaults,
  source: string,
  userTouchedDefaults = true,
): ResolvedPdfOptions {
  const fm = parsePdfFrontMatter(source);
  const fmHasAny = Object.keys(fm).length > 0;
  const apply = userTouchedDefaults || fmHasAny;

  if (!apply) {
    // Pre-v2.5 path: user never touched the section AND the doc has no
    // pdf: block — return null sentinels so callers know to use engine
    // defaults verbatim.
    return {
      pageSizeMm: null,
      pageSizeLabel: 'Default',
      marginMm: null,
      fontFamily: '',
      fontSizePt: 11,
      footer: false,
      codeTheme: 'preview',
    };
  }

  // ---- Page size --------------------------------------------------------
  let pageSizeMm: { width: number; height: number };
  let pageSizeLabel: string;
  if (fm.pageSize) {
    const fmPreset = PAGE_SIZES_MM[fm.pageSize];
    if (fmPreset) {
      pageSizeMm = fmPreset;
      pageSizeLabel = fm.pageSize;
    } else if (fm.pageSize.toLowerCase() === 'custom') {
      pageSizeMm = {
        width: clampMm(fm.pageWidthMm, 50, 500, settingsDefaults.customWidthMm),
        height: clampMm(fm.pageHeightMm, 50, 500, settingsDefaults.customHeightMm),
      };
      pageSizeLabel = 'Custom';
    } else {
      // Unknown preset: fall back to settings.
      pageSizeMm = pageSizeFromSettings(settingsDefaults);
      pageSizeLabel = settingsDefaults.pageSize;
    }
  } else {
    pageSizeMm = pageSizeFromSettings(settingsDefaults);
    pageSizeLabel = settingsDefaults.pageSize;
  }

  // ---- Margins ----------------------------------------------------------
  let marginMm: { top: number; right: number; bottom: number; left: number };
  if (fm.margin || fm.marginTopMm !== undefined) {
    if (typeof fm.margin === 'string') {
      const preset = MARGIN_PRESETS_MM[fm.margin];
      if (preset !== undefined) {
        marginMm = { top: preset, right: preset, bottom: preset, left: preset };
      } else {
        const asMm = parseMmNumber(fm.margin);
        if (Number.isFinite(asMm)) {
          const v = clampMm(asMm, 5, 100, 15);
          marginMm = { top: v, right: v, bottom: v, left: v };
        } else {
          marginMm = marginFromSettings(settingsDefaults);
        }
      }
    } else {
      marginMm = marginFromSettings(settingsDefaults);
    }
    if (
      fm.marginTopMm !== undefined ||
      fm.marginRightMm !== undefined ||
      fm.marginBottomMm !== undefined ||
      fm.marginLeftMm !== undefined
    ) {
      marginMm = {
        top: clampMm(fm.marginTopMm, 5, 100, marginMm.top),
        right: clampMm(fm.marginRightMm, 5, 100, marginMm.right),
        bottom: clampMm(fm.marginBottomMm, 5, 100, marginMm.bottom),
        left: clampMm(fm.marginLeftMm, 5, 100, marginMm.left),
      };
    }
  } else {
    marginMm = marginFromSettings(settingsDefaults);
  }

  const fontFamily =
    typeof fm.fontFamily === 'string' && fm.fontFamily.trim()
      ? fm.fontFamily.trim()
      : settingsDefaults.fontFamily;
  const fontSizePt =
    typeof fm.fontSizePt === 'number' && Number.isFinite(fm.fontSizePt)
      ? Math.max(6, Math.min(36, fm.fontSizePt))
      : settingsDefaults.fontSize;
  const footer = typeof fm.footer === 'boolean' ? fm.footer : settingsDefaults.footer;

  return {
    pageSizeMm,
    pageSizeLabel,
    marginMm,
    fontFamily,
    fontSizePt,
    footer,
    codeTheme: settingsDefaults.codeTheme,
  };
}

function pageSizeFromSettings(s: PdfDefaults): { width: number; height: number } {
  if (s.pageSize === 'Custom') {
    return {
      width: clampMm(s.customWidthMm, 50, 500, 210),
      height: clampMm(s.customHeightMm, 50, 500, 297),
    };
  }
  return PAGE_SIZES_MM[s.pageSize] ?? PAGE_SIZES_MM.A4;
}

function marginFromSettings(s: PdfDefaults): {
  top: number;
  right: number;
  bottom: number;
  left: number;
} {
  if (s.margin === 'Custom') {
    return {
      top: clampMm(s.customMarginTopMm, 5, 100, 15),
      right: clampMm(s.customMarginRightMm, 5, 100, 15),
      bottom: clampMm(s.customMarginBottomMm, 5, 100, 15),
      left: clampMm(s.customMarginLeftMm, 5, 100, 15),
    };
  }
  const v = MARGIN_PRESETS_MM[s.margin] ?? 15;
  return { top: v, right: v, bottom: v, left: v };
}

/**
 * Has the user explicitly opted into v2.5 PDF defaults? Compares against
 * the *factory* `defaultPdfDefaults()` — if every field matches we treat
 * Settings as untouched and let the renderer use its native defaults.
 */
export function userTouchedPdfDefaults(s: PdfDefaults): boolean {
  const d = defaultPdfDefaults();
  return (
    s.pageSize !== d.pageSize ||
    s.customWidthMm !== d.customWidthMm ||
    s.customHeightMm !== d.customHeightMm ||
    s.margin !== d.margin ||
    s.customMarginTopMm !== d.customMarginTopMm ||
    s.customMarginRightMm !== d.customMarginRightMm ||
    s.customMarginBottomMm !== d.customMarginBottomMm ||
    s.customMarginLeftMm !== d.customMarginLeftMm ||
    s.fontFamily !== d.fontFamily ||
    s.fontSize !== d.fontSize ||
    s.footer !== d.footer ||
    s.codeTheme !== d.codeTheme
  );
}

/**
 * Build a `<style>` string suitable for injection before
 * `window.print()` / `WebviewWindow::print()`. When `opts.pageSizeMm` is
 * `null` we emit nothing (preserve pre-v2.5 webview defaults).
 */
export function buildPrintStyle(opts: ResolvedPdfOptions): string {
  if (!opts.pageSizeMm || !opts.marginMm) return '';
  const { pageSizeMm, marginMm, fontFamily, fontSizePt, footer, codeTheme } = opts;
  const margin = `${marginMm.top}mm ${marginMm.right}mm ${marginMm.bottom}mm ${marginMm.left}mm`;
  const size = `${pageSizeMm.width}mm ${pageSizeMm.height}mm`;
  // Quote font family if it contains whitespace and isn't already quoted.
  const fontDecl = fontFamily.trim()
    ? `body, .preview-content, .solomd-print-content { font-family: ${quoteFontFamily(fontFamily)}, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif !important; }`
    : '';
  const fontSizeDecl = `body, .preview-content, .solomd-print-content { font-size: ${fontSizePt}pt !important; }`;
  const codeThemeDecl = codeTheme === 'light'
    ? `pre, code { background: #f3efe7 !important; color: #1f1d1a !important; }`
    : codeTheme === 'dark'
    ? `pre, code { background: #1f1d1a !important; color: #eee !important; }`
    : '';
  // Page-number footer via CSS counters. Browsers (Chrome / WebKit) honor
  // @page margin boxes; older WebViews may ignore them silently which is
  // acceptable degradation.
  const footerRule = footer
    ? `@page { @bottom-center { content: counter(page) " / " counter(pages); font-size: 9pt; color: #888; } }`
    : '';
  return `
@page { size: ${size}; margin: ${margin}; }
${footerRule}
@media print {
  ${fontDecl}
  ${fontSizeDecl}
  ${codeThemeDecl}
}
`.trim();
}

function quoteFontFamily(family: string): string {
  const trimmed = family.trim();
  // Already a stack with commas — pass through.
  if (trimmed.includes(',')) return trimmed;
  // Already quoted.
  if (/^["']/.test(trimmed)) return trimmed;
  // Quote if it contains whitespace.
  if (/\s/.test(trimmed)) return `"${trimmed}"`;
  return trimmed;
}
