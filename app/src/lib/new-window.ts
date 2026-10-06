import { WebviewWindow } from '@tauri-apps/api/webviewWindow';
import { windowChromeOptions } from './window-chrome-options';

/**
 * #280 — open a second SoloMD window.
 *
 * There are two ways in: the native menu (File → New Window) and the command
 * palette. They used to be separate implementations — the palette built a
 * `WebviewWindow`, while the menu dispatched a `solomd:new-window` event that
 * nothing had ever listened for, so the menu item was silently dead from the
 * day the native menu landed (47bfce1, 2026-04-08). Both entry points now call
 * this, so a working palette can no longer imply a working menu.
 *
 * Resolves once the window is created, or rejects with the reason it wasn't —
 * callers that can show a toast should.
 */
export function openNewWindow(): Promise<void> {
  return new Promise((resolve, reject) => {
    const label = `solomd-${Date.now()}`;
    let win: WebviewWindow;
    try {
      win = new WebviewWindow(label, {
        url: '/',
        title: 'SoloMD',
        width: 1000,
        height: 700,
        ...windowChromeOptions(),
      });
    } catch (e) {
      reject(e);
      return;
    }
    // `new WebviewWindow` doesn't throw when the backend refuses (a missing
    // ACL, a duplicate label); it reports through this event instead, which is
    // why a failure here looks like "nothing happened" rather than an error.
    win.once('tauri://error', (e) => reject(new Error(String(e.payload))));
    win.once('tauri://created', () => resolve());
  });
}
