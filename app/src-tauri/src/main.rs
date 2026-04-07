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

    runner::run_with(initial_file);
}
