//! WebView2 memory trim while a window is minimized (Windows only).
//!
//! A tester measured SoloMD at ~400 MB on Windows (bug/, 2026-10-07). Most of
//! that is the WebView2 runtime's own browser / GPU / utility processes —
//! the same six processes Windows' own SearchHost runs — and cannot be
//! trimmed from here. What can is the renderer, and WebView2 does not shrink
//! it on its own: measured in the VM, a minimized window kept 75 of its
//! 83 MB private after 20 s.
//!
//! `MemoryUsageTargetLevel::Low` (ICoreWebView2_19) tells the runtime the
//! page is in the background, so it may drop caches and compact the heap.
//! It is set on the minimize transition only and put back to Normal on
//! restore — while visible the page must stay as responsive as it was.

use std::collections::HashSet;
use std::sync::Mutex;

use tauri::{AppHandle, Manager, Runtime};
use webview2_com::Microsoft::Web::WebView2::Win32::{
    ICoreWebView2_19, COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_LOW,
    COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_NORMAL,
};
use windows_core::Interface;

/// Labels of the windows currently trimmed, so a resize storm (every
/// `Resized` while dragging a border) is not a COM call each time.
static TRIMMED: Mutex<Option<HashSet<String>>> = Mutex::new(None);

/// Call on every `WindowEvent::Resized` — that is the event a minimize and a
/// restore both raise.
pub fn on_resized<R: Runtime>(app: &AppHandle<R>, label: &str) {
    let Some(win) = app.get_webview_window(label) else { return };
    let minimized = win.is_minimized().unwrap_or(false);
    {
        let mut guard = TRIMMED.lock().unwrap_or_else(|e| e.into_inner());
        let set = guard.get_or_insert_with(HashSet::new);
        let was = set.contains(label);
        if was == minimized {
            return;
        }
        if minimized {
            set.insert(label.to_string());
        } else {
            set.remove(label);
        }
    }
    let level = if minimized {
        COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_LOW
    } else {
        COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_NORMAL
    };
    let _ = win.with_webview(move |platform| unsafe {
        let Ok(core) = platform.controller().CoreWebView2() else { return };
        // Runtimes older than 1.0.2210 lack the interface: nothing to do.
        if let Ok(core19) = core.cast::<ICoreWebView2_19>() {
            let _ = core19.SetMemoryUsageTargetLevel(level);
        }
    });
}
