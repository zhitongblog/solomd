/**
 * #562 — Build a single merged Markdown book from a folder of notes while
 * preserving the folder hierarchy in the document's Table of Contents (`[TOC]`)
 * and PDF/EPUB/HTML bookmarks:
 *
 *   1. Root folder name becomes the top-level book title (`# <folderName>`).
 *   2. Every subfolder segment in `relDir` (supporting arbitrary nesting depth)
 *      becomes a hierarchy node (`## <subfolder1>`, `### <subfolder2>`, …)
 *      emitted once when entering that subfolder, directly before the first
 *      note in that subfolder so folder TOC/bookmark nodes jump straight to
 *      that note's first effective heading.
 *   3. Inside each note (at folder depth `D`, where `noteBaseLevel = 2 + D`):
 *      - The note's 1st-level heading (`# ...`) maps to `noteBaseLevel`. If the
 *        note has no 1st-level heading, its filename without extension
 *        (`baseName`) is used as its `noteBaseLevel` heading.
 *      - The note's 2nd-level heading (`## ...`) maps to `noteBaseLevel + 1`.
 *      - The note's 3rd-level heading (`### ...`) maps to `noteBaseLevel + 2`.
 *      - Headings deeper than level 3 in a note (`####`..`######`) are rendered
 *        as bold subheadings in the body and excluded from TOC/bookmark
 *        extraction ("标题提取深度只提取到3级标题做文档目录").
 */

import { findMarkdownImagesInLine } from './md-image-url';
import { extractImageRoot } from './markdown';

export interface MergedNoteInput {
  path?: string;
  relDir: string;
  baseName: string;
  content: string;
  /** #574 — True when representing an empty leaf subfolder with no notes. */
  emptyDir?: boolean;
}

export function formatMergedHeading(level: number, text: string, isFolder = false): string {
  const safeLevel = Math.max(1, Math.floor(level));
  const cleanText = text.trim();
  const folderTag = isFolder ? ' <!-- solomd-toc-folder -->' : '';
  if (safeLevel <= 6) {
    return `${'#'.repeat(safeLevel)} ${cleanText}${folderTag}`;
  }
  return `###### ${cleanText}${folderTag} <!-- solomd-toc-level:${safeLevel} -->`;
}

function normalizeRelDir(relDir: string): string[] {
  return (relDir || '')
    .replace(/\\/g, '/')
    .split('/')
    .map((s) => s.trim())
    .filter(Boolean);
}

function isNonRelativeUrl(src: string): boolean {
  return (
    !src ||
    /^(?:https?:|data:|blob:|asset:|tauri:|file:|\/|[a-zA-Z]:[\\/])/i.test(src)
  );
}

