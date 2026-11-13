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

export interface MergedNoteInput {
  path?: string;
  relDir: string;
  baseName: string;
  content: string;
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

/**
 * When a note inside a subfolder (`relDir`) references a relative image
 * (`./assets/pic.png` or `assets/pic.png`), rewrite the path relative to the
 * root export folder (`<relDir>/assets/pic.png`) so merged exports find images
 * across all subfolders.
 */
export function rewriteSubfolderRelativeImages(line: string, relDirSegments: string[]): string {
  if (relDirSegments.length === 0 || !line.includes('![')) return line;
  const spans = findMarkdownImagesInLine(line);
  if (spans.length === 0) return line;
  const prefix = relDirSegments.join('/');
  let out = line;
  for (let i = spans.length - 1; i >= 0; i--) {
    const span = spans[i];
    const src = span.src.trim();
    if (
      !src ||
      /^(?:https?:|data:|blob:|asset:|tauri:|file:|\/|[a-zA-Z]:[\\/])/i.test(src)
    ) {
      continue;
    }
    const cleanRel = src.replace(/^\.\//, '');
    const joined = `${prefix}/${cleanRel}`;
    const fullSpan = out.slice(span.start, span.end);
    const replaced = fullSpan.replace(span.src, joined);
    out = `${out.slice(0, span.start)}${replaced}${out.slice(span.end)}`;
  }
  return out;
}

export function transformNoteForMergedBook(
  rawContent: string,
  baseName: string,
  folderDepth: number,
  relDirSegments: string[] = [],
): string {
  const stripped = (rawContent || '')
    .replace(/^\uFEFF/, '')
    .replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '')
    .trim();

  const noteBaseLevel = 2 + Math.max(0, folderDepth);
  const lines = stripped ? stripped.split(/\r?\n/) : [];
  const outLines: string[] = [];

  let fenceChar = '';
  let fenceLen = 0;
  let hasH1 = false;

  for (const rawLine of lines) {
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

    const headingMatch = /^( {0,3})(#{1,6})[ \t]+(.+?)(?:[ \t]+#+[ \t]*)?$/.exec(rawLine);
    if (headingMatch) {
      const rawLevel = headingMatch[2].length;
      const headingText = headingMatch[3].trim();
      if (rawLevel === 1) {
        hasH1 = true;
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

    outLines.push(rewriteSubfolderRelativeImages(rawLine, relDirSegments));
  }

  const body = outLines.join('\n').trim();
  const fallbackTitle = (baseName || 'Untitled').trim() || 'Untitled';
  if (!hasH1) {
    const synthesizedH1 = formatMergedHeading(noteBaseLevel, fallbackTitle);
    return body ? `${synthesizedH1}\n\n${body}` : synthesizedH1;
  }
  return body;
}

export function buildMergedBookMarkdown(
  folderName: string,
  notes: MergedNoteInput[],
): string {
  const bookTitle = (folderName || 'Exported-Book').trim() || 'Exported-Book';
  const sections: string[] = [`# ${bookTitle}\n\n[TOC]`];
  let activeFolders: string[] = [];

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

    const noteMarkdown = transformNoteForMergedBook(
      item.content,
      item.baseName,
      segs.length,
      segs,
    );
    sections.push([...folderHeadings, noteMarkdown].join('\n\n'));
  }

  return sections.join('\n\n---\n\n');
}
