#[path = "commands.rs"]
mod commands;

#[path = "image_upload.rs"]
mod image_upload;

#[path = "search.rs"]
mod search;

#[path = "set_default.rs"]
mod set_default;

#[path = "convert.rs"]
mod convert;

#[path = "workspace_index.rs"]
mod workspace_index;

#[path = "spellcheck.rs"]
mod spellcheck;

// #102 — AI key storage abstraction; declared before ai_proxy which uses it.
#[path = "ai_keystore.rs"]
mod ai_keystore;

#[path = "ai_proxy.rs"]
mod ai_proxy;

#[path = "pandoc.rs"]
mod pandoc;

#[path = "git_history.rs"]
mod git_history;

// v2.4 inbound HTTP capture endpoint — production-grade, opt-in via Settings.
#[path = "capture_endpoint.rs"]
mod capture_endpoint;

// v4.0 — public REST API mirroring the agent_tools surface for non-MCP
// clients. Declared in both lib.rs and runner.rs so the binary's compile
// root resolves `crate::rest_api` the same way the lib does.
#[path = "rest_api.rs"]
mod rest_api;
// v4.0 — BYOK cost meter. Same dual-declaration as rest_api: agent_run
// references `crate::cost_meter::record`, which must resolve in both
// the lib (for tests) and the bin (for live recipe + chat finishes).
#[path = "cost_meter.rs"]
mod cost_meter;

// v2.5 community theme marketplace — see app/src-tauri/src/themes.rs.
#[path = "themes.rs"]
mod themes;

// v2.5 CJK proofread — flags common Chinese typos with one-click fixes.
#[path = "cjk_proofread.rs"]
mod cjk_proofread;

// v2.6 GitHub-backed sync — push/pull a workspace to a user-owned GitHub repo.
#[path = "github_sync.rs"]
mod github_sync;

// v2.6.1 cloud-folder detection + cross-device session restore.
#[path = "cloud_folder.rs"]
mod cloud_folder;

// v2.6.3 workspace-level E2EE.
#[path = "crypto.rs"]
mod crypto;

// v2.3 dev WebDriver bridge — debug builds only. Module file itself is
// `#[cfg(debug_assertions)]`-gated, so this `mod` line is too.
#[cfg(debug_assertions)]
#[path = "dev_bridge.rs"]
mod dev_bridge;

#[path = "watcher.rs"]
mod watcher;

// v4.0 Pillar 1 — agent tool registry + run-dir persistence.
#[path = "agent_run.rs"]
mod agent_run;
#[path = "agent_tools.rs"]
mod agent_tools;
// v4.0 — provider pricing table for cost estimates.
#[path = "pricing.rs"]
mod pricing;
// v4.0 Pillar 3 — canonical trace emitter + reader + Tauri wrappers.
#[path = "trace.rs"]
mod trace;
#[path = "agent_trace.rs"]
mod agent_trace;
// v4.0 Pillar 5 — Ollama polish (detect / pull / install-page).
#[path = "ollama.rs"]
mod ollama;
// v4.0 Pillar 4 — MCP federation profile storage.
#[path = "mcp_profiles.rs"]
mod mcp_profiles;
// v4.0 Pillar 2 — Agent Recipes. Declared here in addition to lib.rs so
// the desktop binary (driven from `main.rs` → `runner.rs`) picks them
// up. `commands.rs` and `git_history.rs` reference
// `crate::recipe_runner::*`, which must resolve in both compilation
// roots (the lib AND the bin).
#[path = "recipes.rs"]
mod recipes;
#[path = "recipe_runner.rs"]
mod recipe_runner;
// v4.0 — bundled recipe cookbook (10+ ready-to-edit YAML templates).
#[path = "cookbook.rs"]
mod cookbook;

// v2.4 — integrations panel (CLI status, MCP path, AI-client config
// discovery) + v4.4.5 MCP auto-install (detect_ai_clients / inject_mcp /
// remove_mcp). Was historically only declared in lib.rs (the mobile entry
// point), so the desktop binary's frontend couldn't reach any of the
// commands. Adding the path here too is the same dual-declaration trick
// recipe_runner and rest_api use to live in both compilation roots.
#[path = "integrations.rs"]
mod integrations;

// v2.3 RAG / semantic search. Same dual-declaration pattern — surfaced
// as bug #94 ("Command rag_reindex not found"): the rag::* commands
// were only in lib.rs, so the desktop Settings → Integrations →
// "Re-index now" button always hit a "command not found" wall.
#[path = "rag.rs"]
mod rag;

// v4.1 — About-dialog build-info command. Same dual-declaration gap as
// rag — registered in lib.rs only, missing from the desktop runner,
// so the About panel's build details fell back silently on desktop.
#[path = "app_build.rs"]
mod app_build;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use tauri::menu::{
    AboutMetadata, MenuBuilder, MenuItemBuilder, PredefinedMenuItem, SubmenuBuilder,
};
use tauri::{Emitter, Manager, RunEvent};

