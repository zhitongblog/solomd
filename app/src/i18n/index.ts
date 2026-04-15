/**
 * App-level i18n. Lightweight: no library, just a translations map + a
 * reactive `t()` function driven by the settings store's `language` field.
 */

import { computed } from 'vue';
import { useSettingsStore } from '../stores/settings';
import { en } from './en';
import { zh } from './zh';

const dicts = { en, zh } as const;
type Lang = keyof typeof dicts;

export function useI18n() {
  const settings = useSettingsStore();
  const dict = computed(() => dicts[settings.language as Lang] || en);

  function t(key: string, params?: Record<string, string | number>): string {
    const parts = key.split('.');
    let cur: any = dict.value;
    for (const p of parts) {
      if (cur == null) break;
      cur = cur[p];
    }
    let str = typeof cur === 'string' ? cur : key;
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        str = str.replace(new RegExp(`\\{${k}\\}`, 'g'), String(v));
      }
    }
    return str;
  }

  return { t, lang: computed(() => settings.language) };
}
