//! What kind of window a label names, for the window-lifecycle code in
//! `runner.rs` (close interception, quitting, single-instance relaunch).
//!
//! Compiled twice, like `quick_capture.rs`: as a lib module (so `cargo test
//! --lib` covers it) and through `#[path]` inside the binary's `runner`.

/// The window tauri.conf.json creates at startup.
pub const MAIN_LABEL: &str = "main";

/// Kept in step with `quick_capture::CAPTURE_LABEL`; spelled out here so this
/// module has no dependencies (a test below pins the two together).
const QUICK_CAPTURE_LABEL: &str = "solomd-quick-capture";

/// Slideshow windows: `solomd-slideshow-<ts>` (useCommands.ts).
const SLIDESHOW_PREFIX: &str = "solomd-slideshow-";

/// Windows that hold documents the user can edit: the main window, "New
/// Window" (`solomd-<ts>`, lib/new-window.ts) and "open in new window"
/// (`solomd-window-<N>`, stores/windows.ts). Each runs the full editor, so
/// closing one must give its frontend the chance to keep unsaved edits.
///
/// The quick-capture box and slideshows are views with nothing to lose; they
/// close straight away.
pub fn is_editor_window(label: &str) -> bool {
    if label == MAIN_LABEL {
        return true;
    }
    label.starts_with("solomd-")
        && label != QUICK_CAPTURE_LABEL
        && !label.starts_with(SLIDESHOW_PREFIX)
}

/// Windows that only exist alongside the main one and must not outlive it.
/// A hidden quick-capture box kept the process alive after the main window
/// was closed, and a relaunch then handed off (single-instance) to a process
/// with no window to show.
pub fn closes_with_main(label: &str) -> bool {
    label == QUICK_CAPTURE_LABEL || label.starts_with(SLIDESHOW_PREFIX)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn editor_windows_are_main_and_both_kinds_of_second_window() {
        assert!(is_editor_window("main"));
        assert!(is_editor_window("solomd-1791460394123"));
        assert!(is_editor_window("solomd-window-3"));
    }

    #[test]
    fn capture_and_slideshow_are_not_editor_windows() {
        assert!(!is_editor_window(QUICK_CAPTURE_LABEL));
        assert!(!is_editor_window("solomd-slideshow-1791460394123"));
        assert!(!is_editor_window("something-else"));
    }

    #[test]
    fn capture_and_slideshow_close_with_main() {
        assert!(closes_with_main(QUICK_CAPTURE_LABEL));
        assert!(closes_with_main("solomd-slideshow-1"));
        assert!(!closes_with_main("main"));
        assert!(!closes_with_main("solomd-window-1"));
        assert!(!closes_with_main("solomd-123"));
    }

    #[test]
    fn capture_label_matches_the_quick_capture_module() {
        // `super::super`, not `crate::`: in the binary this module sits inside
        // `runner`, next to its own `quick_capture`.
        assert_eq!(QUICK_CAPTURE_LABEL, super::super::quick_capture::CAPTURE_LABEL);
    }
}
