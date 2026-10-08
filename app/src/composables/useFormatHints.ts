import { useSettingsStore } from '../stores/settings';
import { useToastsStore } from '../stores/toasts';
import { useI18n } from '../i18n';
import { usesCommandKey } from '../lib/platform';
import { shortcutLabel } from '../lib/keybindings';
import { detectTypedFormat, hintKey } from '../lib/format-hint';

/**
 * One-time "there is a key for that" tips (#296 follow-up). Call the returned
 * function with the line up to the caret and the character just typed; it
 * decides whether this is the first time the user has hand-typed a given
 * kind of formatting, and says so once.
 *
 * The chord is read from the live bindings, so a rebound or preset-swapped key
 * is the one shown — and a command the user has unbound is not advertised.
 */
/** One tip at a time. A sentence with `code` and **bold** in it would otherwise
 *  stack two toasts; the second lesson keeps until the next time. Module-level
 *  so split panes (one Editor each) share the clock. */
const MIN_GAP_MS = 120_000;
let lastShownAt = 0;

export function useFormatHints() {
  const settings = useSettingsStore();
  const toasts = useToastsStore();
  const { t } = useI18n();
  const mac = usesCommandKey();

  return function noteTyped(lineBeforeCaret: string, typed: string): void {
    if (!settings.formatHints) return;
    const kind = detectTypedFormat(lineBeforeCaret, typed);
    if (!kind) return;
    const key = hintKey(kind);
    if (settings.formatHintsSeen.includes(key)) return;
    if (Date.now() - lastShownAt < MIN_GAP_MS) return; // not marked seen: it gets its turn later
    const chord = shortcutLabel(`fmt.${kind}`, settings.keybindings, mac);
    if (!chord) return;
    settings.markFormatHintSeen(key);
    lastShownAt = Date.now();
    toasts.push(
      t('hints.formatKey', { key: chord, name: t(`cmd.fmt.${kind}`) }),
      'info',
      9000,
      () => window.dispatchEvent(new CustomEvent('solomd:open-settings', { detail: { section: 'keys' } })),
      { actionLabel: t('hints.formatChange') },
    );
  };
}
