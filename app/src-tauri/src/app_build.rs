//! Build-time gate for App Store distributions.
//!
//! Apple rejected macOS 1.0.3 under Guideline 3.1.1 — the AI / Agent surface
//! lets users paste OpenAI / Anthropic / DeepSeek / etc. API keys to unlock
//! paid functionality, which Apple treats as "unlocking content without
//! In-App Purchase". MAS and iOS App Store builds therefore strip the AI
//! surface entirely; the GitHub Developer ID build keeps it.
//!
//! How it works:
//!   - `scripts/build-mas.sh` and `scripts/build-ios.sh` export
//!     `SOLOMD_APP_STORE_BUILD=1` before invoking `pnpm tauri build`.
//!   - `option_env!` reads the value at compile time, so the result is a
//!     `const bool` and the dead-code arms get optimised out.
//!   - Every AI / Agent / Recipe Tauri command early-returns Err when this
//!     is true (defence in depth — the UI hides them too).
//!   - Frontend asks via `app_build_info` at startup and toggles the AI UI.

// `option_env!` returns `Option<&'static str>` at compile time. Any non-`None`
// value flips this to true — the build scripts only export the variable when
// they actually want the App Store gate, so a stray `=0` setting in someone's
// shell shouldn't happen in practice.
pub const IS_APP_STORE: bool = option_env!("SOLOMD_APP_STORE_BUILD").is_some();

#[derive(serde::Serialize)]
pub struct BuildInfo {
    pub is_app_store: bool,
}

#[tauri::command]
pub fn app_build_info() -> BuildInfo {
    BuildInfo { is_app_store: IS_APP_STORE }
}

pub fn app_store_disabled<T>() -> Result<T, String> {
    Err("This feature is not available in the App Store edition. Download the GitHub release for the full SoloMD experience.".to_string())
}
