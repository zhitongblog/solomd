/**
 * Markdown heading folding — the document model.
 *
 * A heading owns everything under it up to the next heading of the same or a
 * shallower level, which is the unit people actually want collapsed. This
 * module answers "which lines belong to the section that starts here" for
 * plain text, and both editors build on it:
 *
 *   - CodeMirror (`cm-heading-fold.ts`) turns a range into a `foldService`.
 *   - The Windows plain-textarea block editor hides whole blocks whose
 *     character range falls inside a folded section.
 *
 * Keeping the scan here (rather than reading CodeMirror's syntax tree) is what
 * lets the Windows editor fold at all — it has no tree. It also means one set
 * of rules for fenced code and front matter instead of two that drift.
 */

export interface HeadingSpan {
  /** 1–6, from the number of `#`. */
  level: number;
  /** 0-based index of the heading line. */
  line: number;
  /** 0-based index of the last line the section owns. Equals `line` when the
   *  section is empty. */
  endLine: number;
  /** Character offset of the start of the heading line. */
  start: number;
  /** Character offset just past the heading text — where a fold starts. */
  headingEnd: number;
  /** Character offset at the end of `endLine` — where a fold ends. */
  end: number;
  /** The heading line, trimmed. Used to re-find a fold after an edit shifts
   *  line numbers. */
  title: string;
  /** False when there is nothing under the heading to hide. */
  foldable: boolean;
}

/** A fold remembered across edits: the line it was on plus the heading text,
 *  so a shifted line can be re-found instead of folding the wrong section. */
export interface FoldAnchor {
  line: number;
  title: string;
}

export interface FoldRange {
  from: number;
  to: number;
}

/** Line-start offsets for `lines`, so callers can map line ↔ character. */
function lineStarts(lines: string[]): number[] {
  const starts: number[] = [];
  let off = 0;
  for (const line of lines) {
    starts.push(off);
    off += line.length + 1; // +1 for the \n we split on
  }
  return starts;
}

/**
 * Every ATX heading in `text`, with the extent of the section it owns.
 *
 * Deliberately ignores headings inside fenced code (` ``` ` / `~~~`) and YAML
 * front matter — a `# comment` in a shell block is not a heading, and folding
 * one would eat the rest of the document. Setext headings (`===` underlines)
 * are not recognised: `---` is ambiguous with both front matter and thematic
 * breaks, and treating it as a heading turns an innocent horizontal rule into
 * a fold point.
 */
