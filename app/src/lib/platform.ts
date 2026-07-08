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

export function isAndroid(): boolean {
  if (typeof navigator === 'undefined') return false;
  return /Android/i.test(navigator.userAgent || '');
}

/**
 * True when running on a macOS desktop WebView (not iOS / iPadOS).
 *
 * We only want this to gate the unified-titlebar treatment: on macOS the
 * window uses `titleBarStyle: "Overlay"` (tauri.conf) which floats the
 * traffic-light buttons over our toolbar, so the toolbar must reserve ~72px
 * of left padding for them and become a `data-tauri-drag-region`. Windows /
 * Linux keep native decorations and must NOT get that padding; iOS has no
 * window chrome at all. WKWebView on iPad reports "Macintosh" in its UA, so
 * we explicitly exclude the touch-capable iOS case via `isIOS()`.
 */
export function isMacOS(): boolean {
  if (typeof navigator === 'undefined') return false;
  if (isIOS()) return false;
  const ua = navigator.userAgent || '';
  return /Macintosh|Mac OS X/.test(ua);
}

export function isMobile(): boolean {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent || '';
  return isIOS() || /Android/i.test(ua);
}
