/**
 * tldraw-markdown.ts — pure, framework-free parse/serialize for the
 * Markdown-backed whiteboard fence.
 *
 * This is a direct port of Tolaria's `src/utils/tldrawMarkdown.ts` fence
 * format so the on-disk bytes are byte-compatible across both apps. A
 * whiteboard lives entirely inside the note's Markdown as a fenced block:
 *
 *     ```tldraw id="<uuid>" height="520" width=""
 *     { ...JSON.stringify(TLStoreSnapshot, null, 2)... }
 *     ```
 *
 * Key invariants ported 1:1 from Tolaria:
 *   - Attributes (`id` / `height` / `width`) live on the fence info string,
 *     NOT in frontmatter — the board is self-describing inline.
 *   - Attribute values are `&quot;`-escaped when serialized and read back via
 *     a tolerant regex that accepts `"…"`, `'…'`, or bare tokens.
 *   - The fence length auto-grows past the longest backtick run inside the
 *     JSON body (`fenceLengthForSnapshot`), so a snapshot containing
 *     backticks can never corrupt the file.
 *   - The body is the pretty-printed snapshot + a trailing newline.
 *
 * NO tldraw import here — this module is the shared, unit-testable string
 * layer used by the editor widget, the preview/export pipeline, and the
 * round-trip checks. It compiles cleanly with or without the tldraw package.
 */

export const TLDRAW_DEFAULT_HEIGHT = '520';

export interface TldrawFence {
  /** Stable board id (the fence `id="…"` attribute). May be '' if absent. */
  boardId: string;
  /** Fence `height="…"` in CSS px (string). Defaults to TLDRAW_DEFAULT_HEIGHT. */
  height: string;
  /** Fence `width="…"`; '' means "full width / auto". */
  width: string;
  /** Pretty-printed `JSON.stringify(TLStoreSnapshot, null, 2)` body (no trailing newline). */
  snapshot: string;
}

interface FenceAttributeRequest {
  info: string;
  name: 'height' | 'id' | 'width';
}

/**
 * Read a single attribute off a fence info string. Ported from Tolaria:
 * accepts double-quoted, single-quoted, or bare values, returns '' if
 * the attribute is absent.
 */
export function readFenceAttribute({ info, name }: FenceAttributeRequest): string {
  for (const match of info.matchAll(/\b([A-Za-z][\w-]*)=(?:"([^"]*)"|'([^']*)'|([^\s]+))/gu)) {
    if (match[1] === name) {
      return decodeFenceAttribute(match[2] ?? match[3] ?? match[4] ?? '');
    }
  }
  return '';
}

function decodeFenceAttribute(value: string): string {
  return value.replace(/&quot;/gu, '"');
}

