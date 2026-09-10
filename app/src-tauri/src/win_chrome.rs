//! Windows frameless-window chrome support.
//!
//! The Windows build ships `decorations: false` (tauri.windows.conf.json) and
//! draws its own title-bar row inside the app toolbar (Toolbar.vue), the same
//! unified single-row layout the macOS build gets from `titleBarStyle:
//! "Overlay"`. Dragging and double-click-maximize are driven from JS via
//! `startDragging()` / `toggleMaximize()` — no native help needed.
//!
//! The one thing JS cannot do is Win11 **Snap Layouts**: the hover flyout only
//! appears over what Windows itself considers a maximize caption button.
//! VM finding (probe4b, 2026-08-06): a top-level `WM_NCHITTEST` override can
//! never claim that button by itself — the cursor lands on the cross-process
//! `Chrome_RenderWidgetHostHWND` child first, its own hit-test answers
//! HTCLIENT, and HTTRANSPARENT bubbling stops at thread boundaries. The
//! working route is WebView2's non-client region support (wry enables
//! `IsNonClientRegionSupportEnabled`): Toolbar.vue puts `app-region:
//! maximize` on the button, the runtime maps that region to HTMAXBUTTON and
//! forwards the resulting non-client messages to this top-level window,
//! where the subclass:
//!   * emits `solomd://maxbtn-hover` (bool) on hover changes so the HTML
//!     button can style itself (DOM hover no longer fires there), and
//!   * turns the click into `WM_SYSCOMMAND` maximize/restore (posted, not
//!     sent, to avoid re-entering the window proc).
//! The `set_max_button_rect` NCHITTEST override stays as a harmless backup
//! for points the webview doesn't cover.
//!
//! Only the main window is subclassed — auxiliary windows keep their maximize
//! button as a plain HTML button (no snap flyout there, JS handles the click).

#![cfg(target_os = "windows")]

use std::sync::atomic::{AtomicBool, AtomicI32, Ordering};
use tauri::Emitter;
use windows_sys::Win32::Foundation::{HWND, LPARAM, LRESULT, POINT, WPARAM};
use windows_sys::Win32::Graphics::Gdi::ScreenToClient;
use windows_sys::Win32::UI::Input::KeyboardAndMouse::{
    TrackMouseEvent, TME_LEAVE, TME_NONCLIENT, TRACKMOUSEEVENT,
};
use windows_sys::Win32::UI::Shell::{DefSubclassProc, SetWindowSubclass};
use windows_sys::Win32::UI::WindowsAndMessaging::{
    IsZoomed, PostMessageW, HTCLIENT, HTMAXBUTTON, SC_MAXIMIZE, SC_RESTORE, WM_NCHITTEST,
    WM_NCLBUTTONDOWN, WM_NCLBUTTONUP, WM_NCMOUSELEAVE, WM_NCMOUSEMOVE, WM_SYSCOMMAND,
};

// Maximize-button rect in client-area physical pixels (left/top/right/bottom).
// Written by the `set_max_button_rect` command, read by the subclass proc.
// An empty rect (right <= left) disables the HTMAXBUTTON override.
static RECT_L: AtomicI32 = AtomicI32::new(0);
static RECT_T: AtomicI32 = AtomicI32::new(0);
static RECT_R: AtomicI32 = AtomicI32::new(0);
static RECT_B: AtomicI32 = AtomicI32::new(0);

static HOVERED: AtomicBool = AtomicBool::new(false);

/// Frontend reports the maximize button's bounding box in CSS px along with
/// the effective device pixel ratio (which already folds in webview zoom).
/// Called on mount, resize, zoom change; `w <= 0` clears the region.
/// (Plain fn — the cross-platform `#[tauri::command]` wrapper lives in
/// runner.rs so the frontend can invoke it unconditionally.)
pub fn set_max_button_rect(x: f64, y: f64, w: f64, h: f64, scale: f64) {
    if w <= 0.0 || h <= 0.0 || scale <= 0.0 {
        RECT_L.store(0, Ordering::Relaxed);
        RECT_T.store(0, Ordering::Relaxed);
        RECT_R.store(0, Ordering::Relaxed);
        RECT_B.store(0, Ordering::Relaxed);
        return;
    }
    RECT_L.store((x * scale) as i32, Ordering::Relaxed);
    RECT_T.store((y * scale) as i32, Ordering::Relaxed);
    RECT_R.store(((x + w) * scale) as i32, Ordering::Relaxed);
    RECT_B.store(((y + h) * scale) as i32, Ordering::Relaxed);
}

