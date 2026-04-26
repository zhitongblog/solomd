/**
 * Ambient type declaration for `webextension-polyfill`.
 *
 * The 0.12.0 release of webextension-polyfill doesn't ship its own .d.ts.
 * At runtime, the default export is the same `browser` object that Firefox
 * exposes globally — typed by the `@types/firefox-webext-browser` package
 * via the global `browser` namespace.
 *
 * Re-typing via `typeof browser` is enough: every nested namespace
 * (browser.tabs.Tab, browser.runtime.MessageSender, etc.) remains
 * accessible via the global declaration.
 */
declare module 'webextension-polyfill' {
  const value: typeof browser;
  export default value;
}
