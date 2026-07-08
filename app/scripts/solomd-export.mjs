#!/usr/bin/env node
/**
 * solomd-export — Headless export tool for SoloMD markdown files.
 *
 * Used by `solomd export <file>` (the bash CLI wrapper) and by the MCP
 * server's `export_note` tool. This is the path that finally closes the
 * v4.0.2-surfaced gap where docx export was untestable from CI / headless.
 *
 * Lives inside app/ so it has direct access to app/node_modules — no
 * extra build step, just `cd app && node scripts/solomd-export.mjs ...`.
 *
 * Usage:
 *   node scripts/solomd-export.mjs <input.md> [--format html|md|txt|docx] [--output <path>]
 *
 * Default format is `html`. Default output is the input filename with the
 * format-appropriate extension, written next to the input.
 *
 * Engine parity with the in-app GUI export: same markdown-it config, same
 * `docx` library, same blockquote / table / list handling. Local images are
 * embedded the same way too — only the I/O backend differs (Node `fs` here,
 * Tauri `invoke('read_binary_file')` in the GUI). Remote `https://…` images
 * become a `[image: alt] (url)` placeholder in both paths.
 */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import MarkdownIt from 'markdown-it';
// @ts-ignore — no types
import katex from '@vscode/markdown-it-katex';
// @ts-ignore — no types
import footnote from 'markdown-it-footnote';
// @ts-ignore — no types
import mark from 'markdown-it-mark';
import {
  Document,
  Packer,
  Paragraph,
  TextRun,
  ImageRun,
  HeadingLevel,
  AlignmentType,
  ShadingType,
  BorderStyle,
  Table,
  TableRow,
  TableCell,
  WidthType,
  ExternalHyperlink,
} from 'docx';

// ---------------------------------------------------------------------------
// Argument parsing — small + dep-free (no commander)
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = { input: null, format: 'html', output: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--format' || a === '-f') {
      args.format = argv[++i];
    } else if (a === '--output' || a === '-o') {
      args.output = argv[++i];
    } else if (a === '--help' || a === '-h') {
      args.help = true;
    } else if (!args.input && !a.startsWith('-')) {
      args.input = a;
    }
  }
  return args;
}

function printHelp() {
  console.error(`solomd-export — convert .md to html / md / txt / docx

Usage:
  solomd-export <input.md> [--format html|md|txt|docx] [--output <path>]

Options:
  -f, --format <fmt>   Output format (default: html)
  -o, --output <path>  Output file (default: <input>.<fmt> next to input)
  -h, --help           Show this help

Notes:
  - Reads the same markdown-it config as the SoloMD app
    (html: true, linkify, typographer, mark, footnote, katex).
  - DOCX export uses the same 'docx' npm library as the app.
  - Image embedding is not yet ported (v4.1 limitation; see source).
`);
}

// ---------------------------------------------------------------------------
// Markdown rendering — must match app/src/lib/markdown.ts config
// ---------------------------------------------------------------------------

const md = new MarkdownIt({
  html: true,
  linkify: true,
  typographer: true,
  breaks: false,
}).use(katex.default ?? katex, { throwOnError: false }).use(footnote).use(mark);

function renderHtml(source) {
  return md.render(source ?? '');
}

// ---------------------------------------------------------------------------
// Plain-text strip — match the app's stripMarkdown (useExport.ts)
// ---------------------------------------------------------------------------

function stripMarkdown(src) {
  return (src ?? '')
    .replace(/```[a-zA-Z0-9]*\n([\s\S]*?)```/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/(\*\*|__)(.+?)\1/g, '$2')
    .replace(/(\*|_)(.+?)\1/g, '$2')
    .replace(/~~(.+?)~~/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^>\s?/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/^\s*\d+\.\s+/gm, '')
    .replace(/^[-*_]{3,}\s*$/gm, '')
    .trim();
}

