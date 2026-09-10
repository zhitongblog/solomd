// Every language's what's-new prose, keyed by locale.
import type { WhatsNewData } from './types';
import en from './en';
import zh from './zh';
import de from './de';
import es from './es';

export const whatsNew: Partial<Record<string, WhatsNewData>> & { en: WhatsNewData } = {
  en,
  zh,
  de,
  es,
};
