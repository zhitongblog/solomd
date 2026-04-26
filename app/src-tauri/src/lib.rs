pub mod commands;
pub mod search;
pub mod workspace_index;
pub mod spellcheck;
pub mod ai_proxy;
pub mod pandoc;
pub mod git_history;
pub mod rag;
// v2.4 inbound HTTP capture endpoint — production-grade, opt-in via Settings.
pub mod capture_endpoint;
// v2.4 outbound integrations — CLI + MCP sidecar discovery, surfaced in Settings.
pub mod integrations;
// v2.5 F6 CJK proofread — flags common Chinese typos with one-click fixes.
pub mod cjk_proofread;
// v2.5 community theme marketplace — manifest fetched JS-side, CSS files
// written into <config_dir>/themes/<id>.css by these commands.
pub mod themes;
// v2.6 GitHub-backed sync — extends v2.2 AutoGit with push/pull to a
// user-owned GitHub repo. PAT in OS keychain, config in .solomd/sync.json.
pub mod github_sync;
// v2.6.1 cloud-folder detection (iCloud / Dropbox / OneDrive / Google Drive)
// + cross-device session restore via per-device JSON.
pub mod cloud_folder;
// v2.6.3 workspace-level E2EE: passphrase → Argon2id → key in keyring;
// XChaCha20-Poly1305 over each .md before push, decrypt after pull.
pub mod crypto;

// v2.3 dev WebDriver bridge — debug builds only.
#[cfg(debug_assertions)]
pub mod dev_bridge;

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
        .setup(|app| {
            #[cfg(debug_assertions)]
            {
                dev_bridge::spawn(app.handle().clone());
            }
            #[cfg(not(debug_assertions))]
            {
                let _ = app;
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::read_file,
            commands::write_file,
            commands::write_binary_file,
            commands::print_webview,
            commands::copy_file,
            commands::list_dir,
            search::search_in_dir,
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
            rag::rag_set_enabled,
            rag::rag_index_status,
            rag::rag_reindex,
            rag::rag_search,
            rag::rag_reindex_file,
            capture_endpoint::capture_get_state,
            capture_endpoint::capture_set_enabled,
            capture_endpoint::capture_regenerate_token,
            capture_endpoint::capture_set_inbox_folder,
            capture_endpoint::capture_set_workspace,
            integrations::cli_status,
            integrations::mcp_path,
            integrations::mcp_claude_desktop_config_path,
            cjk_proofread::cjk_proofread,
            themes::theme_install,
            themes::theme_uninstall,
            themes::theme_list_installed,
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
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
