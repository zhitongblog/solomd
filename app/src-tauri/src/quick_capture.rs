//! Quick capture — a global hotkey that takes a thought without switching apps.
//!
//! The idea arrives while you are in a browser, a terminal, a chat window.
//! Bringing SoloMD forward, waiting for it to paint, finding the right folder
//! and making a note is enough friction that the thought is usually gone. This
//! is the shortest path that still ends in a real file: press the chord
//! anywhere, a small always-on-top box appears, type, press Enter, the box
//! disappears and the note is in the Inbox.
//!
//! Registration lives here rather than in the webview on purpose. A global
//! shortcut handled in JavaScript is only as reliable as the main window's
//! event loop, and macOS throttles an occluded WKWebView — precisely the state
//! the window is in whenever this feature is worth having.
//!
//! The note is written through `capture_endpoint::capture_write_inner`, the
//! same function the HTTP capture endpoint uses, so a hotkey capture and a
//! browser-extension capture produce the same file in the same place.

use tauri::{AppHandle, Emitter};
// Every window this module touches lives behind `cfg(desktop)`, so on mobile
// the window traits are not just unused — they have nothing to name.
#[cfg(desktop)]
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

// `super::` rather than `crate::`: this file is compiled twice — once as a
// top-level module of the lib, once inside `mod runner` in the binary (see the
// `#[path = ...]` declarations there). Only the relative path resolves in both.
use super::capture_endpoint::{self, capture_write_inner};

/// Fixed label so a second press focuses the existing box instead of stacking
/// windows. Matches the `solomd-*` capability pattern.
pub const CAPTURE_LABEL: &str = "solomd-quick-capture";

/// Quick capture is a desktop idea: a global chord and a floating box over
/// whatever else you are doing. Neither exists on a phone.
#[cfg(not(desktop))]
const MOBILE_UNSUPPORTED: &str = "quick capture is desktop-only";

// ---------------------------------------------------------------------------
// Window
// ---------------------------------------------------------------------------

/// Show the capture box, creating it on first use.
///
/// Deliberately small, undecorated and always-on-top: it is a prompt, not a
/// window you manage. Esc dismisses it (handled in the webview).
#[tauri::command]
pub fn quick_capture_open(app: AppHandle) -> Result<(), String> {
    #[cfg(not(desktop))]
    {
        // `show`/`set_focus` and the window builder's `title` are desktop-only
        // in Tauri 2 — and a second always-on-top window is not a thing a
        // phone has anyway. The setting is hidden on mobile; this is the
        // backstop, and it says so rather than silently reporting success.
        let _ = app;
        return Err(MOBILE_UNSUPPORTED.into());
    }
    #[cfg(desktop)]
    {
        if let Some(win) = app.get_webview_window(CAPTURE_LABEL) {
            win.show().map_err(|e| e.to_string())?;
            win.set_focus().map_err(|e| e.to_string())?;
            // The box remembers nothing between uses; tell the webview to clear.
            let _ = win.emit("solomd://quick-capture-reset", ());
            return Ok(());
        }

        let win = WebviewWindowBuilder::new(
            &app,
            CAPTURE_LABEL,
            WebviewUrl::App("index.html?quickCapture=1".into()),
        )
        .title("SoloMD — Quick Capture")
        .inner_size(560.0, 180.0)
        .resizable(false)
        .decorations(false)
        .always_on_top(true)
        .center()
        .skip_taskbar(true)
        .focused(true)
        .build()
        .map_err(|e| e.to_string())?;

        let _ = win.set_focus();
        Ok(())
    }
}

/// Hide (never destroy) the box — recreating a webview on every capture is
/// slow enough to be felt, and the whole point is that it is instant.
#[tauri::command]
pub fn quick_capture_close(app: AppHandle) -> Result<(), String> {
    #[cfg(desktop)]
    if let Some(win) = app.get_webview_window(CAPTURE_LABEL) {
        win.hide().map_err(|e| e.to_string())?;
    }
    #[cfg(not(desktop))]
    let _ = app;
    Ok(())
}

// ---------------------------------------------------------------------------
// Write
// ---------------------------------------------------------------------------

