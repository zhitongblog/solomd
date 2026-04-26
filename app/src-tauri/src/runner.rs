#[path = "commands.rs"]
mod commands;

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

#[path = "ai_proxy.rs"]
mod ai_proxy;

#[path = "pandoc.rs"]
mod pandoc;

#[path = "git_history.rs"]
mod git_history;

// v2.4 inbound HTTP capture endpoint — production-grade, opt-in via Settings.
#[path = "capture_endpoint.rs"]
mod capture_endpoint;

// v2.5 community theme marketplace — see app/src-tauri/src/themes.rs.
#[path = "themes.rs"]
mod themes;

// v2.5 CJK proofread — flags common Chinese typos with one-click fixes.
#[path = "cjk_proofread.rs"]
mod cjk_proofread;

// v2.6 GitHub-backed sync — push/pull a workspace to a user-owned GitHub repo.
#[path = "github_sync.rs"]
mod github_sync;

// v2.3 dev WebDriver bridge — debug builds only. Module file itself is
// `#[cfg(debug_assertions)]`-gated, so this `mod` line is too.
#[cfg(debug_assertions)]
#[path = "dev_bridge.rs"]
mod dev_bridge;

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
    toggle_theme: &'static str,
    toggle_sidebar: &'static str,
    toggle_outline: &'static str,
    cycle_view: &'static str,
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
            toggle_theme: "切换主题",
            toggle_sidebar: "切换文件树",
            toggle_outline: "切换大纲",
            cycle_view: "切换视图模式 (编辑/分栏/预览)",
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
            toggle_theme: "Toggle Theme",
            toggle_sidebar: "Toggle File Tree",
            toggle_outline: "Toggle Outline",
            cycle_view: "Cycle Edit/Split/Preview",
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

pub fn run_with(initial_file: Option<String>) {
    let pending: Vec<String> = initial_file.into_iter().collect();

    // IMPORTANT: must be called BEFORE NSApplication loads (i.e. before
    // `tauri::Builder::default()` below) so AppKit picks up the locale
    // for all system panels.
    let saved_lang = read_saved_language();
    apply_macos_language(&saved_lang);

    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_aptabase::Builder::new("A-EU-4631704280").build());

    #[cfg(desktop)]
    let builder = builder.plugin(tauri_plugin_window_state::Builder::default().build());

    let app = builder
        .manage(PendingOpen(Mutex::new(pending)))
        .invoke_handler(tauri::generate_handler![
            commands::read_file,
            commands::write_file,
            commands::write_binary_file,
            commands::print_webview,
            commands::copy_file,
            commands::list_dir,
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
            spellcheck::spellcheck_init,
            spellcheck::spellcheck_check,
            spellcheck::spellcheck_suggest,
            spellcheck::spellcheck_add_to_dict,
            spellcheck::spellcheck_load_user_dict,
            ai_proxy::ai_set_key,
            ai_proxy::ai_has_key,
            ai_proxy::ai_clear_key,
            ai_proxy::ai_rewrite,
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
            github_sync::github_sync_status,
            github_sync::github_push,
            github_sync::github_pull,
            github_sync::github_resolve_conflict,
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

            // Windows-specific: when launched via file association, the newly
            // created window sometimes lands behind the Explorer window that
            // triggered it (focus-stealing prevention). Explicitly show + focus
            // the main window to bring it forward.
            if let Some(win) = app.get_webview_window("main") {
                let _ = win.show();
                let _ = win.unminimize();
                let _ = win.set_focus();
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
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|app_handle, event| {
        match &event {
            // ---- Window close: intercept and ask frontend ----
            // Only the main window gets the unsaved-tabs check. Auxiliary
            // windows (slideshow, "open file in new window" spawns labelled
            // `solomd-…`) close directly, otherwise their close event would
            // trigger the main window's listener and shut down the editor.
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
