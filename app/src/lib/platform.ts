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
 * True when the Rust side actually exposes the libgit2-backed commands.
 *
 * #230 — `git2` is gated to `cfg(not(target_os = "android"))` in Cargo.toml
 * (vendored OpenSSL doesn't cross-compile into the Android NDK build), so the
 * whole `github_sync` / `git_history` / `recipe_runner` command surface is
 * compiled out of the Android binary. The frontend used to render those panels
 * anyway and every call came back as `Command github_has_token not found`.
 *
 * Anything that invokes one of those commands must check this first.
 *
 * `?forceNoGit` is a dev-only QA hook (same idea as `?forcePlain` /
 * `?forceWinChrome`) so the Android degradation can be driven from a desktop
 * dev build instead of needing an APK on a device.
 */
export function hasGitBackend(): boolean {
  if (typeof location !== 'undefined' && location.search.includes('forceNoGit')) {
    return false;
  }
  return !isAndroid();
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

/**
 * True on a Windows desktop WebView — gates the frameless unified title bar
 * (custom window controls + in-app menubar in Toolbar.vue). The Windows build
 * ships `decorations: false` (tauri.windows.conf.json), so this must match
 * exactly the builds that are actually frameless: real Windows, desktop only.
 *
 * `?forceWinChrome` is a dev-only QA hook (same idea as `?forcePlain`) to
 * preview the Windows toolbar layout in the macOS dev build — it renders the
 * menubar + caption buttons but the window itself keeps its platform chrome.
 */
export function isWindowsDesktop(): boolean {
  if (typeof navigator === 'undefined') return false;
  if (isMobile()) return false;
  return /Windows NT/.test(navigator.userAgent || '');
}

export function forceWinChromePreview(): boolean {
  return typeof location !== 'undefined' && location.search.includes('forceWinChrome');
}

/**
 * `?forceKeyboardBar` — dev-only QA hook (same idea as `?forcePlain` /
 * `?forceWinChrome`) that mounts the touch formatting bar (KeyboardBar.vue)
 * in a desktop browser and treats the software keyboard as open, so the bar
 * can be driven without a phone. Compiled out of production builds.
 */
export function forceKeyboardBarPreview(): boolean {
  // `?.` — node's test runner has no import.meta.env.
  const dev = !!import.meta.env?.DEV;
  return dev && typeof location !== 'undefined' && location.search.includes('forceKeyboardBar');
}

/** Windows desktop editor detection, including the forcePlain QA hook. */
export function isWindowsEditorRuntime(): boolean {
  return (
    (typeof navigator !== 'undefined' && /Win/i.test(navigator.platform)) ||
    (typeof location !== 'undefined' && location.search.includes('forcePlain'))
  );
}

/** Which editor Windows uses: the native textarea, CodeMirror (#328, #344),
 *  or `auto` — CodeMirror on WebView2 154+, the textarea below that. */
export type WindowsEditorEngine = 'auto' | 'native' | 'codemirror';

/**
 * First WebView2 major version on which CodeMirror is the default on Windows.
 * The native textarea exists because CodeMirror dropped or doubled characters
 * under IMEs in WebView2 (WebView2Feedback#5625), a Chromium-side defect that
 * is gone in 154. Below it the textarea stays the safe default.
 *
 * Evidence (Win11-ARM VM, WebView2 154.0.4258.53, real keystrokes through the
 * IME): Microsoft Pinyin clean (2026-10-05); Sogou Pinyin 14/14 clean on
 * 2026-10-06 — steady state, typing 3 s after launch, and right after a cold
 * boot, incl. inserting mid-paragraph. Sogou drops seen on 10-05 (4/5 runs)
 * could not be reproduced the next day on either that build or a newer one.
 */
export const CODEMIRROR_SAFE_WEBVIEW2_MAJOR = 154;

/** The webview version main.ts read at startup (Windows only), or null. */
export function currentWebviewVersion(): string | null {
  if (typeof window === 'undefined') return null;
  const v = (window as unknown as { __SOLOMD_WEBVIEW_VERSION__?: unknown }).__SOLOMD_WEBVIEW_VERSION__;
  return typeof v === 'string' && v ? v : null;
}

/** What `auto` means for this webview: CodeMirror from WebView2 154 on,
 *  otherwise (older, or the version could not be read) the native textarea. */
export function resolveWindowsEditorEngine(
  engine: WindowsEditorEngine,
  webviewVersion: string | null = currentWebviewVersion(),
): 'native' | 'codemirror' {
  if (engine !== 'auto') return engine;
  const major = Number.parseInt((webviewVersion ?? '').split('.')[0], 10);
  return Number.isFinite(major) && major >= CODEMIRROR_SAFE_WEBVIEW2_MAJOR ? 'codemirror' : 'native';
}

/**
 * Windows may use the native textarea for reliable CJK IME input on older
 * WebView2, but Vim is a CodeMirror extension and therefore requires the
 * CodeMirror editor. The user can also pick an engine outright (Settings →
 * Editor engine). Keep this decision pure so the Windows hand-off can be
 * regression tested without booting a platform WebView.
 */
export function shouldUsePlainWindowsEditor(
  windowsRuntime: boolean,
  vimMode: boolean,
  engine: WindowsEditorEngine = 'auto',
  webviewVersion: string | null = currentWebviewVersion(),
): boolean {
  // DEV-only QA hook, the counterpart of `?forcePlain`: a plain browser on
  // Windows has no WebView2 version to read, so `auto` would always pick the
  // textarea there. `?forceCodeMirror` lets the IME harness test CodeMirror.
  if (import.meta.env?.DEV && typeof location !== 'undefined' && location.search.includes('forceCodeMirror')) {
    return false;
  }
  return windowsRuntime && !vimMode && resolveWindowsEditorEngine(engine, webviewVersion) === 'native';
}

/**
 * Which keyboard convention modal dialogs follow (#357).
 *
 * macOS: Return = default button, Esc / ⌘. = Cancel, ⌘D = Don’t Save, ⌘S =
 * Save, and no access-key decoration on the labels. Everywhere else (Windows /
 * Linux): underlined access keys, Alt+letter or the bare letter while the
 * dialog has focus, Enter activates the focused button.
 *
 * `?forceDialogKeys=win` / `?forceDialogKeys=mac` is a dev-only QA hook (same
 * idea as `?forcePlain` / `?forceWinChrome`) so both conventions can be driven
 * from one dev build. `?forceWinChrome` implies the Windows convention too.
 */
export function usesMacDialogKeys(): boolean {
  if (typeof location !== 'undefined') {
    const q = location.search;
    if (q.includes('forceDialogKeys=mac')) return true;
    if (q.includes('forceDialogKeys=win') || q.includes('forceWinChrome')) return false;
  }
  return isMacOS() || isIOS();
}
