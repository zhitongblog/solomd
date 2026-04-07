#[path = "commands.rs"]
mod commands;

#[path = "search.rs"]
mod search;

use std::sync::Mutex;
use tauri::{Emitter, Manager, RunEvent};

struct PendingOpen(Mutex<Vec<String>>);

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
            commands::list_dir,
            search::search_in_dir,
        ])
        .setup(|app| {
            let handle = app.handle().clone();
            let pending_state = app.state::<PendingOpen>();
            let paths: Vec<String> = {
                let mut guard = pending_state.0.lock().unwrap();
                std::mem::take(&mut *guard)
            };
            if !paths.is_empty() {
                // Defer a tick so the frontend has a chance to mount its listener.
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_millis(400));
                    for path in paths {
                        let _ = handle.emit("solomd://opened-file", path);
                    }
                });
            }
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