// ---------------------------------------------------------------------------
// Image resolution + embedding — Node fs replaces Tauri invoke. Logic
// mirrors app/src/lib/docx-export.ts + image-resolve.ts.
// ---------------------------------------------------------------------------

function imageTypeFromPath(p) {
  const ext = p.split('.').pop()?.toLowerCase() ?? '';
  if (ext === 'jpg' || ext === 'jpeg') return 'jpg';
  if (ext === 'gif') return 'gif';
  if (ext === 'bmp') return 'bmp';
  return 'png';
}

function readImageDimensions(data) {
  if (data[0] === 0x89 && data[1] === 0x50) {
    const w = (data[16] << 24) | (data[17] << 16) | (data[18] << 8) | data[19];
    const h = (data[20] << 24) | (data[21] << 16) | (data[22] << 8) | data[23];
    if (w > 0 && h > 0) return { width: w, height: h };
  }
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
  if (data[0] === 0x47 && data[1] === 0x49 && data[2] === 0x46) {
    const w = data[6] | (data[7] << 8);
    const h = data[8] | (data[9] << 8);
    if (w > 0 && h > 0) return { width: w, height: h };
  }
  if (data[0] === 0x42 && data[1] === 0x4D) {
    const w = data[18] | (data[19] << 8) | (data[20] << 16) | (data[21] << 24);
    const h = Math.abs(data[22] | (data[23] << 8) | (data[24] << 16) | (data[25] << 24));
    if (w > 0 && h > 0) return { width: w, height: h };
  }
  return null;
}

const MAX_IMG_WIDTH = 580;
function scaleDimensions(w, h) {
  if (w > MAX_IMG_WIDTH) {
    const ratio = MAX_IMG_WIDTH / w;
    return { width: MAX_IMG_WIDTH, height: Math.round(h * ratio) };
  }
  return { width: w, height: h };
}

const imageCache = new Map();
function fetchImageBytes(absPath) {
  const cached = imageCache.get(absPath);
  if (cached) return cached;
  try {
    const data = new Uint8Array(fs.readFileSync(absPath));
    const dim = readImageDimensions(data) ?? { width: 400, height: 300 };
    const result = { data, ...dim, type: imageTypeFromPath(absPath) };
    imageCache.set(absPath, result);
    return result;
  } catch {
    return null;
  }
}

function normalizePath(p) {
  if (!p) return p;
  let s = p.replace(/\\/g, '/');
  const drive = s.match(/^([a-zA-Z]):\/(.*)$/);
  let prefix = '', body = s;
  if (drive) { prefix = drive[1].toUpperCase() + ':/'; body = drive[2]; }
  else if (s.startsWith('/')) { prefix = '/'; body = s.slice(1); }
  const out = [];
  for (const seg of body.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') { if (out.length > 0) out.pop(); continue; }
    out.push(seg);
  }
  return prefix + out.join('/');
}

function resolveLocalImagePath(src, imageRoot, filePath) {
  if (!src || /^(https?|data|blob|asset|tauri):/i.test(src)) return null;
  let p = src;
  if (/^file:\/\//i.test(p)) {
    p = p.slice(7);
    if (p.startsWith('/') && /^\/[a-zA-Z]:/.test(p)) p = p.slice(1);
  }
  const isAbsolute = p.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(p);
  if (!isAbsolute) {
    let base = null;
    if (imageRoot) {
      const rootAbs = imageRoot.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(imageRoot);
      if (rootAbs) base = imageRoot;
      else if (filePath) {
        const dir = filePath.replace(/[\\/][^\\/]*$/, '');
        base = dir + '/' + imageRoot;
      }
    }
    if (!base && filePath) base = filePath.replace(/[\\/][^\\/]*$/, '');
    if (base) p = base + '/' + p;
  }
  return normalizePath(p);
}

