import { forceWinChromePreview, isMacOS, isWindowsDesktop } from './platform';

/**
 * Which window chrome this window draws (docs/v5-ui-spec.md §3). Computed once:
 * the platform does not change at runtime.
 *
 * macOS — `titleBarStyle: "Overlay"`: the traffic lights float over our own
 * 52px header line. With the sidebar open they sit in its top inset; with it
 * hidden, the header reserves room for them.
 *
 * Windows — the build is frameless (`decorations: false`), so we draw a 44px
 * title bar with the in-app menus and the caption buttons above the header.
 * `?forceWinChrome` previews it in a dev build on any OS.
 */
const winPreview = import.meta.env.DEV && forceWinChromePreview();
const hasTauriShell = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

export const macTitleBar = isMacOS() && !winPreview;
export const winTitleBar = (isWindowsDesktop() && hasTauriShell) || winPreview;
export const customTitleBar = macTitleBar || winTitleBar;
