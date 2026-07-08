pub mod app_build;
pub mod commands;
// Image-bed (图床) upload: PicGo / shell command / sm.ms / S3-compatible / GitHub.
pub mod image_upload;
pub mod search;
pub mod workspace_index;
pub mod spellcheck;
// #102 — cross-platform AI key storage (OS keyring + Android encrypted-file
// fallback). Declared before ai_proxy, which delegates to it.
pub mod ai_keystore;
pub mod ai_proxy;
// v4.0 Pillar 5: Ollama polish — detect / pull / install-page commands on
// top of the existing chat runner in ai_proxy. Pure additive.
pub mod ollama;
pub mod pandoc;
// AutoGit + GitHub sync rely on libgit2 (vendored). Cross-compiling libgit2
// + openssl through the NDK is painful and these are desktop-class features
// (the user shouldn't be pushing to GitHub from a phone). Gate them out of
// Android — frontend already hides any UI that calls into these commands
// when the Tauri command resolution fails.
#[cfg(not(target_os = "android"))]
pub mod git_history;
pub mod rag;
// v2.4 inbound HTTP capture endpoint — production-grade, opt-in via Settings.
pub mod capture_endpoint;
// v4.0 — public REST API mirroring the agent_tools surface for non-MCP
// clients (Alfred / Raycast / n8n / shell scripts). Localhost-only,
// bearer-token auth, opt-in via Settings → Integrations. Same wire shape
// as `capture_endpoint`.
pub mod rest_api;
// v4.0 — BYOK cost meter: per-provider cumulative tokens + dollar spend
// across all runs; persisted in app-config dir; opt-in surface in Settings → AI.
pub mod cost_meter;
// v2.4 outbound integrations — CLI + MCP sidecar discovery, surfaced in Settings.
pub mod integrations;
// v4.0 P4 — MCP federation profile storage (named bundles of workspaces +
// "Copy Claude Desktop config" rendering).
pub mod mcp_profiles;
// v2.5 F6 CJK proofread — flags common Chinese typos with one-click fixes.
pub mod cjk_proofread;
// v2.5 community theme marketplace — manifest fetched JS-side, CSS files
// written into <config_dir>/themes/<id>.css by these commands.
pub mod themes;
// v2.6 GitHub-backed sync — extends v2.2 AutoGit with push/pull to a
// user-owned GitHub repo. PAT in OS keychain, config in .solomd/sync.json.
// Same git2 dep → same Android gate as git_history.
#[cfg(not(target_os = "android"))]
pub mod github_sync;
// v2.6.1 cloud-folder detection (iCloud / Dropbox / OneDrive / Google Drive)
// + cross-device session restore via per-device JSON.
pub mod cloud_folder;
// v2.6.3 workspace-level E2EE: passphrase → Argon2id → key in keyring;
// XChaCha20-Poly1305 over each .md before push, decrypt after pull.
pub mod crypto;
// PR #24 (@beihai23) external file-change watcher — preview mode auto-reloads,
// edit / split modes pop a reload-vs-keep dialog.
pub mod watcher;

// v4.0 Pillar 1: in-process agent tool registry + run persistence (panel
// chat). agent_run (RunHandle) is the canonical run-dir owner; both the
// panel runner and the recipe runner attach to it.
pub mod agent_run;
pub mod agent_tools;
// v4.0 — provider pricing table for cost estimates written into
// agent-runs/<id>/meta.json.cost_usd_estimate.
pub mod pricing;
// v4.0 Pillar 3 — canonical agent trace emitter + reader. agent_run's
// append_trace will adopt trace::Emitter in a follow-up; for now they
// coexist (agent_run writes the run-dir scaffolding + trace lines, trace
// owns the typed Emitter API + reader used by the MCP read_agent_trace
// tool, the TraceView.vue component, and (post-merge) the recipe runner).
pub mod trace;
// v4.0 Pillar 3 — Tauri command wrappers for the trace module
// (agent_trace_read / agent_trace_list / agent_trace_replay_from).
pub mod agent_trace;
// v4.0 Pillar 2 — Agent Recipes. `recipes` parses the YAML schema +
// owns the `.solomd/agents/` loader; `recipe_runner` drives one recipe
// end-to-end, hooks save / commit / cron / manual triggers, and gates
// writes behind the AutoGit branch sandbox + write-cap.
pub mod recipes;
// recipe_runner uses git2 for the branch sandbox — gate out of Android
// alongside git_history / github_sync. Without the runner the Recipes
// YAML loader (recipes module) still parses files for the CLI / MCP, but
// in-app cron triggers and run dispatch are desktop-only anyway.
#[cfg(not(target_os = "android"))]
pub mod recipe_runner;
// v4.0 — bundled recipe cookbook (10+ ready-to-edit YAML templates).
// Shipped as `include_str!` content compiled into the binary; commands
// list / preview / install into <workspace>/.solomd/agents/.
pub mod cookbook;