function extractImageRoot(source) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(source ?? '');
  if (!m) return null;
  const im = /^(?:imageRoot|image_root|typora-root-url)\s*:\s*(.+?)\s*$/m.exec(m[1]);
  if (!im) return null;
  return im[1].replace(/^["']|["']$/g, '').trim() || null;
}

// ---------------------------------------------------------------------------
// DOCX — port of app/src/lib/docx-export.ts to plain ESM JS for headless
// use. Engine-parity (same markdown-it config, same `docx` lib, same
// blockquote / table / list / image embedding logic).
// ---------------------------------------------------------------------------

const HEADING_LEVELS = {
  h1: HeadingLevel.HEADING_1, h2: HeadingLevel.HEADING_2, h3: HeadingLevel.HEADING_3,
  h4: HeadingLevel.HEADING_4, h5: HeadingLevel.HEADING_5, h6: HeadingLevel.HEADING_6,
};
const HEADING_SPACING = {
  h1: { before: 360, after: 180 }, h2: { before: 320, after: 160 },
  h3: { before: 280, after: 140 }, h4: { before: 240, after: 120 },
  h5: { before: 200, after: 100 }, h6: { before: 200, after: 100 },
};

function toRunOpts(s) {
  const o = {};
  if (s.bold) o.bold = true;
  if (s.italic) o.italics = true;
  if (s.strike) o.strike = true;
  if (s.code) {
    o.font = 'JetBrains Mono';
    o.color = '8A4A00';
    o.shading = { type: ShadingType.SOLID, color: 'F3EFE7', fill: 'F3EFE7' };
  }
  return o;
}

function buildRuns(inlineToken, baseStyle = {}) {
  const out = [];
  if (!inlineToken.children) {
    if (inlineToken.content) out.push(new TextRun({ text: inlineToken.content, ...toRunOpts(baseStyle) }));
    return out;
  }
  const stack = [{ ...baseStyle }];
  let pendingLink = null;
  const cur = () => stack[stack.length - 1];
  const push = (run) => { (pendingLink ? pendingLink.runs : out).push(run); };
  for (const tok of inlineToken.children) {
    switch (tok.type) {
      case 'text':
        if (tok.content) push(new TextRun({ text: tok.content, ...toRunOpts(cur()) }));
        break;
      case 'softbreak':
      case 'hardbreak':
        push(new TextRun({ text: ' ', ...toRunOpts(cur()) }));
        break;
      case 'strong_open': stack.push({ ...cur(), bold: true }); break;
      case 'strong_close': stack.pop(); break;
      case 'em_open': stack.push({ ...cur(), italic: true }); break;
      case 'em_close': stack.pop(); break;
      case 's_open': stack.push({ ...cur(), strike: true }); break;
      case 's_close': stack.pop(); break;
      case 'code_inline':
        push(new TextRun({ text: tok.content, ...toRunOpts({ ...cur(), code: true }) }));
        break;
      case 'link_open': {
        const href = tok.attrGet ? tok.attrGet('href') : (tok.attrs?.find(a => a[0] === 'href')?.[1] ?? '');
        pendingLink = { href, runs: [] };
        break;
      }
      case 'link_close':
        if (pendingLink) {
          out.push(new ExternalHyperlink({ link: pendingLink.href, children: pendingLink.runs }));
          pendingLink = null;
        }
        break;
      case 'image': {
        // Inline images get a textual placeholder — block-level (image-only
        // paragraph) handling embeds the actual image; see buildBody.
        const alt = tok.content || (tok.attrGet ? tok.attrGet('alt') : '') || '';
        const src = tok.attrGet ? tok.attrGet('src') : '';
        push(new TextRun({
          text: src ? `[image: ${alt}] (${src})` : `[image: ${alt}]`,
          italics: true,
          color: '888888',
        }));
        break;
      }
      default:
        if (tok.content) push(new TextRun({ text: tok.content, ...toRunOpts(cur()) }));
    }
  }
  return out;
}

function findMatchingClose(tokens, start, openType, closeType) {
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

function isImageOnlyParagraph(inline) {
  if (!inline.children) return false;
  const non = inline.children.filter(c =>
    !(c.type === 'text' && !c.content?.trim()) && c.type !== 'softbreak'
  );
  if (non.length === 1 && non[0].type === 'image') return true;
  if (non.length === 3 && non[0].type === 'link_open' && non[1].type === 'image' && non[2].type === 'link_close') return true;
  return false;
}

function buildBody(tokens, imageRoot, filePath) {
  const out = [];
  const listStack = [];
  let i = 0;
  while (i < tokens.length) {
    const t = tokens[i];
    switch (t.type) {
      case 'heading_open': {
        const level = t.tag;
        const inline = tokens[i + 1];
        i += 3;
        out.push(new Paragraph({
          heading: HEADING_LEVELS[level],
          children: buildRuns(inline),
          spacing: HEADING_SPACING[level] ?? { before: 240, after: 120 },
          keepNext: true,
        }));
        break;
      }
      case 'paragraph_open': {
        const inline = tokens[i + 1];
        i += 3;
        const inList = listStack.length > 0;

        // Image-only paragraph → embed the image directly (mirrors GUI export).
        if (inline && isImageOnlyParagraph(inline)) {
          const imgTok = inline.children.find(c => c.type === 'image');
          const src = imgTok.attrGet('src') || '';
          const alt = imgTok.content || imgTok.attrGet('alt') || '';
          const absPath = resolveLocalImagePath(src, imageRoot, filePath);
          if (absPath) {
            const img = fetchImageBytes(absPath);
            if (img) {
              const dim = scaleDimensions(img.width, img.height);
              out.push(new Paragraph({
                children: [new ImageRun({
                  type: img.type,
                  data: img.data,
                  transformation: { width: dim.width, height: dim.height },
                  altText: { name: alt, description: alt },
                })],
                alignment: AlignmentType.CENTER,
                spacing: { before: 160, after: 160 },
              }));
              break;
            }
          }
          // Remote / unreadable → placeholder
          out.push(new Paragraph({
            children: [new TextRun({
              text: src ? `[image: ${alt}] (${src})` : `[image: ${alt}]`,
              italics: true, color: '888888',
            })],
            alignment: AlignmentType.CENTER,
            spacing: { before: 160, after: 160 },
          }));
          break;
        }

        out.push(new Paragraph({
          children: buildRuns(inline),
          spacing: inList ? { before: 60, after: 60 } : { before: 120, after: 120 },
          ...(inList && {
            numbering: listStack[listStack.length - 1].type === 'ordered'
              ? { reference: 'ordered-list', level: Math.min(listStack.length - 1, 8) } : undefined,
            bullet: listStack[listStack.length - 1].type === 'bullet'
              ? { level: Math.min(listStack.length - 1, 8) } : undefined,
          }),
        }));
        break;
      }
      case 'fence':
      case 'code_block': {
        const lines = (t.content || '').replace(/\n$/, '').split('\n');
        const last = lines.length - 1;
        lines.forEach((line, idx) => {
          out.push(new Paragraph({
            children: [new TextRun({ text: line || ' ', font: 'JetBrains Mono', size: 20, color: '1F1D1A' })],
            shading: { type: ShadingType.SOLID, color: 'F3EFE7', fill: 'F3EFE7' },
            spacing: { before: idx === 0 ? 160 : 0, after: idx === last ? 160 : 0 },
            border: { left: { style: BorderStyle.SINGLE, size: 18, color: 'FF9F40', space: 6 } },
          }));
        });
        i += 1;
        break;
      }
      case 'hr':
        out.push(new Paragraph({ text: '', spacing: { before: 240, after: 240 },
          border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: 'CCCCCC' } } }));
        i += 1;
        break;
      case 'blockquote_open': {
        // Mirrors v4.0.2's docx-export.ts fix — walk inner tokens directly,
        // build runs from each paragraph_open's inline token. Do NOT round-trip
        // through buildBody → Paragraph and try to re-extract `.options.children`
        // (the docx library doesn't expose that publicly; old code produced
        // empty bordered paragraphs).
        const end = findMatchingClose(tokens, i, 'blockquote_open', 'blockquote_close');
        const inner = tokens.slice(i + 1, end);
        let j = 0;
        while (j < inner.length) {
          const ti = inner[j];
          if (ti.type === 'paragraph_open') {
            const inlineTok = inner[j + 1];
            const runs = inlineTok && inlineTok.type === 'inline' ? buildRuns(inlineTok) : [];
            out.push(new Paragraph({
              children: runs.length > 0 ? runs : [new TextRun({ text: ' ' })],
              alignment: AlignmentType.LEFT,
              indent: { left: 360 },
              spacing: { before: 80, after: 80 },
              border: { left: { style: BorderStyle.SINGLE, size: 18, color: 'FF9F40', space: 8 } },
            }));
            j += 3;
          } else {
            // Non-paragraph (nested list/code/heading) — recurse
            const sliceEnd = ti.type.endsWith('_open')
              ? findMatchingClose(inner, j, ti.type, ti.type.replace(/_open$/, '_close')) + 1
              : j + 1;
            const nested = buildBody(inner.slice(j, sliceEnd), imageRoot, filePath);
            for (const b of nested) out.push(b);
            j = sliceEnd;
          }
        }
        i = end + 1;
        break;
      }
      case 'table_open': {
        const end = findMatchingClose(tokens, i, 'table_open', 'table_close');
        const tbl = buildTable(tokens.slice(i + 1, end));
        if (tbl) out.push(tbl);
        out.push(new Paragraph({ text: '', spacing: { before: 0, after: 120 } }));
        i = end + 1;
        break;
      }
      case 'bullet_list_open': listStack.push({ type: 'bullet', index: 0 }); i += 1; break;
      case 'ordered_list_open': listStack.push({ type: 'ordered', index: 0 }); i += 1; break;
      case 'bullet_list_close':
      case 'ordered_list_close': listStack.pop(); i += 1; break;
      case 'list_item_open':
      case 'list_item_close': i += 1; break;
      default: i += 1;
    }
  }
  return out;
}

