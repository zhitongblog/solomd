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
    // lifetime. Several plugins (notably aptabase) call `tokio::spawn`
    // during their `.setup()` callback; without a runtime entered on the
    // main thread those spawns panic, and on Windows release builds
    // (panic = abort) the panic terminates the entire app at startup.
    //
    // This is the root fix for the v1.1.2 Windows launch crash —
    // https://github.com/aptabase/tauri-plugin-aptabase/issues/16
    let rt = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .expect("build tokio runtime");
    let _guard = rt.enter();

    runner::run_with(initial_file);
}