export function scanHeadings(text: string): HeadingSpan[] {
  const lines = text.split('\n');
  const starts = lineStarts(lines);
  const found: { level: number; line: number }[] = [];

  let fence: string | null = null;
  let inFrontMatter = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (i === 0 && /^---\s*$/.test(line)) {
      inFrontMatter = true;
      continue;
    }
    if (inFrontMatter) {
      if (/^(---|\.\.\.)\s*$/.test(line)) inFrontMatter = false;
      continue;
    }
    const fenceMark = line.match(/^ {0,3}(`{3,}|~{3,})/);
    if (fence) {
      if (fenceMark && fenceMark[1][0] === fence[0] && fenceMark[1].length >= fence.length) {
        fence = null;
      }
      continue;
    }
    if (fenceMark) {
      fence = fenceMark[1];
      continue;
    }
    const heading = line.match(/^ {0,3}(#{1,6})(\s|$)/);
    if (heading) found.push({ level: heading[1].length, line: i });
  }

  const isBlank = (i: number) => lines[i].trim() === '';
  return found.map((h, idx) => {
    let endLine = lines.length - 1;
    for (let j = idx + 1; j < found.length; j++) {
      if (found[j].level <= h.level) {
        endLine = found[j].line - 1;
        break;
      }
    }
    // Trailing blank lines stay visible: folding them away collapses the gap
    // that separates this section's heading from the next one, and the result
    // reads as though the headings were run together.
    while (endLine > h.line && isBlank(endLine)) endLine--;
    const headingEnd = starts[h.line] + lines[h.line].length;
    const end = starts[endLine] + lines[endLine].length;
    return {
      level: h.level,
      line: h.line,
      endLine,
      start: starts[h.line],
      headingEnd,
      end,
      title: lines[h.line].trim(),
      foldable: endLine > h.line,
    };
  });
}

/** The fold range for the heading on `line` (0-based), or null if that line is
 *  not a foldable heading. */
export function foldRangeAtLine(text: string, line: number): FoldRange | null {
  const span = scanHeadings(text).find((h) => h.line === line);
  if (!span || !span.foldable) return null;
  return { from: span.headingEnd, to: span.end };
}

/**
 * Heading lines to fold so the document reads down to `level`.
 *
 * "Fold to level 2" shows H1 and H2 and hides everything beneath them, which
 * means folding every heading at level ≥ 2 — the same sense as VS Code's
 * "Fold Level N".
 */
export function headingLinesAtOrBelow(text: string, level: number): number[] {
  return scanHeadings(text)
    .filter((h) => h.foldable && h.level >= level)
    .map((h) => h.line);
}

/** All foldable heading lines, deepest sections first so folding them in order
 *  never re-expands an outer one. */
export function allFoldableHeadingLines(text: string): number[] {
  return scanHeadings(text)
    .filter((h) => h.foldable)
    .map((h) => h.line);
}

/**
 * Character ranges hidden by the given folded heading lines, merged.
 *
 * Folding an outer section subsumes any inner folds, so overlapping ranges
 * collapse into one — a consumer can test a block against the result without
 * worrying about nesting.
 */
export function foldedCharRanges(text: string, foldedLines: Iterable<number>): FoldRange[] {
  const wanted = new Set(foldedLines);
  if (wanted.size === 0) return [];
  const ranges = scanHeadings(text)
    .filter((h) => h.foldable && wanted.has(h.line))
    .map((h) => ({ from: h.headingEnd, to: h.end }))
    .sort((a, b) => a.from - b.from);
  const merged: FoldRange[] = [];
  for (const r of ranges) {
    const last = merged[merged.length - 1];
    if (last && r.from <= last.to) last.to = Math.max(last.to, r.to);
    else merged.push({ ...r });
  }
  return merged;
}

/** Drop folds that no longer sit on a foldable heading — the user edited the
 *  document out from under them. */
export function pruneFolds(text: string, foldedLines: Iterable<number>): number[] {
  const live = new Set(allFoldableHeadingLines(text));
  return [...foldedLines].filter((l) => live.has(l));
}

/** An anchor for the heading on `line`, or null if there isn't a foldable one. */
export function anchorAtLine(text: string, line: number): FoldAnchor | null {
  const span = scanHeadings(text).find((h) => h.line === line && h.foldable);
  return span ? { line: span.line, title: span.title } : null;
}

/**
 * Move folds onto the lines their headings now occupy.
 *
 * Typing above a heading shifts every line below it, and a fold stored as a
 * bare line number would then collapse whatever section slid into that slot —
 * a section the user never asked to hide. Matching on the heading text first
 * (nearest occurrence to the remembered line wins) keeps the fold on the
 * heading it was made for; a heading that was deleted or is no longer foldable
 * drops out entirely.
 */
export function remapFolds(text: string, folds: FoldAnchor[]): FoldAnchor[] {
  if (!folds.length) return [];
  const spans = scanHeadings(text).filter((h) => h.foldable);
  const out: FoldAnchor[] = [];
  const taken = new Set<number>();
  for (const fold of folds) {
    const candidates = spans.filter((h) => h.title === fold.title && !taken.has(h.line));
    if (!candidates.length) continue;
    const best = candidates.reduce((a, b) =>
      Math.abs(b.line - fold.line) < Math.abs(a.line - fold.line) ? b : a,
    );
    taken.add(best.line);
    out.push({ line: best.line, title: best.title });
  }
  return out;
}

/** True when `offset` falls inside one of `ranges`. */
export function isInsideRanges(ranges: FoldRange[], offset: number): boolean {
  return ranges.some((r) => offset > r.from && offset <= r.to);
}