function escapeFenceAttribute(value: string): string {
  return value.replace(/"/gu, '&quot;');
}

/**
 * Compute the fence length: at least 3 backticks, always one more than the
 * longest backtick run inside the snapshot body. Ported 1:1 from Tolaria's
 * `fenceLengthForSnapshot` so a board whose JSON contains backticks (e.g. a
 * text shape with code) never breaks out of its fence.
 */
export function fenceLengthForSnapshot(snapshot: string): number {
  const longestRun = Math.max(
    0,
    ...Array.from(snapshot.matchAll(/`+/gu), (m) => m[0].length),
  );
  return Math.max(3, longestRun + 1);
}

function fenceMetadata({ boardId, height, width }: Omit<TldrawFence, 'snapshot'>): string {
  const attributes: string[] = [];
  if (boardId) attributes.push(`id="${escapeFenceAttribute(boardId)}"`);
  if (height) attributes.push(`height="${escapeFenceAttribute(height)}"`);
  // width is always emitted (even empty) to mirror Tolaria's default board
  // header `width=""`, which keeps round-trips byte-stable.
  attributes.push(`width="${escapeFenceAttribute(width)}"`);
  return attributes.length > 0 ? ` ${attributes.join(' ')}` : '';
}

/**
 * Serialize a whiteboard back to its exact on-disk fence. Mirrors Tolaria's
 * `tldrawFenceSource`: opening fence + ` tldraw` + attributes, the snapshot
 * body, a trailing newline, then the closing fence.
 */
export function serializeTldrawFence(fence: TldrawFence): string {
  const snapshot = fence.snapshot.trim() || '{}';
  const ticks = '`'.repeat(fenceLengthForSnapshot(snapshot));
  const metadata = fenceMetadata({
    boardId: fence.boardId,
    height: fence.height || TLDRAW_DEFAULT_HEIGHT,
    width: fence.width,
  });
  const body = snapshot.endsWith('\n') ? snapshot : `${snapshot}\n`;
  return `${ticks}tldraw${metadata}\n${body}${ticks}`;
}

/**
 * True when `info` (the text after the opening backticks) names a tldraw
 * fence. Tolerant of leading/trailing whitespace and case.
 */
export function isTldrawFenceInfo(info: string): boolean {
  const [language = ''] = info.trim().split(/\s+/u);
  return language.toLowerCase() === 'tldraw';
}

/**
 * Parse a fence's info string + body into a {@link TldrawFence}. `info` is
 * everything after the opening backticks on the fence line (e.g.
 * `tldraw id="…" height="520" width=""`). `body` is the raw text between the
 * fences (the JSON snapshot, possibly with surrounding whitespace).
 *
 * Returns null when `info` is not a tldraw fence.
 */
export function parseTldrawFence(info: string, body: string): TldrawFence | null {
  if (!isTldrawFenceInfo(info)) return null;
  const [, ...infoParts] = info.trim().split(/\s+/u);
  const attrs = infoParts.join(' ');
  return {
    boardId: readFenceAttribute({ info: attrs, name: 'id' }),
    height: readFenceAttribute({ info: attrs, name: 'height' }) || TLDRAW_DEFAULT_HEIGHT,
    width: readFenceAttribute({ info: attrs, name: 'width' }),
    snapshot: body.trim(),
  };
}

/**
 * Validate / normalize a snapshot string. Hand-edited or corrupt JSON falls
 * back to an empty board (`{}`) so the editor never throws on load — the
 * board widget treats `{}` as "fresh empty board". Returns the parsed object
 * on success, or null when the JSON is unusable.
 */
export function parseSnapshotJson(snapshot: string): unknown | null {
  const trimmed = (snapshot || '').trim();
  if (!trimmed || trimmed === '{}') return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

/** Generate a fresh board id. Prefers crypto.randomUUID, falls back to a v4-ish id. */
export function newBoardId(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID();
    }
  } catch {
    /* fall through */
  }
  // RFC4122-ish fallback (not cryptographically strong, fine for a doc id).
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/gu, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

/** An empty board fence snippet (used by the slash command + insert path). */
export function emptyBoardFence(boardId: string = newBoardId()): string {
  return serializeTldrawFence({
    boardId,
    height: TLDRAW_DEFAULT_HEIGHT,
    width: '',
    snapshot: '{}',
  });
}

export interface TldrawFenceMatch extends TldrawFence {
  /** Character offset (in the source) of the opening fence line start. */
  from: number;
  /** Character offset (in the source) just past the closing fence line. */
  to: number;
  /** Character offset of the snapshot body start (first body char). */
  bodyFrom: number;
  /** Character offset of the snapshot body end (just past last body char). */
  bodyTo: number;
}

/**
 * Scan a whole Markdown document for every ```tldraw fence. Pure string
 * logic — used by preview/export to locate boards and by the round-trip
 * checks. Honours the variable fence length (3+ backticks): a fence is
 * closed by a line containing the same number of backticks (or more).
 */
export function findTldrawFences(source: string): TldrawFenceMatch[] {
  const matches: TldrawFenceMatch[] = [];
  const lines = source.split('\n');
  // Precompute the char offset at the start of each line.
  const lineStart: number[] = new Array(lines.length);
  let acc = 0;
  for (let i = 0; i < lines.length; i++) {
    lineStart[i] = acc;
    acc += lines[i].length + 1; // +1 for the '\n' separator
  }
  const OPEN_RE = /^(\s*)(`{3,})\s*(tldraw\b[^\n]*)$/iu;
  let i = 0;
  while (i < lines.length) {
    const m = OPEN_RE.exec(lines[i]);
    if (!m) {
      i++;
      continue;
    }
    const fenceTicks = m[2].length;
    const info = m[3];
    const CLOSE_RE = new RegExp(`^\\s*\`{${fenceTicks},}\\s*$`);
    let endLine = i + 1;
    while (endLine < lines.length && !CLOSE_RE.test(lines[endLine])) {
      endLine++;
    }
    if (endLine >= lines.length) {
      // Unclosed fence — stop scanning (matches markdown-it's tolerance).
      break;
    }
    const bodyLines = lines.slice(i + 1, endLine);
    const body = bodyLines.join('\n');
    const parsed = parseTldrawFence(info, body);
    if (parsed) {
      const from = lineStart[i];
      const bodyFrom = lineStart[i + 1] ?? lineStart[i] + lines[i].length + 1;
      const bodyTo =
        bodyLines.length > 0
          ? lineStart[endLine - 1] + lines[endLine - 1].length
          : bodyFrom;
      const to = lineStart[endLine] + lines[endLine].length;
      matches.push({ ...parsed, from, to, bodyFrom, bodyTo });
    }
    i = endLine + 1;
  }
  return matches;
}
