use objc2::{
    msg_send,
    runtime::{AnyObject, Bool},
    sel,
};
use objc2_foundation::NSRect;
use std::ptr;
use tokio::sync::oneshot;

// Matches --header-h in tokens.css, in CSS pixels before WebKit page zoom.
const HEADER_HEIGHT: f64 = 52.0;
const TRAFFIC_LIGHT_LEFT: f64 = 20.0;
const FULL_SCREEN_STYLE: usize = 1 << 14;

pub fn align(
    window: &tauri::WebviewWindow,
    right_edge: Option<oneshot::Sender<f64>>,
) -> tauri::Result<()> {
    // Tauri supplies the live AppKit and WebKit objects on the main thread.
    window.with_webview(move |platform| unsafe {
        let window = platform.ns_window().cast::<AnyObject>();
        let webview = platform.inner().cast::<AnyObject>();
        let style: usize = msg_send![window, styleMask];
        if style & FULL_SCREEN_STYLE != 0 {
            return;
        }

        // WKWebView.pageZoom is available starting in macOS 11.
        let has_page_zoom: Bool = msg_send![webview, respondsToSelector: sel!(pageZoom)];
        let zoom: f64 = if has_page_zoom.as_bool() {
            msg_send![webview, pageZoom]
        } else {
            1.0
        };

        let close: *mut AnyObject = msg_send![window, standardWindowButton: 0usize];
        if close.is_null() {
            return;
        }
        let button_bar: *mut AnyObject = msg_send![close, superview];
        if button_bar.is_null() {
            return;
        }
        let title_bar: *mut AnyObject = msg_send![button_bar, superview];
        if title_bar.is_null() {
            return;
        }

        let close_in_window = button_frame_in_window(close);
        let window_frame: NSRect = msg_send![window, frame];
        let current_center = window_frame.size.height
            - (close_in_window.origin.y + close_in_window.size.height / 2.0);

        // Measure the rendered button center because AppKit title bar styles
        // use different offsets inside the native drag region.
        let y_offset = HEADER_HEIGHT * zoom / 2.0 - current_center;
        if y_offset.abs() >= 0.25 {
            let mut frame: NSRect = msg_send![title_bar, frame];
            frame.origin.y -= y_offset;
            frame.size.height += y_offset;
            let _: () = msg_send![title_bar, setFrame: frame];
        }

        let close_frame: NSRect = msg_send![close, frame];
        let x_offset = TRAFFIC_LIGHT_LEFT - close_frame.origin.x;
        if x_offset.abs() >= 0.25 {
            // NSWindowButton indices for close, minimize and zoom.
            for kind in 0..=2usize {
                let button: *mut AnyObject = msg_send![window, standardWindowButton: kind];
                if !button.is_null() {
                    let mut frame: NSRect = msg_send![button, frame];
                    frame.origin.x += x_offset;
                    let _: () = msg_send![button, setFrameOrigin: frame.origin];
                }
            }
        }

        if let Some(right_edge) = right_edge {
            let zoom_button: *mut AnyObject = msg_send![window, standardWindowButton: 2usize];
            if !zoom_button.is_null() {
                let frame = button_frame_in_window(zoom_button);
                let _ = right_edge.send(frame.origin.x + frame.size.width);
            }
        }
    })
}

unsafe fn button_frame_in_window(button: *mut AnyObject) -> NSRect {
    let bounds: NSRect = msg_send![button, bounds];
    msg_send![button, convertRect: bounds, toView: ptr::null::<AnyObject>()]
}
