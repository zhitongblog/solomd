/**
 * Lightweight runtime platform detection. Synchronous (no Tauri roundtrip).
 *
 * We read the WebView user-agent because every Tauri iOS build runs under
 * WKWebView, which puts `iPad` / `iPhone` in the UA string. Desktop WebViews
 * never match, so `isIOS()` is effectively "running inside the Tauri iOS
 * binary". `isMobile()` also catches Android (future-proofing).
 */

export function isIOS(): boolean {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent || '';
  // iPadOS 13+ reports "Mac OS X" in UA; disambiguate via maxTouchPoints.
  if (/iPad|iPhone|iPod/.test(ua)) return true;
  if (/Macintosh/.test(ua) && (navigator.maxTouchPoints ?? 0) > 1) return true;
  return false;
}

export function isMobile(): boolean {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent || '';
  return isIOS() || /Android/i.test(ua);
}
