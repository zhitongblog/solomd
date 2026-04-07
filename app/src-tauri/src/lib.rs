mod commands;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .invoke_handler(tauri::generate_handler![
            commands::read_file,
            commands::write_file,
            commands::write_binary_file,
            commands::list_dir,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