/// Tell macOS AppKit to use the given language for native dialogs
/// (NSSavePanel/NSOpenPanel). Reads from a small preference file so the
/// setting survives across launches without needing Tauri state.
#[cfg(target_os = "macos")]
fn apply_macos_language(lang: &str) {
    use objc2::rc::autoreleasepool;
    use objc2_foundation::{NSArray, NSString, NSUserDefaults};

    let apple_lang = if lang == "zh" { "zh-Hans" } else { "en" };
    autoreleasepool(|_| unsafe {
        let defaults = NSUserDefaults::standardUserDefaults();
        let code = NSString::from_str(apple_lang);
        let arr = NSArray::from_vec(vec![code]);
        defaults.setObject_forKey(Some(&*arr), &*NSString::from_str("AppleLanguages"));
    });
}

#[cfg(not(target_os = "macos"))]
fn apply_macos_language(_lang: &str) {}

fn read_saved_language() -> String {
    // Frontend writes this file whenever the user changes Settings → Language.
    // Read at startup so system dialogs can use the right locale.
    let path = dirs_path();
    std::fs::read_to_string(&path)
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| s == "en" || s == "zh")
        .unwrap_or_else(|| "en".to_string())
}

fn dirs_path() -> std::path::PathBuf {
    let mut p = dirs_home().unwrap_or_else(std::env::temp_dir);
    p.push(".solomd-language");
    p
}

fn dirs_home() -> Option<std::path::PathBuf> {
    std::env::var_os("HOME")
        .map(std::path::PathBuf::from)
        .or_else(|| std::env::var_os("USERPROFILE").map(std::path::PathBuf::from))
}

#[tauri::command]
fn save_language_preference(lang: String) -> Result<(), String> {
    let path = dirs_path();
    std::fs::write(&path, lang.trim()).map_err(|e| e.to_string())
}

/// Set to true by `force_close_window` command after the frontend confirms close.
static FORCE_CLOSE: AtomicBool = AtomicBool::new(false);

/// Frontend calls this after user confirms "Discard & Close".
#[tauri::command]
fn force_close_window(window: tauri::Window) {
    FORCE_CLOSE.store(true, Ordering::Relaxed);
    window.close().ok();
}

/// Localized menu strings. Two languages for now: "en" and "zh".
struct MenuStrings {
    file: &'static str,
    edit: &'static str,
    view: &'static str,
    help: &'static str,
    new_md: &'static str,
    new_txt: &'static str,
    open_file: &'static str,
    open_folder: &'static str,
    save: &'static str,
    save_as: &'static str,
    print_item: &'static str,
    close_tab: &'static str,
    new_window: &'static str,
    open_external: &'static str,
    toggle_theme: &'static str,
    toggle_sidebar: &'static str,
    toggle_outline: &'static str,
    cycle_view: &'static str,
    // v4.3.0 PR #74 — 3-axis zoom (UI / Editor / Preview).
    ui_zoom_in: &'static str,
    ui_zoom_out: &'static str,
    ui_zoom_reset: &'static str,
    editor_zoom_in: &'static str,
    editor_zoom_out: &'static str,
    editor_zoom_reset: &'static str,
    preview_zoom_in: &'static str,
    preview_zoom_out: &'static str,
    preview_zoom_reset: &'static str,
    palette: &'static str,
    global_search: &'static str,
    settings_menu: &'static str,
    md_help: &'static str,
    about: &'static str,
}

fn strings_for(lang: &str) -> MenuStrings {
    if lang == "zh" {
        MenuStrings {
            file: "文件",
            edit: "编辑",
            view: "视图",
            help: "帮助",
            new_md: "新建 Markdown",
            new_txt: "新建纯文本",
            open_file: "打开文件…",
            open_folder: "打开文件夹…",
            save: "保存",
            save_as: "另存为…",
            print_item: "打印…",
            close_tab: "关闭标签页",
            new_window: "新建窗口",
            open_external: "用外部编辑器打开",
            toggle_theme: "切换主题",
            toggle_sidebar: "切换文件树",
            toggle_outline: "切换大纲",
            cycle_view: "切换视图模式 (编辑/分栏/预览)",
            ui_zoom_in: "整体界面：放大",
            ui_zoom_out: "整体界面：缩小",
            ui_zoom_reset: "整体界面：复位",
            editor_zoom_in: "编辑器：放大字号",
            editor_zoom_out: "编辑器：缩小字号",
            editor_zoom_reset: "编辑器：复位字号",
            preview_zoom_in: "预览：放大字号",
            preview_zoom_out: "预览：缩小字号",
            preview_zoom_reset: "预览：复位字号",
            palette: "命令面板",
            global_search: "在文件夹中搜索…",
            settings_menu: "设置…",
            md_help: "Markdown 速查",
            about: "关于 SoloMD",
        }
    } else {
        MenuStrings {
            file: "File",
            edit: "Edit",
            view: "View",
            help: "Help",
            new_md: "New Markdown",
            new_txt: "New Plain Text",
            open_file: "Open File…",
            open_folder: "Open Folder…",
            save: "Save",
            save_as: "Save As…",
            print_item: "Print…",
            close_tab: "Close Tab",
            new_window: "New Window",
            open_external: "Open in External Editor",
            toggle_theme: "Toggle Theme",
            toggle_sidebar: "Toggle File Tree",
            toggle_outline: "Toggle Outline",
            cycle_view: "Cycle Edit/Split/Preview",
            ui_zoom_in: "UI: Zoom In",
            ui_zoom_out: "UI: Zoom Out",
            ui_zoom_reset: "UI: Reset Zoom",
            editor_zoom_in: "Editor: Zoom In",
            editor_zoom_out: "Editor: Zoom Out",
            editor_zoom_reset: "Editor: Reset Zoom",
            preview_zoom_in: "Preview: Zoom In",
            preview_zoom_out: "Preview: Zoom Out",
            preview_zoom_reset: "Preview: Reset Zoom",
            palette: "Command Palette",
            global_search: "Search in Folder…",
            settings_menu: "Settings…",
            md_help: "Markdown Cheatsheet",
            about: "About SoloMD",
        }
    }
}

