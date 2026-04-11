#[path = "commands.rs"]
mod commands;

#[path = "search.rs"]
mod search;

use std::sync::Mutex;
use tauri::menu::{MenuBuilder, MenuItemBuilder, SubmenuBuilder};
use tauri::{Emitter, Manager, RunEvent};

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

    let app = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .manage(PendingOpen(Mutex::new(pending)))
        .invoke_handler(tauri::generate_handler![
            commands::read_file,
            commands::write_file,
            commands::write_binary_file,
            commands::copy_file,
            commands::list_dir,
            search::search_in_dir,
            drain_pending_opens,
        ])
        .on_menu_event(|app_handle, event| {
            // Forward every menu click to the frontend as a single event
            // with the menu item id as payload. App.vue dispatches actions
            // based on this id.
            let id = event.id().0.clone();
            let _ = app_handle.emit("solomd://menu", id);
        })
        .setup(|app| {
            // ---- Build native menu bar (File / Edit / View / Help) ----
            let new_md = MenuItemBuilder::with_id("file.new", "New Markdown")
                .accelerator("CmdOrCtrl+N")
                .build(app)?;
            let new_txt = MenuItemBuilder::with_id("file.newText", "New Plain Text")
                .accelerator("CmdOrCtrl+Alt+N")
                .build(app)?;
            let open_file = MenuItemBuilder::with_id("file.open", "Open File…")
                .accelerator("CmdOrCtrl+O")
                .build(app)?;
            let open_folder = MenuItemBuilder::with_id("file.openFolder", "Open Folder…")
                .build(app)?;
            let save = MenuItemBuilder::with_id("file.save", "Save")
                .accelerator("CmdOrCtrl+S")
                .build(app)?;
            let save_as = MenuItemBuilder::with_id("file.saveAs", "Save As…")
                .accelerator("CmdOrCtrl+Shift+S")
                .build(app)?;
            let close_tab = MenuItemBuilder::with_id("file.closeTab", "Close Tab")
                .accelerator("CmdOrCtrl+W")
                .build(app)?;
            let new_window = MenuItemBuilder::with_id("window.new", "New Window")
                .accelerator("CmdOrCtrl+Shift+N")
                .build(app)?;

            let file_submenu = SubmenuBuilder::new(app, "File")
                .item(&new_md)
                .item(&new_txt)
                .separator()
                .item(&open_file)
                .item(&open_folder)
                .separator()
                .item(&save)
                .item(&save_as)
                .separator()
                .item(&new_window)
                .item(&close_tab)
                .build()?;

            // Edit: rely on predefined items so they get the correct
            // platform behavior (cut / copy / paste etc.)
            let edit_submenu = SubmenuBuilder::new(app, "Edit")
                .undo()
                .redo()
                .separator()
                .cut()
                .copy()
                .paste()
                .select_all()
                .build()?;

            // View
            let toggle_theme = MenuItemBuilder::with_id("view.toggleTheme", "Toggle Theme")
                .build(app)?;
            let toggle_sidebar =
                MenuItemBuilder::with_id("view.toggleFileTree", "Toggle File Tree")
                    .accelerator("CmdOrCtrl+B")
                    .build(app)?;
            let toggle_outline =
                MenuItemBuilder::with_id("view.toggleOutline", "Toggle Outline")
                    .accelerator("CmdOrCtrl+Shift+O")
                    .build(app)?;
            let cycle_view = MenuItemBuilder::with_id("view.cycleView", "Cycle Edit/Split/Preview")
                .accelerator("CmdOrCtrl+Shift+P")
                .build(app)?;
            let palette = MenuItemBuilder::with_id("view.cmdPalette", "Command Palette")
                .accelerator("CmdOrCtrl+Shift+K")
                .build(app)?;
            let global_search =
                MenuItemBuilder::with_id("search.global", "Search in Folder…")
                    .accelerator("CmdOrCtrl+Shift+F")
                    .build(app)?;
            let settings = MenuItemBuilder::with_id("view.settings", "Settings…")
                .accelerator("CmdOrCtrl+,")
                .build(app)?;

            let view_submenu = SubmenuBuilder::new(app, "View")
                .item(&toggle_theme)
                .separator()
                .item(&toggle_sidebar)
                .item(&toggle_outline)
                .item(&cycle_view)
                .separator()
                .item(&palette)
                .item(&global_search)
                .separator()
                .item(&settings)
                .build()?;

            // Help
            let md_help = MenuItemBuilder::with_id("help.markdown", "Markdown Cheatsheet")
                .accelerator("F1")
                .build(app)?;
            let about = MenuItemBuilder::with_id("help.about", "About SoloMD").build(app)?;

            let help_submenu = SubmenuBuilder::new(app, "Help")
                .item(&md_help)
                .separator()
                .item(&about)
                .build()?;

            let menu = MenuBuilder::new(app)
                .items(&[&file_submenu, &edit_submenu, &view_submenu, &help_submenu])
                .build()?;
            app.set_menu(menu)?;

            // NOTE: do NOT drain PendingOpen here. The frontend calls
            // `drain_pending_opens` on mount instead, which avoids the
            // race condition where the "opened-file" event fires before
            // the JS listener is ready (happens on macOS cold start).
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|app_handle, event| {
        #[cfg(target_os = "macos")]
        if let RunEvent::Opened { urls } = &event {
            for url in urls {
                let path = if url.scheme() == "file" {
                    url.to_file_path()
                        .ok()
                        .and_then(|p| p.to_str().map(|s| s.to_string()))
                } else {
                    Some(url.to_string())
                };
                if let Some(p) = path {
                    // Always push to the pending buffer so a cold start
                    // can pick it up via `drain_pending_opens`.
                    if let Some(state) = app_handle.try_state::<PendingOpen>() {
                        state.0.lock().unwrap().push(p.clone());
                    }
                    // Also emit the event for the hot case where the
                    // frontend is already mounted and listening.
                    let _ = app_handle.emit("solomd://opened-file", p);
                }
            }
        }
        #[cfg(not(target_os = "macos"))]
        {
            let _ = (app_handle, &event);
        }
    });
}
