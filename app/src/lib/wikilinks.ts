/**
 * v4.0 pillar 1 — wikilink parsing for the Inline Agent Panel.
 *
 * Mirrors the Rust regex in `mcp-server/src/workspace.rs::extract_wikilinks`
 * + `app/src-tauri/src/workspace_index.rs::extract_wikilinks` so that the
 * agent's text-rendering treats `[[X]]` / `[[X#heading]]` / `[[X|alias]]`
 * the same way the indexer does.
 *
 * Used by AgentPanel.vue to split assistant messages into a sequence of
 * text + wikilink chips. Click handling lives in the panel; this module is
 * pure parsing so it stays test-friendly.
 */

export interface Wikilink {
  /** Fully matched substring including the brackets, e.g. `[[X#h|alias]]`. */
  raw: string;
  target: string;
  heading?: string;
  alias?: string;
}

export type ParsedRun =
  | { type: 'text'; value: string }
  | ({ type: 'wikilink' } & Wikilink);

/** Same shape as the Rust `regex_lite::Regex(r"\[\[([^\[\]\n]+?)\]\]")`. */
const WIKILINK_RE = /\[\[([^\[\]\n]+?)\]\]/g;

/**
 * Parse one wikilink's inner text — `target[#heading][|alias]`. Both
 * `heading` and `alias` are optional and either may come first; in the
 * canonical Obsidian flavor `target` is the stem (no extension), `#`
 * introduces a heading anchor, `|` introduces a display alias.
 */
function parseInner(inner: string): { target: string; alias?: string; heading?: string } {
  // Order matters: alias separator (`|`) is later than the optional heading
  // marker (`#`), so split on `|` first then on `#` in the left half.
  let target = inner.trim();
  let alias: string | undefined;
  let heading: string | undefined;
  const pipeIdx = target.indexOf('|');
  if (pipeIdx >= 0) {
    alias = target.slice(pipeIdx + 1).trim() || undefined;
    target = target.slice(0, pipeIdx).trim();
  }
  const hashIdx = target.indexOf('#');
  if (hashIdx >= 0) {
    heading = target.slice(hashIdx + 1).trim() || undefined;
    target = target.slice(0, hashIdx).trim();
  }
  return { target, alias, heading };
}

/**
 * Return every wikilink in `text`. Targets that resolve to the empty string
 * (e.g. `[[]]` or `[[ ]]`) are dropped — matches the Rust behavior.
 */
export function extractWikilinks(text: string): Wikilink[] {
  const out: Wikilink[] = [];
  WIKILINK_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = WIKILINK_RE.exec(text)) !== null) {
    const { target, alias, heading } = parseInner(m[1]);
    if (!target) continue;
    out.push({ raw: m[0], target, alias, heading });
  }
  return out;
}

/**
 * Split `text` into a flat sequence of text runs and wikilink runs. Useful
 * for v-for rendering in the panel: each text run becomes a `<span>` and
 * each wikilink becomes a clickable chip.
 *
 * Empty text runs are squeezed out so consumers don't render empty spans.
 */
export function parseWithWikilinks(text: string): ParsedRun[] {
  const runs: ParsedRun[] = [];
  WIKILINK_RE.lastIndex = 0;
  let cursor = 0;
  let m: RegExpExecArray | null;
  while ((m = WIKILINK_RE.exec(text)) !== null) {
    if (m.index > cursor) {
      runs.push({ type: 'text', value: text.slice(cursor, m.index) });
    }
    const { target, alias, heading } = parseInner(m[1]);
    if (target) {
      runs.push({ type: 'wikilink', raw: m[0], target, alias, heading });
    } else {
      // Preserve the literal text when we can't resolve the inner.
      runs.push({ type: 'text', value: m[0] });
    }
    cursor = m.index + m[0].length;
  }
  if (cursor < text.length) {
    runs.push({ type: 'text', value: text.slice(cursor) });
  }
  return runs;
}

/** Display text for a chip — alias if set, else target (and heading suffix). */
export function chipLabel(link: Wikilink): string {
  if (link.alias) return link.alias;
  if (link.heading) return `${link.target} › ${link.heading}`;
  return link.target;
}
