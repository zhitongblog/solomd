/**
 * App-level i18n. Lightweight: no library, just a translations map + a
 * reactive `t()` function driven by the settings store's `language` field.
 */

import { computed, watchEffect } from 'vue';
import { useSettingsStore } from '../stores/settings';
import { en } from './en';
import { zh } from './zh';
import { ja } from './ja';
import { ko } from './ko';
import { de } from './de';
import { fr } from './fr';
import { es } from './es';
import { pt } from './pt';
import { it } from './it';
import { pl } from './pl';
import { nl } from './nl';
import { tr } from './tr';
import { sv } from './sv';
import { uk } from './uk';
import { ru } from './ru';

const dicts = { en, zh, ja, ko, de, fr, es, pt, it, pl, nl, tr, sv, uk, ru } as const;
type Lang = keyof typeof dicts;

/** The raw dictionaries, for features that search translations (#352 settings
 *  search looks an English keyword up in `en` and matches the translation). */
export function getDict(lang: string): unknown {
  return dicts[lang as Lang] || en;
}

export function useI18n() {
  const settings = useSettingsStore();
  const dict = computed(() => dicts[settings.language as Lang] || en);

  function lookup(d: any, parts: string[]): string | undefined {
    let cur: any = d;
    for (const p of parts) {
      if (cur == null) return undefined;
      cur = cur[p];
    }
    return typeof cur === 'string' ? cur : undefined;
  }

  function t(key: string, params?: Record<string, string | number>): string {
    const parts = key.split('.');
    // v4.3.5: try active language first, then fall back to English, then to
    // the raw key. Previously missing keys returned the key itself, which
    // made any partially-translated feature look broken in non-en/zh locales.
    // The English fallback means new strings ship in 14 langs immediately
    // (as English) and the proper translations can land in the next minor.
    let str = lookup(dict.value, parts) ?? lookup(en, parts) ?? key;
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        str = str.replace(new RegExp(`\\{${k}\\}`, 'g'), String(v));
      }
    }
    return str;
  }

  return { t, lang: computed(() => settings.language) };
}

/** BCP 47 tag for `<html lang>`; only Chinese needs a region (Simplified). */
export function htmlLangFor(lang: string): string {
  return lang === 'zh' ? 'zh-CN' : lang || 'en';
}

/**
 * K4 — keep `<html lang>` on the UI language. index.html ships "en", so a
 * Chinese UI was tagged English: WebKit picked Japanese-style glyphs for
 * shared Han code points, and hyphenation followed English rules. Called once
 * per window (main.ts) after Pinia is installed, so the slideshow and
 * quick-capture windows follow too.
 */
export function followHtmlLang(): void {
  const settings = useSettingsStore();
  watchEffect(() => {
    document.documentElement.lang = htmlLangFor(settings.language);
  });
}