function joinRelativeAssetPath(
  src: string,
  relDirSegments: string[],
  noteImageRoot?: string | null,
): string | null {
  const trimmed = src.trim();
  if (isNonRelativeUrl(trimmed)) return null;
  const rootTrimmed = (noteImageRoot || '').trim();
  if (rootTrimmed && (/^\//.test(rootTrimmed) || /^[a-zA-Z]:[\\/]/.test(rootTrimmed))) {
    const cleanRoot = rootTrimmed.replace(/\\/g, '/').replace(/\/+$/, '');
    const cleanRel = trimmed.replace(/\\/g, '/').replace(/^\.\//, '');
    return `${cleanRoot}/${cleanRel}`;
  }
  const baseSegments = [...relDirSegments];
  if (rootTrimmed) {
    for (const seg of rootTrimmed.replace(/\\/g, '/').split('/')) {
      const s = seg.trim();
      if (!s || s === '.') continue;
      if (s === '..') {
        if (baseSegments.length > 0) baseSegments.pop();
      } else {
        baseSegments.push(s);
      }
    }
  }
  if (baseSegments.length === 0) return null;
  const relParts = trimmed.replace(/\\/g, '/').split('/');
  const combined = [...baseSegments];
  for (const part of relParts) {
    if (!part || part === '.') continue;
    if (part === '..') {
      if (combined.length > 0) combined.pop();
      else combined.push('..');
    } else {
      combined.push(part);
    }
  }
  return combined.join('/');
}

/**
 * When a note inside a subfolder (`relDir`) references a relative image
 * (`./assets/pic.png`, `assets/pic.gif`, `<img src="assets/pic.gif">`, or
 * `[id]: ./assets/pic.png`), rewrite the path relative to the root export
 * folder (`<relDir>/assets/pic.png`) so merged exports find images and GIFs
 * across all subfolders (#562, #568).
 */
export function rewriteSubfolderRelativeImages(
  line: string,
  relDirSegments: string[],
  noteImageRoot?: string | null,
): string {
  if (relDirSegments.length === 0 && !noteImageRoot) return line;
  let out = line;

  // 1. Standard & linked Markdown images: `![alt](src)` / `[![alt](src)](href)`
  if (out.includes('![')) {
    const spans = findMarkdownImagesInLine(out);
    for (let i = spans.length - 1; i >= 0; i--) {
      const span = spans[i];
      const joined = joinRelativeAssetPath(span.src, relDirSegments, noteImageRoot);
      if (!joined) continue;
      const fullSpan = out.slice(span.start, span.end);
      let replaced = fullSpan;
      if (fullSpan.includes(span.src)) {
        replaced = fullSpan.replace(span.src, joined);
      } else {
        replaced = fullSpan.replace(/(\]\(\s*<?)([^>)\s]+)(>?\s*\))/, `$1${joined}$3`);
      }
      out = `${out.slice(0, span.start)}${replaced}${out.slice(span.end)}`;
    }
  }

  // 2. HTML `<img ... src="...">` tags
  if (/<img\b/i.test(out)) {
    out = out.replace(
      /(<img\b[^>]*?\bsrc=)(["'])([^"']+)\2/gi,
      (full, prefix: string, quote: string, src: string) => {
        const joined = joinRelativeAssetPath(src, relDirSegments, noteImageRoot);
        return joined ? `${prefix}${quote}${joined}${quote}` : full;
      },
    );
  }

  // 3. Markdown reference-style image/link definitions: `[id]: ./assets/pic.gif`
  const refDefMatch = /^(\s*(?:>\s*)*\[[^\]]+\]:\s*)(<[^>\s]+>|[^\s]+)(.*)$/.exec(out);
  if (refDefMatch) {
    const rawDest = refDefMatch[2];
    const hasAngles = rawDest.startsWith('<') && rawDest.endsWith('>');
    const innerDest = hasAngles ? rawDest.slice(1, -1) : rawDest;
    const joined = joinRelativeAssetPath(innerDest, relDirSegments, noteImageRoot);
    if (joined) {
      const wrapped = hasAngles || /\s/.test(joined) ? `<${joined}>` : joined;
      out = `${refDefMatch[1]}${wrapped}${refDefMatch[3]}`;
    }
  }

  return out;
}

export interface MergedHeadingNumberState {
  /** #585 — Running count of numbered level-1 chapters across merged notes. */
  h1Count: number;
}

const MULTI_SEG_HEADING_NUM_RE = /^(\d+)((?:\.\d+)+\.?)[ \t]+(\S[\s\S]*)$/;
const SINGLE_SEG_HEADING_NUM_RE = /^(\d+)(\.?)[ \t]+(\S[\s\S]*)$/;
const CJK_COUNT_UNIT_PREFIX_RE = /^(?:个|种|条|项|大|步|天|周|月|年|分钟|小时|秒|次|款|类)/;

function parseSingleLevel1HeadingNum(text: string): { dot: string; rest: string } | null {
  const m = SINGLE_SEG_HEADING_NUM_RE.exec(text);
  if (!m) return null;
  const num = Number.parseInt(m[1], 10);
  const dot = m[2] || '';
  const rest = m[3];
  if (!Number.isFinite(num) || num <= 0) return null;
  if (!dot) {
    // Avoid treating 4-digit years (`2026 年度总结`) or count phrases (`10 个技巧`) as chapter numbers
    if (num >= 1000 || CJK_COUNT_UNIT_PREFIX_RE.test(rest)) return null;
  }
  return { dot, rest };
}

function rewriteHeadingFirstSegment(
  rawLevel: number,
  headingText: string,
  chapterNum: number,
): string {
  if (chapterNum <= 0) return headingText;
  const multi = MULTI_SEG_HEADING_NUM_RE.exec(headingText);
  if (multi) {
    return `${chapterNum}${multi[2]} ${multi[3]}`;
  }
  if (rawLevel === 1) {
    const single = parseSingleLevel1HeadingNum(headingText);
    if (single) {
      return `${chapterNum}${single.dot} ${single.rest}`;
    }
  }
  return headingText;
}

export function transformNoteForMergedBook(
  rawContent: string,
  baseName: string,
  folderDepth: number,
  relDirSegments: string[] = [],
  numberState?: MergedHeadingNumberState,
): string {
  const noteImageRoot = extractImageRoot(rawContent || '');
  const stripped = (rawContent || '')
    .replace(/^\uFEFF/, '')
    .replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '')
    .trim();

  const noteBaseLevel = 2 + Math.max(0, folderDepth);
  const lines = stripped ? stripped.split(/\r?\n/) : [];
  const outLines: string[] = [];

  // #585 — Pre-scan non-fenced headings so we know whether an unnumbered H1 (or a
  // note without any H1) still owns multi-segment numbered subheadings (`1.1`, `1.1.1`).
  interface ScannedHeading {
    lineIdx: number;
    rawLevel: number;
    text: string;
    hasSubNumberedChildren?: boolean;
  }
  const scannedHeadings: ScannedHeading[] = [];
  {
    let scanFenceChar = '';
    let scanFenceLen = 0;
    let lastH1: ScannedHeading | null = null;
    for (let idx = 0; idx < lines.length; idx++) {
      const l = lines[idx];
      const t = l.trimStart();
      const fm = /^(`{3,}|~{3,})(.*)$/.exec(t);
      if (fm) {
        const marker = fm[1];
        const info = fm[2] || '';
        if (!scanFenceChar) {
          if (marker[0] !== '`' || !info.includes('`')) {
            scanFenceChar = marker[0];
            scanFenceLen = marker.length;
          }
        } else if (marker[0] === scanFenceChar && marker.length >= scanFenceLen && info.trim() === '') {
          scanFenceChar = '';
          scanFenceLen = 0;
        }
        continue;
      }
      if (scanFenceChar) continue;
      const hm = /^( {0,3})(#{1,6})[ \t]+(.+?)(?:[ \t]+#+[ \t]*)?$/.exec(l);
      if (!hm) continue;
      const lvl = hm[2].length;
      const txt = hm[3].trim();
      const entry: ScannedHeading = { lineIdx: idx, rawLevel: lvl, text: txt };
      scannedHeadings.push(entry);
      if (lvl === 1) {
        lastH1 = entry;
      } else if (MULTI_SEG_HEADING_NUM_RE.test(txt) && lastH1) {
        lastH1.hasSubNumberedChildren = true;
      }
    }
  }
  const headingByLine = new Map<number, ScannedHeading>(
    scannedHeadings.map((h) => [h.lineIdx, h]),
  );
  const hasAnyH1InScan = scannedHeadings.some((h) => h.rawLevel === 1);
  const hasOrphanSubNumbers =
    !hasAnyH1InScan && scannedHeadings.some((h) => MULTI_SEG_HEADING_NUM_RE.test(h.text));

  const fallbackTitle = (baseName || 'Untitled').trim() || 'Untitled';
  const fallbackSingleNum = !hasAnyH1InScan ? parseSingleLevel1HeadingNum(fallbackTitle) : null;

  let activeChapterNum = 0;
  if (numberState && !hasAnyH1InScan && (hasOrphanSubNumbers || fallbackSingleNum)) {
    numberState.h1Count += 1;
    activeChapterNum = numberState.h1Count;
  }

  let fenceChar = '';
  let fenceLen = 0;
  let hasH1 = false;

  for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
    const rawLine = lines[lineIdx];
    const trimmed = rawLine.trimStart();
    const fenceMatch = /^(`{3,}|~{3,})(.*)$/.exec(trimmed);
    if (fenceMatch) {
      const marker = fenceMatch[1];
      const info = fenceMatch[2] || '';
      if (!fenceChar) {
        if (marker[0] !== '`' || !info.includes('`')) {
          fenceChar = marker[0];
          fenceLen = marker.length;
        }
      } else if (marker[0] === fenceChar && marker.length >= fenceLen && info.trim() === '') {
        fenceChar = '';
        fenceLen = 0;
      }
      outLines.push(rawLine);
      continue;
    }

    if (fenceChar) {
      outLines.push(rawLine);
      continue;
    }

    const scanned = headingByLine.get(lineIdx);
    if (scanned) {
      const rawLevel = scanned.rawLevel;
      let headingText = scanned.text;
      if (rawLevel === 1) {
        hasH1 = true;
        if (numberState) {
          const isNumberedH1 =
            parseSingleLevel1HeadingNum(headingText) !== null ||
            MULTI_SEG_HEADING_NUM_RE.test(headingText) ||
            Boolean(scanned.hasSubNumberedChildren);
          if (isNumberedH1) {
            numberState.h1Count += 1;
            activeChapterNum = numberState.h1Count;
          } else {
            activeChapterNum = 0;
          }
        }
      } else if (numberState && activeChapterNum === 0 && MULTI_SEG_HEADING_NUM_RE.test(headingText)) {
        numberState.h1Count += 1;
        activeChapterNum = numberState.h1Count;
      }

      if (numberState && activeChapterNum > 0) {
        headingText = rewriteHeadingFirstSegment(rawLevel, headingText, activeChapterNum);
      }

      if (rawLevel <= 3) {
        const targetLevel = noteBaseLevel + (rawLevel - 1);
        outLines.push(formatMergedHeading(targetLevel, headingText));
      } else {
        // #562 — Only extract up to level-3 headings of each note into the TOC
        // and bookmarks; deeper note headings render as bold subheadings in body.
        outLines.push(`**${headingText}**`);
      }
      continue;
    }

    outLines.push(rewriteSubfolderRelativeImages(rawLine, relDirSegments, noteImageRoot));
  }

  const body = outLines.join('\n').trim();
  if (!hasH1) {
    const finalFallback =
      numberState && activeChapterNum > 0
        ? rewriteHeadingFirstSegment(1, fallbackTitle, activeChapterNum)
        : fallbackTitle;
    const synthesizedH1 = formatMergedHeading(noteBaseLevel, finalFallback);
    return body ? `${synthesizedH1}\n\n${body}` : synthesizedH1;
  }
  return body;
}

export function buildMergedBookMarkdown(
  folderName: string,
  notes: MergedNoteInput[],
): string {
  const bookTitle = (folderName || 'Exported-Book').trim() || 'Exported-Book';
  const leadHeader = `# ${bookTitle}\n\n[TOC]`;
  const noteSections: string[] = [];
  let activeFolders: string[] = [];
  const numberState: MergedHeadingNumberState = { h1Count: 0 };

  for (const item of notes) {
    const segs = normalizeRelDir(item.relDir);
    let common = 0;
    while (
      common < segs.length &&
      common < activeFolders.length &&
      segs[common] === activeFolders[common]
    ) {
      common++;
    }
    const folderHeadings: string[] = [];
    for (let d = common; d < segs.length; d++) {
      folderHeadings.push(formatMergedHeading(2 + d, segs[d], true));
    }
    activeFolders = segs;

    if (item.emptyDir) {
      if (folderHeadings.length > 0) {
        noteSections.push(folderHeadings.join('\n\n'));
      }
      continue;
    }

    const noteMarkdown = transformNoteForMergedBook(
      item.content,
      item.baseName,
      segs.length,
      segs,
      numberState,
    );
    noteSections.push([...folderHeadings, noteMarkdown].join('\n\n'));
  }

  if (noteSections.length === 0) {
    return leadHeader;
  }
  const joinedNotes = noteSections.join('\n\n<!-- solomd-page-break -->\n\n---\n\n');
  return `${leadHeader}\n\n---\n\n${joinedNotes}`;
}