// v2.3 dev WebDriver bridge — debug builds only.
#[cfg(debug_assertions)]
pub mod dev_bridge;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        // tauri-plugin-deep-link: receive incoming files / URLs from
        // iOS "Open with" / Files app / Mail attachments. On iOS the
        // plugin hooks `application:openURL:` automatically and emits
        // a `deep-link://new-url` event over Tauri's event bus, which
        // App.vue's onMounted handler picks up to spawn a new tab.
        .plugin(tauri_plugin_deep_link::init());

    #[cfg(desktop)]
    let builder = builder.plugin(
        tauri_plugin_window_state::Builder::default()
            .with_state_flags(tauri_plugin_window_state::StateFlags::all())
            .build(),
    );

    let builder = builder.manage(watcher::WatcherState::new());
    #[cfg(not(target_os = "android"))]
    let builder = builder.manage(recipe_runner::RecipesState::new());
    builder
        .setup(|app| {
            #[cfg(debug_assertions)]
            {
                dev_bridge::spawn(app.handle().clone());
            }
            // Show the window only after first paint to suppress the
            // position-jump flicker on Windows (issue #60). The window
            // is born hidden (tauri.conf.json: "visible": false) and
            // we reveal it here once the webview has settled.
            #[cfg(not(any(target_os = "android", target_os = "ios")))]
            {
                use tauri::Manager;
                if let Some(win) = app.get_webview_window("main") {
                    let _ = win.show();
                    let _ = win.set_focus();
                }
            }
            #[cfg(any(target_os = "android", target_os = "ios"))]
            {
                let _ = app;
            }
            // v4.0 Pillar 2 — start the cron-trigger loop. Sleeps until
            // a `schedule` recipe is due; harmless when no recipes are
            // loaded yet (the loop polls workspace state every minute).
            // Skipped in App Store builds (no AI / Agent / Recipe surface)
            // and on Android (recipe_runner gated out — needs libgit2).
            #[cfg(not(target_os = "android"))]
            if !app_build::IS_APP_STORE {
                recipe_runner::spawn_cron_loop(app.handle().clone());
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            app_build::app_build_info,
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
            ai_proxy::ai_chat,
            ai_proxy::ai_cancel,
            ai_proxy::ai_verify_key,
            ollama::ollama_detect,
            ollama::ollama_pull,
            ollama::ollama_cancel_pull,
            ollama::open_ollama_install_page,
            pandoc::pandoc_detect,
            pandoc::pandoc_export,
            #[cfg(not(target_os = "android"))]
            git_history::git_workspace_status,
            #[cfg(not(target_os = "android"))]
            git_history::git_init_workspace,
            #[cfg(not(target_os = "android"))]
            git_history::git_auto_commit,
            #[cfg(not(target_os = "android"))]
            git_history::git_file_history,
            #[cfg(not(target_os = "android"))]
            git_history::git_file_diff,
            #[cfg(not(target_os = "android"))]
            git_history::git_file_at_version,
            #[cfg(not(target_os = "android"))]
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
            rest_api::rest_get_state,
            rest_api::rest_set_enabled,
            rest_api::rest_regenerate_token,
            rest_api::rest_set_allow_write,
            rest_api::rest_set_workspace,
            cost_meter::cost_meter_get,
            cost_meter::cost_meter_reset,
            cost_meter::cost_meter_set_enabled,
            integrations::cli_status,
            integrations::mcp_path,
            integrations::mcp_claude_desktop_config_path,
            integrations::detect_ai_clients,
            integrations::inject_mcp,
            integrations::remove_mcp,
            mcp_profiles::mcp_profiles_list,
            mcp_profiles::mcp_profiles_save,
            mcp_profiles::mcp_profiles_delete,
            mcp_profiles::mcp_profiles_export_config,
            cjk_proofread::cjk_proofread,
            themes::theme_install,
            themes::theme_uninstall,
            themes::theme_list_installed,
            #[cfg(not(target_os = "android"))]
            github_sync::github_set_token,
            #[cfg(not(target_os = "android"))]
            github_sync::github_clear_token,
            #[cfg(not(target_os = "android"))]
            github_sync::github_has_token,
            #[cfg(not(target_os = "android"))]
            github_sync::github_user,
            #[cfg(not(target_os = "android"))]
            github_sync::github_list_repos,
            #[cfg(not(target_os = "android"))]
            github_sync::github_create_vault_repo,
            #[cfg(not(target_os = "android"))]
            github_sync::github_link_workspace,
            #[cfg(not(target_os = "android"))]
            github_sync::github_set_config,
            #[cfg(not(target_os = "android"))]
            github_sync::github_unlink_workspace,
            #[cfg(not(target_os = "android"))]
            github_sync::github_enable_encryption,
            #[cfg(not(target_os = "android"))]
            github_sync::github_sync_status,
            #[cfg(not(target_os = "android"))]
            github_sync::github_push,
            #[cfg(not(target_os = "android"))]
            github_sync::github_pull,
            #[cfg(not(target_os = "android"))]
            github_sync::github_resolve_conflict,
            #[cfg(not(target_os = "android"))]
            github_sync::proxy_get,
            #[cfg(not(target_os = "android"))]
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
            #[cfg(not(target_os = "android"))]
            recipe_runner::recipes_list,
            #[cfg(not(target_os = "android"))]
            recipe_runner::recipes_get,
            #[cfg(not(target_os = "android"))]
            recipe_runner::recipes_save,
            #[cfg(not(target_os = "android"))]
            recipe_runner::recipes_delete,
            #[cfg(not(target_os = "android"))]
            recipe_runner::recipes_run_now,
            #[cfg(not(target_os = "android"))]
            recipe_runner::recipes_pending_runs,
            #[cfg(not(target_os = "android"))]
            recipe_runner::recipes_history,
            #[cfg(not(target_os = "android"))]
            recipe_runner::recipes_read_trace,
            #[cfg(not(target_os = "android"))]
            recipe_runner::recipes_read_run_md,
            #[cfg(not(target_os = "android"))]
            recipe_runner::recipes_run_diff,
            #[cfg(not(target_os = "android"))]
            recipe_runner::recipes_accept_run,
            #[cfg(not(target_os = "android"))]
            recipe_runner::recipes_reject_run,
            cookbook::cookbook_list,
            cookbook::cookbook_get,
            cookbook::cookbook_install,
            workspace_index::workspace_index_referenced_by,
            commands::update_frontmatter_property,
            commands::delete_frontmatter_property,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