fn build_app_menu<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    lang: &str,
) -> tauri::Result<tauri::menu::Menu<R>> {
    let s = strings_for(lang);

    let new_md = MenuItemBuilder::with_id("file.new", s.new_md)
        .accelerator("CmdOrCtrl+N")
        .build(app)?;
    let new_txt = MenuItemBuilder::with_id("file.newText", s.new_txt)
        .accelerator("CmdOrCtrl+Alt+N")
        .build(app)?;
    let open_file = MenuItemBuilder::with_id("file.open", s.open_file)
        .accelerator("CmdOrCtrl+O")
        .build(app)?;
    let open_folder = MenuItemBuilder::with_id("file.openFolder", s.open_folder).build(app)?;
    let save = MenuItemBuilder::with_id("file.save", s.save)
        .accelerator("CmdOrCtrl+S")
        .build(app)?;
    let save_as = MenuItemBuilder::with_id("file.saveAs", s.save_as)
        .accelerator("CmdOrCtrl+Shift+S")
        .build(app)?;
    let print_item = MenuItemBuilder::with_id("file.print", s.print_item)
        .accelerator("CmdOrCtrl+P")
        .build(app)?;
    let close_tab = MenuItemBuilder::with_id("file.closeTab", s.close_tab)
        .accelerator("CmdOrCtrl+W")
        .build(app)?;
    let new_window = MenuItemBuilder::with_id("window.new", s.new_window)
        .accelerator("CmdOrCtrl+Shift+N")
        .build(app)?;
    let open_external = MenuItemBuilder::with_id("file.openExternal", s.open_external)
        .accelerator("CmdOrCtrl+Shift+E")
        .build(app)?;

    let file_submenu = SubmenuBuilder::new(app, s.file)
        .item(&new_md)
        .item(&new_txt)
        .separator()
        .item(&open_file)
        .item(&open_folder)
        .separator()
        .item(&save)
        .item(&save_as)
        .separator()
        .item(&open_external)
        .separator()
        .item(&print_item)
        .separator()
        .item(&new_window)
        .item(&close_tab)
        .build()?;

    let edit_submenu = SubmenuBuilder::new(app, s.edit)
        .undo()
        .redo()
        .separator()
        .cut()
        .copy()
        .paste()
        .select_all()
        .build()?;

    let toggle_theme = MenuItemBuilder::with_id("view.toggleTheme", s.toggle_theme).build(app)?;
    let toggle_sidebar = MenuItemBuilder::with_id("view.toggleFileTree", s.toggle_sidebar)
        .accelerator("CmdOrCtrl+B")
        .build(app)?;
    let toggle_outline = MenuItemBuilder::with_id("view.toggleOutline", s.toggle_outline)
        .accelerator("CmdOrCtrl+Shift+O")
        .build(app)?;
    let cycle_view = MenuItemBuilder::with_id("view.cycleView", s.cycle_view)
        .accelerator("CmdOrCtrl+Shift+P")
        .build(app)?;
    // v4.3.0 PR #74 — three independent zoom axes wired through native
    // menu accelerators (more reliable than JS keyboard handlers on macOS,
    // which the WKWebView can sometimes intercept). Action ids are
    // dispatched in App.vue's `dispatchMenuAction`.
    let ui_zoom_in = MenuItemBuilder::with_id("view.zoomUiIn", s.ui_zoom_in)
        .accelerator("CmdOrCtrl+=")
        .build(app)?;
    let ui_zoom_out = MenuItemBuilder::with_id("view.zoomUiOut", s.ui_zoom_out)
        .accelerator("CmdOrCtrl+-")
        .build(app)?;
    let ui_zoom_reset = MenuItemBuilder::with_id("view.zoomUiReset", s.ui_zoom_reset)
        .accelerator("CmdOrCtrl+0")
        .build(app)?;
    let editor_zoom_in = MenuItemBuilder::with_id("view.zoomEditorIn", s.editor_zoom_in)
        .accelerator("CmdOrCtrl+Shift+=")
        .build(app)?;
    let editor_zoom_out = MenuItemBuilder::with_id("view.zoomEditorOut", s.editor_zoom_out)
        .accelerator("CmdOrCtrl+Shift+-")
        .build(app)?;
    let editor_zoom_reset = MenuItemBuilder::with_id("view.zoomEditorReset", s.editor_zoom_reset)
        .accelerator("CmdOrCtrl+Shift+0")
        .build(app)?;
    let preview_zoom_in = MenuItemBuilder::with_id("view.zoomPreviewIn", s.preview_zoom_in)
        .accelerator("CmdOrCtrl+Control+=")
        .build(app)?;
    let preview_zoom_out = MenuItemBuilder::with_id("view.zoomPreviewOut", s.preview_zoom_out)
        .accelerator("CmdOrCtrl+Control+-")
        .build(app)?;
    let preview_zoom_reset = MenuItemBuilder::with_id("view.zoomPreviewReset", s.preview_zoom_reset)
        .accelerator("CmdOrCtrl+Control+0")
        .build(app)?;
    let palette = MenuItemBuilder::with_id("view.cmdPalette", s.palette)
        .accelerator("CmdOrCtrl+Shift+K")
        .build(app)?;
    let global_search = MenuItemBuilder::with_id("search.global", s.global_search)
        .accelerator("CmdOrCtrl+Shift+F")
        .build(app)?;
    let settings_item = MenuItemBuilder::with_id("view.settings", s.settings_menu)
        .accelerator("CmdOrCtrl+,")
        .build(app)?;

    let view_submenu = SubmenuBuilder::new(app, s.view)
        .item(&toggle_theme)
        .separator()
        .item(&toggle_sidebar)
        .item(&toggle_outline)
        .item(&cycle_view)
        .separator()
        .item(&ui_zoom_in)
        .item(&ui_zoom_out)
        .item(&ui_zoom_reset)
        .separator()
        .item(&editor_zoom_in)
        .item(&editor_zoom_out)
        .item(&editor_zoom_reset)
        .separator()
        .item(&preview_zoom_in)
        .item(&preview_zoom_out)
        .item(&preview_zoom_reset)
        .separator()
        .item(&palette)
        .item(&global_search)
        .separator()
        .item(&settings_item)
        .build()?;

    let md_help = MenuItemBuilder::with_id("help.markdown", s.md_help)
        .accelerator("F1")
        .build(app)?;
    let about = MenuItemBuilder::with_id("help.about", s.about).build(app)?;

    let help_submenu = SubmenuBuilder::new(app, s.help)
        .item(&md_help)
        .separator()
        .item(&about)
        .build()?;

    // macOS: the first submenu becomes the "App menu" (titled with the
    // app's process name) and is where users go for About / Settings /
    // Quit by HIG convention. Without this, ⌘Q does nothing and the
    // last menu item visually becomes "Close Tab" (issue #31).
    #[cfg(target_os = "macos")]
    {
        let app_about_meta = AboutMetadata {
            name: Some("SoloMD".into()),
            version: Some(env!("CARGO_PKG_VERSION").into()),
            credits: Some("Made by 智通 / xiangdong li".into()),
            authors: Some(vec!["xiangdong li".into()]),
            comments: Some("Lightweight, cross-platform Markdown editor.".into()),
            website: Some("https://solomd.app".into()),
            website_label: Some("solomd.app".into()),
            ..Default::default()
        };
        let app_submenu = SubmenuBuilder::new(app, "SoloMD")
            .about(Some(app_about_meta))
            .separator()
            .item(&settings_item)
            .separator()
            .item(&PredefinedMenuItem::services(app, None)?)
            .separator()
            .item(&PredefinedMenuItem::hide(app, None)?)
            .item(&PredefinedMenuItem::hide_others(app, None)?)
            .item(&PredefinedMenuItem::show_all(app, None)?)
            .separator()
            .item(&PredefinedMenuItem::quit(app, None)?)
            .build()?;

        let window_submenu = SubmenuBuilder::new(app, if lang == "zh" { "窗口" } else { "Window" })
            .item(&PredefinedMenuItem::minimize(app, None)?)
            .item(&PredefinedMenuItem::maximize(app, None)?)
            .separator()
            .item(&PredefinedMenuItem::close_window(app, None)?)
            .build()?;

        return MenuBuilder::new(app)
            .items(&[
                &app_submenu,
                &file_submenu,
                &edit_submenu,
                &view_submenu,
                &window_submenu,
                &help_submenu,
            ])
            .build();
    }

    #[cfg(not(target_os = "macos"))]
    MenuBuilder::new(app)
        .items(&[&file_submenu, &edit_submenu, &view_submenu, &help_submenu])
        .build()
}

