/**
 * The quick-capture hotkey's default, and the one-time move off the old one.
 *
 * Quick capture registers a *global* chord (Rust, tauri-plugin-global-shortcut),
 * so it is answered before the webview ever sees the key — including while
 * SoloMD itself is focused. Its default must therefore never equal a chord an
 * in-app action ships with: the old default `CmdOrCtrl+Alt+M` was also
 * `editor.formulaEditor`'s `Mod+Alt+M`, and the global registration won on
 * every platform, so the formula editor's accelerator opened Quick Capture
 * instead (Linux regression run, Failure 1).
 *
 * ⌘⌥⇧M / Ctrl+Alt+Shift+M: no KEY_ACTIONS default or preset uses it
 * (keybindings.test.ts checks), and macOS, Windows, GNOME and KDE don't
 * reserve it.
 */
import { normalizeCombo, type KeyCombo } from './keybindings.ts';

export const QUICK_CAPTURE_DEFAULT_SHORTCUT = 'CmdOrCtrl+Alt+Shift+M';

/** Shipped as the default up to 4.14.10. */
export const QUICK_CAPTURE_LEGACY_SHORTCUT = 'CmdOrCtrl+Alt+M';

/**
 * The shortcut to use for a stored setting. A value still equal to the old
 * default is one the user never changed (the settings blob stores the default
 * verbatim), so it moves to the new default; anything else was the user's
 * choice and is kept as is.
 */
export function migrateQuickCaptureShortcut(stored: unknown): string {
  if (typeof stored !== 'string') return QUICK_CAPTURE_DEFAULT_SHORTCUT;
  if (stored.trim() === QUICK_CAPTURE_LEGACY_SHORTCUT) return QUICK_CAPTURE_DEFAULT_SHORTCUT;
  return stored;
}

/** Tauri accelerator (`CmdOrCtrl+Alt+M`) → the in-app combo grammar (`Mod+Alt+M`). */
export function acceleratorToCombo(accel: string): KeyCombo {
  return normalizeCombo(
    accel
      .split('+')
      .map((p) => (/^(cmdorctrl|commandorcontrol|cmdorcontrol|commandorctrl|super)$/i.test(p.trim()) ? 'Mod' : p))
      .join('+'),
  );
}