function buildTable(inner) {
  const rows = [];
  let cur = null;
  let inHeader = false;
  for (let k = 0; k < inner.length; k++) {
    const t = inner[k];
    switch (t.type) {
      case 'thead_open': inHeader = true; break;
      case 'thead_close': inHeader = false; break;
      case 'tr_open': cur = { cells: [], isHeader: inHeader }; break;
      case 'tr_close': if (cur) rows.push(cur); cur = null; break;
      case 'th_open':
      case 'td_open': {
        const inlineTok = inner[k + 1];
        const runs = inlineTok ? buildRuns(inlineTok) : [];
        if (cur) cur.cells.push(runs);
        break;
      }
    }
  }
  if (rows.length === 0) return null;
  const cols = Math.max(...rows.map(r => r.cells.length));
  return new Table({
    rows: rows.map(row => new TableRow({
      tableHeader: row.isHeader,
      children: Array.from({ length: cols }, (_, c) => {
        const runs = row.cells[c] ?? [];
        return new TableCell({
          children: runs.length > 0
            ? [new Paragraph({ children: runs, spacing: { before: 40, after: 40 } })]
            : [new Paragraph({ text: '' })],
          shading: row.isHeader ? { type: ShadingType.SOLID, color: 'FFE7CC', fill: 'FFE7CC' } : undefined,
          margins: { top: 80, bottom: 80, left: 120, right: 120 },
        });
      }),
    })),
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

async function markdownToDocxBuffer(source, title = 'Document', filePath) {
  imageCache.clear();
  const tokens = md.parse(source ?? '', {});
  const imageRoot = extractImageRoot(source);
  const blocks = buildBody(tokens, imageRoot, filePath);
  if (blocks.length === 0) blocks.push(new Paragraph({ text: '' }));
  const doc = new Document({
    creator: 'SoloMD',
    title,
    description: 'Exported from SoloMD CLI',
    numbering: {
      config: [{
        reference: 'ordered-list',
        levels: [
          { level: 0, format: 'decimal', text: '%1.', alignment: AlignmentType.START },
          { level: 1, format: 'lowerLetter', text: '%2.', alignment: AlignmentType.START },
          { level: 2, format: 'lowerRoman', text: '%3.', alignment: AlignmentType.START },
        ],
      }],
    },
    sections: [{ properties: {}, children: blocks }],
  });
  return Packer.toBuffer(doc);
}

// ---------------------------------------------------------------------------
// HTML wrapper — matches app/src/composables/useExport.ts HTML_TEMPLATE
// (slimmed: drops katex/asset CSS for the CLI use case)
// ---------------------------------------------------------------------------

function htmlDoc(title, body) {
  const esc = (s) => s.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${esc(title)}</title>
<style>
  body { max-width: 760px; margin: 56px auto; padding: 0 56px 96px; font: 16px/1.75 system-ui, sans-serif; color: #1f1d1a; }
  h1 { font-size: 2.15em; border-bottom: 2px solid #ff9f40; padding-bottom: .35em; }
  h2 { font-size: 1.55em; border-bottom: 1px solid #e6e2d8; padding-bottom: .25em; }
  blockquote { border-left: 4px solid #ff9f40; margin: 1.4em 0; padding: .5em 1.2em; color: #6a6560; font-style: italic; background: linear-gradient(to right, #ffe7cc 0%, transparent 40%); border-radius: 0 4px 4px 0; }
  code { font-family: monospace; background: #f3efe7; padding: .15em .45em; border-radius: 4px; color: #8a4a00; }
  pre { background: #f3efe7; padding: 16px 20px; border-radius: 8px; overflow-x: auto; }
  table { border-collapse: collapse; margin: 1.4em 0; width: 100%; }
  th, td { border: 1px solid #e6e2d8; padding: 8px 14px; text-align: left; }
  thead th { background: #ffe7cc; font-weight: 700; border-bottom: 2px solid #ff9f40; }
</style>
</head>
<body>
${body}
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.input) {
    printHelp();
    process.exit(args.help ? 0 : 1);
  }

  const inputPath = path.resolve(args.input);
  if (!fs.existsSync(inputPath)) {
    console.error(`solomd-export: input not found: ${inputPath}`);
    process.exit(2);
  }

  const source = fs.readFileSync(inputPath, 'utf8');
  const baseName = path.basename(inputPath).replace(/\.[^.]+$/, '');
  const dir = path.dirname(inputPath);
  const fmt = args.format.toLowerCase();
  const validFormats = ['html', 'md', 'txt', 'docx'];
  if (!validFormats.includes(fmt)) {
    console.error(`solomd-export: unknown format: ${fmt} (try ${validFormats.join('|')})`);
    process.exit(2);
  }

  const outPath = args.output ?? path.join(dir, `${baseName}.${fmt}`);

  switch (fmt) {
    case 'html': {
      const body = renderHtml(source);
      fs.writeFileSync(outPath, htmlDoc(baseName, body), 'utf8');
      break;
    }
    case 'md': {
      fs.writeFileSync(outPath, source, 'utf8');
      break;
    }
    case 'txt': {
      fs.writeFileSync(outPath, stripMarkdown(source), 'utf8');
      break;
    }
    case 'docx': {
      const buf = await markdownToDocxBuffer(source, baseName);
      fs.writeFileSync(outPath, buf);
      break;
    }
  }
  console.log(outPath);
}

main().catch((e) => {
  console.error(`solomd-export: ${e?.stack ?? e}`);
  process.exit(1);
});