/// Frontend calls this when user changes language in Settings.
#[tauri::command]
fn set_menu_language(app: tauri::AppHandle, lang: String) -> Result<(), String> {
    let menu = build_app_menu(&app, &lang).map_err(|e| e.to_string())?;
    app.set_menu(menu).map_err(|e| e.to_string())?;
    Ok(())
}

pub struct PendingOpen(pub Mutex<Vec<String>>);

/// Command: returns all paths queued by macOS Apple Events / CLI args
/// and clears the buffer. Called by the frontend on mount — this prevents
/// the race where the "opened" event fires before the JS listener exists.
#[tauri::command]
fn drain_pending_opens(state: tauri::State<PendingOpen>) -> Vec<String> {
    let mut guard = state.0.lock().unwrap();
    std::mem::take(&mut *guard)
}

/// One-shot guard so the size/position fit-up only runs once per launch.
/// After the plugin's restore (or the Ready-event fallback) triggers it,
/// further user moves/resizes are left alone.
static MAIN_FIT_DONE: AtomicBool = AtomicBool::new(false);

/// Apply the size + position clamp + show + focus exactly once. Subsequent
/// calls are cheap no-ops via the `MAIN_FIT_DONE` flag.
fn fit_main_window_once(win: &tauri::WebviewWindow) {
    if MAIN_FIT_DONE
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        return;
    }
    clamp_window_to_monitor(win);
    let _ = win.show();
    let _ = win.unminimize();
    let _ = win.set_focus();
}