fn in_max_button(hwnd: HWND, lparam: LPARAM) -> bool {
    let r = RECT_R.load(Ordering::Relaxed);
    let l = RECT_L.load(Ordering::Relaxed);
    if r <= l {
        return false;
    }
    // WM_NCHITTEST / WM_NCMOUSEMOVE coords are screen physical px.
    let mut pt = POINT {
        x: (lparam & 0xFFFF) as i16 as i32,
        y: ((lparam >> 16) & 0xFFFF) as i16 as i32,
    };
    if unsafe { ScreenToClient(hwnd, &mut pt) } == 0 {
        return false;
    }
    pt.x >= l
        && pt.x < r
        && pt.y >= RECT_T.load(Ordering::Relaxed)
        && pt.y < RECT_B.load(Ordering::Relaxed)
}

fn set_hover(app: &tauri::AppHandle, on: bool) {
    if HOVERED.swap(on, Ordering::Relaxed) != on {
        let _ = app.emit("solomd://maxbtn-hover", on);
    }
}

unsafe extern "system" fn subclass_proc(
    hwnd: HWND,
    msg: u32,
    wparam: WPARAM,
    lparam: LPARAM,
    _id: usize,
    ref_data: usize,
) -> LRESULT {
    let app = &*(ref_data as *const tauri::AppHandle);
    match msg {
        WM_NCHITTEST => {
            let base = DefSubclassProc(hwnd, msg, wparam, lparam);
            // Only claim the button when the point would otherwise be plain
            // client area — never shadow the resize borders tao computes.
            if base == HTCLIENT as LRESULT && in_max_button(hwnd, lparam) {
                return HTMAXBUTTON as LRESULT;
            }
            base
        }
        WM_NCMOUSEMOVE => {
            let over = wparam == HTMAXBUTTON as WPARAM;
            set_hover(app, over);
            if over {
                // WM_NCMOUSELEAVE is only delivered after opting in via
                // TrackMouseEvent(TME_NONCLIENT) — without this the hover
                // highlight sticks when the cursor exits the window sideways.
                let mut tme = TRACKMOUSEEVENT {
                    cbSize: std::mem::size_of::<TRACKMOUSEEVENT>() as u32,
                    dwFlags: TME_LEAVE | TME_NONCLIENT,
                    hwndTrack: hwnd,
                    dwHoverTime: 0,
                };
                TrackMouseEvent(&mut tme);
            }
            DefSubclassProc(hwnd, msg, wparam, lparam)
        }
        WM_NCMOUSELEAVE => {
            set_hover(app, false);
            DefSubclassProc(hwnd, msg, wparam, lparam)
        }
        WM_NCLBUTTONDOWN if wparam == HTMAXBUTTON as WPARAM => {
            // DefWindowProc does nothing useful for a synthetic caption
            // button; perform the maximize/restore ourselves. Posted so the
            // state change happens outside this proc invocation.
            let cmd = if IsZoomed(hwnd) != 0 {
                SC_RESTORE
            } else {
                SC_MAXIMIZE
            };
            PostMessageW(hwnd, WM_SYSCOMMAND, cmd as WPARAM, 0);
            0
        }
        WM_NCLBUTTONUP if wparam == HTMAXBUTTON as WPARAM => 0,
        _ => DefSubclassProc(hwnd, msg, wparam, lparam),
    }
}

/// Subclass the main window. Leaks one boxed `AppHandle` (lives for the
/// process lifetime — the subclass stays installed until the window dies).
pub fn install(win: &tauri::WebviewWindow, app: &tauri::AppHandle) {
    let Ok(hwnd) = win.hwnd() else { return };
    let ref_data = Box::into_raw(Box::new(app.clone())) as usize;
    unsafe {
        SetWindowSubclass(hwnd.0 as HWND, Some(subclass_proc), 0x501D, ref_data);
    }
}
