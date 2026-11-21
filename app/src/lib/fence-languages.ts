// Explicit .ts: `node --test` loads this module graph directly and Node's ESM
// resolver will not guess an extension (tsconfig has allowImportingTsExtensions).
import { codeLanguages } from './code-languages.ts';

/**
 * Issue #297 — the catalogue behind the ``` fence-language picker.
 *
 * Three groups, in the order the user sees them before typing anything:
 *
 *  1. `SPECIAL_FENCES` — fences SoloMD renders itself (mermaid, tldraw,
 *     plantuml). Nobody guesses that `tldraw` is what opens a whiteboard, so
 *     they go first.
 *  2. The code-editor languages, *derived* from `codeLanguages` rather than
 *     copied, so the picker can never offer something the editor fails to
 *     highlight.
 *  3. `PREVIEW_ONLY` — highlight.js languages the preview knows and
 *     CodeMirror does not. The Windows live editor renders through the same
 *     markdown-it + highlight.js pipeline as the preview, so ```ruby really is
 *     coloured there; only the code editor leaves it plain.
 *
 * Both editors share this file, so they can never disagree about what a fence
 * language is.
 */

export interface FenceLanguage {
  /** What gets written after the opening backticks. */
  name: string;
  /** Other spellings that find it: `rs` → rust, `yml` → yaml. */
  aliases: string[];
  /** Muted text on the right of the row. */
  hint?: string;
  /** SoloMD renders this fence itself instead of syntax-highlighting it. */
  special?: boolean;
  /** Extra words the filter matches but never shows: `flowchart` → mermaid. */
  keywords: string[];
}

// Every word a row shows as its hint is searchable too — the test below holds
// that line, because "whiteboard" that cannot find tldraw is worse than no
// hint at all.
const SPECIAL_FENCES: FenceLanguage[] = [
  {
    name: 'mermaid',
    aliases: [],
    hint: 'diagram',
    special: true,
    keywords: ['diagram', 'flowchart', 'sequence', 'gantt', 'chart', 'class'],
  },
  {
    name: 'tldraw',
    aliases: [],
    hint: 'whiteboard',
    special: true,
    keywords: ['whiteboard', 'board', 'draw', 'canvas', 'sketch'],
  },
  {
    name: 'plantuml',
    aliases: ['puml'],
    hint: 'UML',
    special: true,
    keywords: ['uml', 'diagram', 'sequence', 'class'],
  },
];

/** `LanguageDescription.of()` appends the name to `alias`, so drop it here —
 *  otherwise the hint for python would read "py, python". */
const CODE_LANGUAGES: FenceLanguage[] = codeLanguages.map((lang) => {
  const aliases = (lang.alias ?? []).filter((a) => a !== lang.name);
  return {
    name: lang.name,
    aliases: [...aliases],
    hint: aliases.length ? aliases.join(', ') : undefined,
    keywords: [],
  };
});

/** Checked against `highlight.js/lib/common` (36 languages): every name and
 *  alias below resolves there, and `fence-languages.test.ts` keeps it that way
 *  so the picker cannot start promising languages the preview silently
 *  ignores. */
const PREVIEW_ONLY: Array<[string, string[]]> = [
  ['autohotkey', ['ahk']],
  ['awk', []],
  ['bash', ['sh', 'zsh', 'shell']],
  ['csharp', ['cs']],
  ['diff', []],
  ['graphql', ['gql']],
  ['ini', ['toml']],
  ['kotlin', ['kt']],
  ['less', []],
  ['lua', []],
  ['makefile', ['make']],
  ['markdown', ['md']],
  ['objectivec', ['objc']],
  ['perl', ['pl']],
  ['php', []],
  ['plaintext', ['text', 'txt']],
  ['r', []],
  ['ruby', ['rb']],
  ['scss', []],
  ['swift', []],
  ['vbnet', ['vb']],
  ['wasm', []],
];

export const FENCE_LANGUAGES: FenceLanguage[] = [
  ...SPECIAL_FENCES,
  ...CODE_LANGUAGES,
  ...PREVIEW_ONLY.map(([name, aliases]) => ({
    name,
    aliases,
    hint: aliases.length ? aliases.join(', ') : undefined,
    keywords: [],
  })),
];