/// Re-fit the main window into its current monitor's work area before show.
///
/// Two failure modes from `tauri-plugin-window-state` we have to defend
/// against on every launch:
/// 1. **Oversize restore** — a saved 2880×1740 from a 5K display, restored
///    on a 1440p laptop, leaves the bottom edge off-screen.
/// 2. **Out-of-bounds position** — saved coordinates from a now-disconnected
///    secondary monitor, or a saved Y that tucks the title bar behind the
///    macOS menu bar.
///
/// Behavior:
/// - If size or position is still valid for the current monitor, the user's
///   chosen layout is preserved (we don't fight intentional positioning).
/// - If anything was out of bounds, the window is clamped to a sensible
///   size and **recentered on the current monitor**. Centering > pinning to
///   an edge: a left-edge-pinned window after a display change reads as
///   "broken layout," whereas centered reads as "fresh start, sane state."
///
/// 40px is reserved at the top of the work area for the macOS menu bar.
fn clamp_window_to_monitor(win: &tauri::WebviewWindow) {
    // A maximized or fullscreen window is already sized to the monitor by the
    // OS — clamping it would call set_size(), which un-maximizes and shrinks
    // it. That's the Windows "restores maximized, then shrinks" bug (#56): the
    // window-state plugin restored the maximized state, then this clamp fired
    // on the restore's Resized event and undid it. Leave such windows alone.
    if win.is_maximized().unwrap_or(false) || win.is_fullscreen().unwrap_or(false) {
        return;
    }

    // The macOS global menu bar overlays the top of the screen, so reserve a
    // strip for it. Windows / Linux have no such bar — reserving there made a
    // legitimately near-full-height restored window get shrunk by 40px.
    #[cfg(target_os = "macos")]
    const MENU_BAR_RESERVE: i32 = 40;
    #[cfg(not(target_os = "macos"))]
    const MENU_BAR_RESERVE: i32 = 0;
    const MIN_W: i32 = 480;
    const MIN_H: i32 = 360;

    let Ok(Some(monitor)) = win.current_monitor() else { return; };
    let scale = monitor.scale_factor();
    let mon_w = (monitor.size().width as f64 / scale).round() as i32;
    let mon_h = (monitor.size().height as f64 / scale).round() as i32;
    let mon_x = (monitor.position().x as f64 / scale).round() as i32;
    let mon_y = (monitor.position().y as f64 / scale).round() as i32;

    let Ok(outer) = win.outer_size() else { return; };
    let cur_w = (outer.width as f64 / scale).round() as i32;
    let cur_h = (outer.height as f64 / scale).round() as i32;

    let max_w = mon_w;
    let max_h = mon_h - MENU_BAR_RESERVE;
    let new_w = cur_w.clamp(MIN_W, max_w);
    let new_h = cur_h.clamp(MIN_H, max_h);
    let size_clamped = new_w != cur_w || new_h != cur_h;

    let Ok(outer_pos) = win.outer_position() else { return; };
    let cur_x = (outer_pos.x as f64 / scale).round() as i32;
    let cur_y = (outer_pos.y as f64 / scale).round() as i32;

    // Position is "off-monitor" if any edge of the window falls outside the
    // current monitor's work area (top edge above the menu bar reserve, or
    // any other edge past the monitor bounds for the post-clamp size).
    let position_invalid = cur_x < mon_x
        || cur_x + new_w > mon_x + mon_w
        || cur_y < mon_y + MENU_BAR_RESERVE
        || cur_y + new_h > mon_y + mon_h;

    if size_clamped {
        let _ = win.set_size(tauri::LogicalSize::new(new_w as u32, new_h as u32));
    }

    if size_clamped || position_invalid {
        let new_x = mon_x + (mon_w - new_w) / 2;
        let centered_y = mon_y + (mon_h - new_h) / 2;
        let new_y = centered_y.max(mon_y + MENU_BAR_RESERVE);
        let _ = win.set_position(tauri::LogicalPosition::new(new_x, new_y));
    }
}

