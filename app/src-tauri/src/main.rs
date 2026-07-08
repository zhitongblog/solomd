// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod runner;

fn main() {
    let initial_file: Option<String> = std::env::args()
        .skip(1)
        .find(|a| !a.starts_with('-'))
        .filter(|p| {
            let pp = std::path::Path::new(p);
            pp.exists()
                || pp
                    .extension()
                    .and_then(|e| e.to_str())
                    .map(|e| {
                        matches!(
                            e.to_ascii_lowercase().as_str(),
                            "md" | "markdown" | "mdown" | "mkd" | "txt"
                        )
                    })
                    .unwrap_or(false)
        });

    // Explicit multi-thread tokio runtime kept alive for the whole process
    // lifetime. Tauri 2 brings tokio transitively but doesn't always
    // enter a multi-thread runtime at plugin-setup time on Windows;
    // any plugin or sync code that does `tokio::spawn` during setup
    // would panic, and on Windows release builds (panic = abort) that
    // panic terminates the entire app at startup.
    //
    // First seen as the v1.1.2 Windows launch crash with the (now-gone)
    // tauri-plugin-aptabase. The defensive guard stays after the
    // telemetry migration to solomd.app/api/track because reqwest
    // streaming + autogit + RAG all rely on the same multi-thread
    // runtime being available.
    let rt = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .expect("build tokio runtime");
    let _guard = rt.enter();

    runner::run_with(initial_file);
}