/// Write a captured note into the workspace inbox. Returns the file path.
#[tauri::command]
pub fn quick_capture_write(
    app: AppHandle,
    title: Option<String>,
    content: String,
    tags: Option<Vec<String>>,
) -> Result<String, String> {
    let trimmed = content.trim();
    if trimmed.is_empty() {
        return Err("nothing to capture".into());
    }
    let (workspace, inbox_folder) = capture_endpoint::current_target()
        .ok_or_else(|| "no workspace folder is open".to_string())?;

    // A capture is rarely a document with a heading, so the shared writer's
    // "no title → Untitled" would name every note `…-untitled.md` and make the
    // inbox unreadable at a glance. The first line is the title here.
    let derived = title.filter(|t| !t.trim().is_empty()).or_else(|| first_line_title(trimmed));

    let path = capture_write_inner(
        &workspace,
        &inbox_folder,
        derived.as_deref(),
        trimmed,
        None,
        tags.as_deref(),
        true,
        now_iso8601(),
    )
    .map_err(|e| e.to_string())?;

    // The main window's file tree is showing a directory that just gained a
    // file; without this the note is invisible until something else refreshes.
    let _ = app.emit("solomd://capture-written", path.clone());
    Ok(path)
}

/// First non-empty line, stripped of any leading markdown heading marker and
/// clipped to something that still works as a filename. `None` when the text
/// has nothing usable, which leaves the shared writer's own fallback in place.
fn first_line_title(content: &str) -> Option<String> {
    let line = content.lines().map(str::trim).find(|l| !l.is_empty())?;
    let line = line.trim_start_matches('#').trim();
    if line.is_empty() {
        return None;
    }
    // Character-wise, not byte-wise: cutting mid-codepoint would panic, and
    // 60 bytes of CJK is only 20 characters.
    let clipped: String = line.chars().take(60).collect();
    Some(clipped)
}

/// `capture_write_inner` takes the timestamp as a string so its callers decide
/// the clock; the HTTP endpoint uses the request time, we use now.
fn now_iso8601() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    // Minimal UTC formatting — no chrono dependency for one timestamp.
    let days = secs / 86_400;
    let rem = secs % 86_400;
    let (h, m, s) = (rem / 3600, (rem % 3600) / 60, rem % 60);
    let (y, mo, d) = civil_from_days(days as i64);
    format!("{y:04}-{mo:02}-{d:02}T{h:02}:{m:02}:{s:02}Z")
}

/// days-since-epoch → (year, month, day). Howard Hinnant's civil_from_days.
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

// ---------------------------------------------------------------------------
// Global shortcut (desktop only — mobile has no such concept)
// ---------------------------------------------------------------------------

#[cfg(desktop)]
static CURRENT_SHORTCUT: std::sync::Mutex<Option<String>> = std::sync::Mutex::new(None);

/// Register `accelerator` as the quick-capture hotkey, replacing whatever was
/// registered before. `None` unregisters and leaves nothing behind.
///
/// A failure here is almost always "another application already owns this
/// chord", which is a message for the user rather than a crash: the error
/// string goes back to Settings so they can pick a different one.
///
/// Defined at module level (not inside a `#[cfg]` submodule) because
/// `generate_handler!` needs the macro-generated `__cmd__` sibling to be
/// visible here — a `pub use` of a command from an inner module does not
/// re-export it.
#[tauri::command]
pub fn quick_capture_set_shortcut(
    app: AppHandle,
    accelerator: Option<String>,
) -> Result<(), String> {
    #[cfg(desktop)]
    {
        use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

        let mut current = CURRENT_SHORTCUT.lock().map_err(|e| e.to_string())?;
        if let Some(old) = current.take() {
            if let Ok(sc) = old.parse::<Shortcut>() {
                let _ = app.global_shortcut().unregister(sc);
            }
        }
        let Some(accel) = accelerator
            .map(|a| a.trim().to_string())
            .filter(|a| !a.is_empty())
        else {
            return Ok(());
        };
        let shortcut: Shortcut = accel
            .parse()
            .map_err(|e| format!("not a valid shortcut ({accel}): {e}"))?;
        let handle = app.clone();
        app.global_shortcut()
            .on_shortcut(shortcut, move |_app, _sc, event| {
                // Fire on press, not release — releasing after the window has
                // taken focus would open it a second time.
                if event.state() != ShortcutState::Pressed {
                    return;
                }
                // Pressing the chord while the box is already up means "put it
                // away", same as Esc. Without this the hotkey feels stuck when
                // it lands on an already-open box.
                if let Some(win) = handle.get_webview_window(CAPTURE_LABEL) {
                    if win.is_visible().unwrap_or(false) {
                        let _ = win.hide();
                        return;
                    }
                }
                if let Err(e) = quick_capture_open(handle.clone()) {
                    eprintln!("[quick_capture] open failed: {e}");
                }
            })
            .map_err(|e| format!("could not register {accel}: {e}"))?;
        *current = Some(accel);
        Ok(())
    }
    #[cfg(not(desktop))]
    {
        let _ = (app, accelerator);
        Err("global shortcuts are desktop-only".into())
    }
}