pub fn run_with(initial_file: Option<String>) {
    let pending: Vec<String> = initial_file.into_iter().collect();

    // IMPORTANT: must be called BEFORE NSApplication loads (i.e. before
    // `tauri::Builder::default()` below) so AppKit picks up the locale
    // for all system panels.
    let saved_lang = read_saved_language();
    apply_macos_language(&saved_lang);

    let builder = tauri::Builder::default();

    // #86/#87(1) — single-instance must register BEFORE any other plugin so
    // its handler hooks into the OS' "another instance launching" signal
    // before the rest of the app starts initialising. The second launch
    // reactivates the existing main window and routes any file argument
    // through the existing `solomd://opened-file` channel that App.vue
    // already listens on (used by the OS file association too).
    #[cfg(desktop)]
    let builder = builder.plugin(tauri_plugin_single_instance::init(
        |app: &tauri::AppHandle, argv: Vec<String>, _cwd: String| {
            use tauri::Emitter;
            if let Some(win) = app.get_webview_window("main") {
                let _ = win.unminimize();
                let _ = win.show();
                let _ = win.set_focus();
            }
            for arg in argv.iter().skip(1) {
                if !arg.is_empty() && !arg.starts_with('-') {
                    let _ = app.emit("solomd://opened-file", arg.clone());
                }
            }
        },
    ));

    let builder = builder
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init());

    // v4.3.x — issue #56 reopen: the original fix landed in `lib.rs::run`
    // but `main.rs` calls `runner::run_with` instead, so the StateFlags::all()
    // call there was never reached. The plugin's default StateFlags is
    // `POSITION | SIZE` — missing MAXIMIZED + FULLSCREEN + DECORATIONS,
    // which is why Windows users kept seeing the maximized state forgotten
    // on relaunch. Patch this site (the live one) too.
    #[cfg(desktop)]
    let builder = builder.plugin(
        tauri_plugin_window_state::Builder::default()
            .with_state_flags(tauri_plugin_window_state::StateFlags::all())
            .build(),
    );

    let app = builder
        .manage(PendingOpen(Mutex::new(pending)))
        .manage(watcher::WatcherState::new())
        .manage(recipe_runner::RecipesState::new())
        .invoke_handler(tauri::generate_handler![
            commands::read_file,
            commands::read_binary_file,
            commands::write_file,
            commands::write_binary_file,
            commands::print_webview,
            commands::copy_file,
            image_upload::upload_image,
            commands::list_dir,
            commands::fs_create_file,
            commands::fs_create_dir,
            commands::fs_delete,
            commands::fs_rename,
            search::search_in_dir,
            drain_pending_opens,
            force_close_window,
            set_menu_language,
            save_language_preference,
            set_default::set_as_default_markdown_editor,
            convert::convert_file_to_markdown,
            workspace_index::workspace_index_init,
            workspace_index::workspace_index_files,
            workspace_index::workspace_index_backlinks,
            workspace_index::workspace_index_tags,
            workspace_index::workspace_index_resolve,
            workspace_index::workspace_index_rescan,
            // v4.6 — these were only registered in the dead-code lib.rs::run();
            // the desktop binary uses runner::run_with(), so the F1 property
            // writes + F3 inverse-relationship lookup 404'd at runtime until
            // registered here too. (Same class as the #94 rag::* omission.)
            workspace_index::workspace_index_referenced_by,
            commands::update_frontmatter_property,
            commands::delete_frontmatter_property,
            spellcheck::spellcheck_init,
            spellcheck::spellcheck_check,
            spellcheck::spellcheck_suggest,
            spellcheck::spellcheck_add_to_dict,
            spellcheck::spellcheck_load_user_dict,
            ai_proxy::ai_set_key,
            ai_proxy::ai_has_key,
            ai_proxy::ai_clear_key,
            ai_proxy::ai_rewrite,
            ai_proxy::ai_chat,
            ai_proxy::ai_cancel,
            ai_proxy::ai_verify_key,
            pandoc::pandoc_detect,
            pandoc::pandoc_export,
            git_history::git_workspace_status,
            git_history::git_init_workspace,
            git_history::git_auto_commit,
            git_history::git_file_history,
            git_history::git_file_diff,
            git_history::git_file_at_version,
            git_history::git_rollback_file,
            capture_endpoint::capture_get_state,
            capture_endpoint::capture_set_enabled,
            capture_endpoint::capture_regenerate_token,
            capture_endpoint::capture_set_inbox_folder,
            capture_endpoint::capture_set_workspace,
            rest_api::rest_get_state,
            rest_api::rest_set_enabled,
            rest_api::rest_regenerate_token,
            rest_api::rest_set_allow_write,
            rest_api::rest_set_workspace,
            cost_meter::cost_meter_get,
            cost_meter::cost_meter_reset,
            cost_meter::cost_meter_set_enabled,
            themes::theme_install,
            themes::theme_uninstall,
            themes::theme_list_installed,
            cjk_proofread::cjk_proofread,
            github_sync::github_set_token,
            github_sync::github_clear_token,
            github_sync::github_has_token,
            github_sync::github_user,
            github_sync::github_list_repos,
            github_sync::github_create_vault_repo,
            github_sync::github_link_workspace,
            github_sync::github_set_config,
            github_sync::github_unlink_workspace,
            github_sync::github_enable_encryption,
            github_sync::github_sync_status,
            github_sync::github_push,
            github_sync::github_pull,
            github_sync::github_resolve_conflict,
            github_sync::proxy_get,
            github_sync::proxy_set,
            cloud_folder::cloud_folder_detect,
            cloud_folder::device_id_get_or_create,
            cloud_folder::session_save,
            cloud_folder::session_load,
            cloud_folder::session_list_others,
            crypto::crypto_status,
            crypto::crypto_set_passphrase,
            crypto::crypto_clear_passphrase,
            crypto::crypto_encrypt_for_push,
            crypto::crypto_decrypt_after_pull,
            watcher::watch_file,
            watcher::unwatch_file,
            agent_tools::agent_tool_list_notes,
            agent_tools::agent_tool_read_note,
            agent_tools::agent_tool_search,
            agent_tools::agent_tool_get_backlinks,
            agent_tools::agent_tool_list_tags,
            agent_tools::agent_tool_get_outline,
            agent_tools::agent_tool_autogit_log,
            agent_tools::agent_tool_autogit_diff,
            agent_tools::agent_tool_write_note,
            agent_tools::agent_tool_append_to_note,
            agent_tools::agent_tool_read_agent_trace,
            agent_tools::agent_list_runs,
            agent_trace::agent_trace_read,
            agent_trace::agent_trace_list,
            agent_trace::agent_trace_replay_from,
            ollama::ollama_detect,
            ollama::ollama_pull,
            ollama::ollama_cancel_pull,
            ollama::open_ollama_install_page,
            mcp_profiles::mcp_profiles_list,
            mcp_profiles::mcp_profiles_save,
            mcp_profiles::mcp_profiles_delete,
            mcp_profiles::mcp_profiles_export_config,
            integrations::cli_status,
            integrations::mcp_path,
            integrations::mcp_claude_desktop_config_path,
            integrations::detect_ai_clients,
            integrations::inject_mcp,
            integrations::remove_mcp,
            // #94 — desktop was missing rag::* (registered only in lib.rs).
            rag::rag_set_enabled,
            rag::rag_index_status,
            rag::rag_reindex,
            rag::rag_search,
            rag::rag_reindex_file,
            // about-dialog build info (was lib.rs-only too).
            app_build::app_build_info,
            recipe_runner::recipes_list,
            recipe_runner::recipes_get,
            recipe_runner::recipes_save,
            recipe_runner::recipes_delete,
            recipe_runner::recipes_run_now,
            recipe_runner::recipes_pending_runs,
            recipe_runner::recipes_history,
            recipe_runner::recipes_read_trace,
            recipe_runner::recipes_read_run_md,
            recipe_runner::recipes_run_diff,
            recipe_runner::recipes_accept_run,
            recipe_runner::recipes_reject_run,
            cookbook::cookbook_list,
            cookbook::cookbook_get,
            cookbook::cookbook_install,
        ])
        .on_menu_event(|app_handle, event| {
            // Forward every menu click to the frontend as a single event
            // with the menu item id as payload. App.vue dispatches actions
            // based on this id.
            let id = event.id().0.clone();
            let _ = app_handle.emit("solomd://menu", id);
        })
        .setup(|app| {
            // Build initial menu in English — the frontend will call
            // `set_menu_language` on mount to apply the user's saved preference.
            let menu = build_app_menu(app.handle(), "en")?;
            app.set_menu(menu)?;

            // The window-state plugin's restore_state is dispatched via
            // `run_on_main_thread`, so it doesn't fire until AFTER setup
            // returns AND after the run loop has started processing. Hook
            // the main window's first Resized OR Moved event — that's the
            // restore — and clamp at that moment. A second hook in the
            // run-loop event match (`RunEvent::Ready` + 400ms timer) acts
            // as a fallback when there's no saved state to restore.
            if let Some(win) = app.get_webview_window("main") {
                let win_clone = win.clone();
                win.on_window_event(move |event| {
                    if matches!(
                        event,
                        tauri::WindowEvent::Resized(_) | tauri::WindowEvent::Moved(_)
                    ) {
                        fit_main_window_once(&win_clone);
                    }
                });
            }

            // NOTE: do NOT drain PendingOpen here. The frontend calls
            // `drain_pending_opens` on mount instead, which avoids the
            // race condition where the "opened-file" event fires before
            // the JS listener is ready (happens on macOS cold start).

            // v2.3: in debug builds, start the WebDriver bridge so
            // `solomd-dev-mcp` can drive the live UI from outside.
            // Release builds compile this out entirely.
            #[cfg(debug_assertions)]
            {
                dev_bridge::spawn(app.handle().clone());
            }

            // v4.0 Pillar 2 — start the cron-trigger loop. Sleeps until
            // a `schedule` recipe is due; harmless when no recipes are
            // loaded yet (the loop polls workspace state every minute
            // and recipes are loaded eagerly by `recipes_list`).
            recipe_runner::spawn_cron_loop(app.handle().clone());
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|app_handle, event| {
        match &event {
            // ---- Post-restore window setup ----
            // `RunEvent::Ready` fires after the run loop has started, which
            // means after `tauri-plugin-window-state` has had a chance to
            // process its `run_on_main_thread`-queued restore_state call.
            // Two things we do here that we can't reliably do in `setup`:
            //
            // 1. Clamp the restored window to the current monitor (size +
            //    position). The plugin happily restores a saved 2556×1320
            //    @ x=1207 from a previous multi-monitor session onto a
            //    single 2560-wide monitor, leaving the right edge 1.2k px
            //    off-screen. Always recenter when the saved layout is
            //    invalid for the current monitor; preserve when valid.
            //
            // 2. macOS-only: re-issue show + set_focus so SoloMD becomes
            //    frontmost. `set_focus` from `setup` fires before NSApp
            //    has finished `applicationDidFinishLaunching` and gets
            //    silently dropped, leaving SoloMD launched behind the
            //    parent app (Finder / terminal) — the macOS menu bar
            //    keeps showing the previous app's menus until the user
            //    drags SoloMD's window.
            RunEvent::Ready => {
                // Fallback path: when there's no saved window state for the
                // plugin to restore (fresh install, deleted state file), no
                // Resized/Moved event ever fires from the restore — the
                // setup-time `on_window_event` hook would never trigger and
                // the window would never get shown / focused. Schedule a
                // delayed fit on a background thread; the AtomicBool guard
                // makes it a no-op if the on_window_event hook beat us.
                let app_handle_clone = app_handle.clone();
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_millis(400));
                    if let Some(win) = app_handle_clone.get_webview_window("main") {
                        fit_main_window_once(&win);
                    }
                });
            }

            // ---- Window close: intercept and ask frontend ----
            // Only the main window gets the unsaved-tabs check. Auxiliary
            // windows (slideshow, "open file in new window" spawns labelled
            // `solomd-window-N` — #103) close directly: their frontend
            // (App.vue's onCloseRequested for aux labels) removes them from
            // the shared windows registry so they don't resurrect next launch.
            // Routing them through the main window's listener would instead
            // shut down the editor.
            RunEvent::WindowEvent {
                event: tauri::WindowEvent::CloseRequested { api, .. },
                label,
                ..
            } => {
                if label != "main" {
                    return; // let the auxiliary window close itself
                }
                if FORCE_CLOSE.load(Ordering::Relaxed) {
                    // Frontend confirmed — let the close proceed.
                    return;
                }
                // Prevent the close and ask the frontend to check unsaved tabs.
                api.prevent_close();
                let _ = app_handle.emit("solomd://close-requested", ());
            }

            // ---- Auxiliary window destroyed ----
            // #103 — when an auxiliary window is fully torn down, tell any
            // window still alive so it can reconcile the shared windows
            // registry. The destroyed window's own `onCloseRequested` handler
            // already unregisters it in the normal path; this event is the
            // backstop for teardowns that bypass CloseRequested, keeping the
            // registry from resurrecting a window the user actually closed.
            RunEvent::WindowEvent {
                event: tauri::WindowEvent::Destroyed,
                label,
                ..
            } => {
                if label != "main" {
                    let _ = app_handle.emit("solomd://window-destroyed", label.clone());
                }
            }

            // ---- macOS file open via double-click / Finder ----
            #[cfg(target_os = "macos")]
            RunEvent::Opened { urls } => {
                for url in urls {
                    let path = if url.scheme() == "file" {
                        url.to_file_path()
                            .ok()
                            .and_then(|p| p.to_str().map(|s| s.to_string()))
                    } else {
                        Some(url.to_string())
                    };
                    if let Some(p) = path {
                        if let Some(state) = app_handle.try_state::<PendingOpen>() {
                            state.0.lock().unwrap().push(p.clone());
                        }
                        let _ = app_handle.emit("solomd://opened-file", p);
                    }
                }
            }

            _ => {}
        }
    });
}