function isSubsequence(needle: string, haystack: string): boolean {
  let i = 0;
  for (const ch of haystack) {
    if (ch === needle[i]) i++;
    if (i === needle.length) return true;
  }
  return needle.length === 0;
}

/** 0 means "does not match", higher wins. Same shape as the scoring in
 *  `slash-blocks.ts` so the two pickers feel alike. */
function scoreLanguage(lang: FenceLanguage, query: string): number {
  const name = lang.name.toLowerCase();
  if (name === query) return 1000;
  if (name.startsWith(query)) return 800;
  if (name.includes(query)) return 600;

  let best = 0;
  for (const alias of lang.aliases) {
    const a = alias.toLowerCase();
    // An exact alias beats a name prefix on purpose: "py" should put python
    // first, not merely keep it in the running.
    if (a === query) best = Math.max(best, 900);
    else if (a.startsWith(query)) best = Math.max(best, 700);
    else if (a.includes(query)) best = Math.max(best, 500);
  }
  if (best) return best;

  for (const keyword of lang.keywords) {
    const k = keyword.toLowerCase();
    if (k === query) return 400;
    if (k.startsWith(query)) return 350;
    if (k.includes(query)) return 300;
  }

  // Last resort, so half-remembered words still land: "tldr" → tldraw.
  return isSubsequence(query, name) ? 100 : 0;
}

/** Filter and rank the catalogue. An empty query returns it in catalogue
 *  order, which is what makes the first row stable while the user types. */
export function filterFenceLanguages(
  query: string,
  limit = Number.POSITIVE_INFINITY,
): FenceLanguage[] {
  const q = query.trim().toLowerCase();
  if (!q) return FENCE_LANGUAGES.slice(0, limit);

  const ranked: Array<{ lang: FenceLanguage; score: number; index: number }> = [];
  FENCE_LANGUAGES.forEach((lang, index) => {
    const s = scoreLanguage(lang, q);
    if (s > 0) ranked.push({ lang, score: s, index });
  });
  ranked.sort((a, b) => b.score - a.score || a.index - b.index);
  return ranked.slice(0, limit).map((r) => r.lang);
}

export interface FenceOpener {
  /** The backticks themselves, e.g. "```". */
  marker: string;
  /** The info string typed so far, e.g. "py". May be empty. */
  query: string;
  /** Index in `before` where the query starts (just past the backticks). */
  queryStart: number;
}

/** An unterminated fence opener at the very end of `before`, if there is one.
 *
 *  Backticks only: SoloMD's live blocks (`cm-live-blocks.ts`) and the
 *  mermaid/tldraw renderers all key off ``` fences, so offering a language for
 *  a ~~~ fence would promise diagrams that never appear. */
const FENCE_OPENER_RE = /(?:^|\n)[ \t]*(`{3,})([A-Za-z0-9_+.#-]*)$/;

export function matchFenceOpener(before: string): FenceOpener | null {
  const m = FENCE_OPENER_RE.exec(before);
  if (!m) return null;
  const query = m[2];
  return { marker: m[1], query, queryStart: before.length - query.length };
}

/** True when the caret's line sits inside a fence that is already open — i.e.
 *  the backticks being typed are a *closing* fence.
 *
 *  Without this, ending a code block would pop the language list, and Enter —
 *  which the popup owns while it is open — would insert a language into the
 *  closing fence and corrupt it. The block editor passes only its own block of
 *  text, which still catches the case that matters there (the closing fence of
 *  that block's own code).
 *
 *  Two rules, both from CommonMark rather than from counting backtick runs:
 *  an opening fence may carry an info string (` ```python `), and a closing
 *  fence may not — so ` ```pyt ` inside a block is content, not a closer. It
 *  also has to be at least as long as the fence it closes. */
export function isInsideFenceBefore(beforeLine: string): boolean {
  let openTicks = 0;
  for (const line of beforeLine.split('\n')) {
    const fence = /^[ \t]*(`{3,})(.*)$/.exec(line);
    if (!fence) continue;
    const [, ticks, rest] = fence;
    if (openTicks === 0) {
      openTicks = ticks.length;
      continue;
    }
    if (rest.trim() === '' && ticks.length >= openTicks) openTicks = 0;
  }
  return openTicks > 0;
}
