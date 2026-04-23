pub mod commands;
pub mod search;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_aptabase::Builder::new("A-EU-4631704280").build());

    #[cfg(desktop)]
    let builder = builder.plugin(tauri_plugin_window_state::Builder::default().build());

    builder
        .invoke_handler(tauri::generate_handler![
            commands::read_file,
            commands::write_file,
            commands::write_binary_file,
            commands::copy_file,
            commands::list_dir,
            search::search_in_dir,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
