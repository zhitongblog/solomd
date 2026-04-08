/**
 * Chinese power-user text utilities.
 *
 * Pure functions: no stores, no DOM, no I/O. Safe to import from anywhere.
 *
 * - Simplified <-> Traditional conversion via opencc-js (synchronous
 *   Converter factory, lazily constructed and cached on first use).
 * - Hanzi -> Pinyin via pinyin-pro.
 * - CJK-aware word counting that handles mixed Chinese/Japanese/Korean +
 *   ASCII content sensibly.
 */

// opencc-js exports are synchronous: `Converter({ from, to })` returns a
// plain `(s: string) => string`. The library does a bit of dictionary
// parsing on construction though, so we cache instances per direction.
// @ts-ignore — opencc-js ships no TypeScript declarations
import * as OpenCC from 'opencc-js';
import { pinyin as pinyinFn } from 'pinyin-pro';

type OpenCCConverter = (s: string) => string;

let s2tConverter: OpenCCConverter | null = null;
let t2sConverter: OpenCCConverter | null = null;

function getS2T(): OpenCCConverter {
  if (!s2tConverter) {
    // cn -> tw gives a fuller Traditional conversion (incl. phrase-level
    // substitutions) than hk or plain `t`.
    s2tConverter = (OpenCC as any).Converter({ from: 'cn', to: 'tw' }) as OpenCCConverter;
  }
  return s2tConverter;
}

function getT2S(): OpenCCConverter {
  if (!t2sConverter) {
    t2sConverter = (OpenCC as any).Converter({ from: 'tw', to: 'cn' }) as OpenCCConverter;
  }
  return t2sConverter;
}

/** Convert Simplified Chinese text to Traditional. Non-Chinese passes through. */
export function simplifiedToTraditional(text: string): string {
  if (!text) return '';
  return getS2T()(text);
}

/** Convert Traditional Chinese text to Simplified. Non-Chinese passes through. */
export function traditionalToSimplified(text: string): string {
  if (!text) return '';
  return getT2S()(text);
}

/**
 * Convert Hanzi in `text` to pinyin. Non-Chinese characters pass through.
 *
 * Defaults: no tone marks, lowercase, space-separated.
 */
export function pinyin(
  text: string,
  opts: { tone?: boolean; separator?: string } = {}
): string {
  if (!text) return '';
  const { tone = false, separator = ' ' } = opts;
  const result = pinyinFn(text, {
    toneType: tone ? 'symbol' : 'none',
    type: 'string',
    separator,
  });
  return typeof result === 'string' ? result.toLowerCase() : String(result).toLowerCase();
}

/**
 * Count CJK + ASCII words in `text`.
 *
 * `cjk` counts individual ideographs / kana / hangul syllables (each
 * "character" is one word in CJK writing systems). `asciiWords` runs a
 * whitespace split on whatever is left after stripping CJK. `total` is a
 * sane mixed-content word count that usually matches what people expect
 * to see in a status-bar "word count" indicator.
 */
export function cjkWordCount(text: string): {
  cjk: number;
  asciiWords: number;
  total: number;
  chars: number;
  withSpaces: number;
} {
  if (!text) {
    return { cjk: 0, asciiWords: 0, total: 0, chars: 0, withSpaces: 0 };
  }

  // CJK Unified Ideographs (incl. Ext A) + Japanese kana + Korean Hangul syllables.
  const cjkRe = /[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]/g;
  const cjkMatches = text.match(cjkRe);
  const cjk = cjkMatches ? cjkMatches.length : 0;

  // Strip the CJK characters, then whitespace-split the remainder for ASCII
  // "word" counting. Tokens that are nothing but punctuation/symbols are
  // filtered out — a real word needs at least one letter or digit.
  const nonCjk = text.replace(cjkRe, ' ');
  const asciiWords = nonCjk
    .split(/\s+/)
    .filter((w) => w.length > 0 && /[\p{L}\p{N}]/u.test(w)).length;

  const withSpaces = text.length;
  const chars = text.replace(/\s+/g, '').length;

  return {
    cjk,
    asciiWords,
    total: cjk + asciiWords,
    chars,
    withSpaces,
  };
}
