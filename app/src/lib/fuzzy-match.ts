/**
 * Fuzzy matcher for the command palette (5.0 regression C4).
 *
 * The palette used to keep a command only when every query token was a
 * contiguous substring of its text, so a typo-ish query like "togl line" or
 * "exprt pdf" found nothing. This matches each token as a subsequence and
 * scores it the way editors' palettes do:
 *
 *   - a matched character at a word start (after a separator, a camelCase
 *     hump, or any Han character) earns a bonus,
 *   - a run of consecutive matched characters earns a bonus,
 *   - skipping characters costs a little, and jumping into the middle of a
 *     *different* word costs a lot — that is what keeps "tl" from matching
 *     every text that happens to contain a t and later an l.
 *
 * On top of the per-token score, the whole query is compared against the
 * primary texts (the titles): an exact title beats a title prefix, which
 * beats a contiguous substring, which beats any scattered match. So the
 * ranking a user got from the old substring filter is kept, and fuzzy hits
 * only fill in below it.
 *
 * Works on Unicode code points, so Chinese labels match per character.
 */

const START_BONUS = 8;
const CONSEC_BONUS = 5;
const GAP_PENALTY = 1;
const MID_JUMP_PENALTY = 6;
/** The first matched char of a token landing mid-word ("line" in "outline"). */
const FIRST_MID_PENALTY = 2;

const SEP = /[^\p{L}\p{N}]/u;
const HAN = /\p{Script=Han}/u;

function wordStarts(chars: string[]): boolean[] {
  return chars.map((c, j) => {
    if (j === 0) return true;
    const prev = chars[j - 1];
    if (SEP.test(prev)) return true;
    if (HAN.test(c)) return true;
    // camelCase hump: "editor.aiRewrite" → R starts a word.
    return prev !== prev.toUpperCase() && c !== c.toLowerCase() && c === c.toUpperCase();
  });
}

function lowerChars(chars: string[]): string[] {
  return chars.map((c) => {
    const l = c.toLowerCase();
    return l.length === c.length ? l : c;
  });
}

/**
 * Score one query token against one text. Higher is better; `null` means
 * the token's characters do not all appear in order.
 */
export function fuzzyScore(query: string, text: string): number | null {
  const q = lowerChars(Array.from(query.trim()));
  if (q.length === 0) return 0;
  const orig = Array.from(text);
  const t = lowerChars(orig);
  const n = t.length;
  const m = q.length;
  if (m > n) return null;
  const start = wordStarts(orig);
  const NEG = -Infinity;

  let prev = new Array<number>(n).fill(NEG);
  for (let j = 0; j < n; j++) {
    if (t[j] !== q[0]) continue;
    prev[j] = 1 + (start[j] ? START_BONUS : -FIRST_MID_PENALTY) - Math.min(j, 20) * 0.05;
  }
  for (let i = 1; i < m; i++) {
    const cur = new Array<number>(n).fill(NEG);
    let allMax = NEG; // best[i-1][k] over every k <= j-2
    let wordMax = NEG; // … over k <= j-2 inside j's own word
    let wordStart = 0;
    for (let j = 0; j < n; j++) {
      if (start[j]) {
        wordStart = j;
        wordMax = NEG;
      }
      if (j >= 2) {
        const k = j - 2;
        const v = prev[k];
        if (v > allMax) allMax = v;
        if (k >= wordStart && v > wordMax) wordMax = v;
      }
      if (t[j] !== q[i]) continue;
      let best = NEG;
      if (j >= 1 && prev[j - 1] > NEG) {
        best = prev[j - 1] + 1 + CONSEC_BONUS + (start[j] ? START_BONUS : 0);
      }
      if (start[j]) {
        best = Math.max(best, allMax + 1 + START_BONUS - GAP_PENALTY);
      } else {
        best = Math.max(best, wordMax + 1 - GAP_PENALTY, allMax + 1 - GAP_PENALTY - MID_JUMP_PENALTY);
      }
      cur[j] = best;
    }
    prev = cur;
  }
  let out = NEG;
  for (const v of prev) if (v > out) out = v;
  return out === NEG ? null : out;
}

function norm(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, ' ');
}

/** Tier of the whole query against one title (see the header). */
function wholeQueryTier(q: string, title: string): number {
  const t = norm(title);
  if (!t) return 0;
  if (t === q) return 4;
  if (t.startsWith(q)) return 3;
  const at = t.indexOf(q);
  if (at > 0) return SEP.test(t[at - 1]) ? 2 : 1;
  return 0;
}

const TIER_WEIGHT = 1000;

/**
 * Score a query against an item described by `primary` texts (titles — they
 * decide the tier) and `secondary` texts (ids — they can satisfy a token
 * but score lower) and `literal` texts (long prose such as a command's hint:
 * a token only counts there as a contiguous substring, because a subsequence
 * is found in almost any sentence). Every whitespace-separated token must
 * match some text. Returns `null` when the item does not match.
 */
export function scoreItem(
  query: string,
  primary: string[],
  secondary: string[] = [],
  literal: string[] = [],
): number | null {
  const q = norm(query);
  if (!q) return 0;
  let total = 0;
  for (const tok of q.split(' ')) {
    let best: number | null = null;
    for (const p of primary) {
      const s = fuzzyScore(tok, p);
      if (s !== null && (best === null || s > best)) best = s;
    }
    for (const p of secondary) {
      const raw = fuzzyScore(tok, p);
      const s = raw === null ? null : raw * 0.6;
      if (s !== null && (best === null || s > best)) best = s;
    }
    if (best === null && literal.some((p) => p.toLowerCase().includes(tok))) best = 1;
    if (best === null) return null;
    total += best;
  }
  let tier = 0;
  for (const p of primary) tier = Math.max(tier, wholeQueryTier(q, p));
  return tier * TIER_WEIGHT + total;
}

/**
 * Filter and rank `items` for `query`. Ties keep the input order, so an empty
 * or equal-scoring query preserves the caller's list order.
 */
export function fuzzyRank<T>(
  query: string,
  items: readonly T[],
  texts: (item: T) => { primary: string[]; secondary?: string[]; literal?: string[] },
): T[] {
  if (!norm(query)) return items.slice();
  const scored: Array<{ item: T; score: number; idx: number }> = [];
  items.forEach((item, idx) => {
    const { primary, secondary, literal } = texts(item);
    const score = scoreItem(query, primary, secondary ?? [], literal ?? []);
    if (score !== null) scored.push({ item, score, idx });
  });
  scored.sort((a, b) => b.score - a.score || a.idx - b.idx);
  return scored.map((s) => s.item);
}
