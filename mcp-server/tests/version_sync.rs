//! solomd-mcp ships inside SoloMD, so it must report the app's version.
//!
//! It used to say 0.4.1 while the app, server.json and the .mcpb manifest
//! all said 4.14.x, which made bug reports and registry listings disagree.
//! `scripts/release.sh` bumps every file checked here; this test catches a
//! hand-made bump that forgets one. Skipped when the crate is built outside
//! the SoloMD repo (e.g. from crates.io).

use std::path::PathBuf;

fn repo_file(rel: &str) -> Option<String> {
    let p = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..").join(rel);
    std::fs::read_to_string(p).ok()
}

fn json_version(raw: &str) -> String {
    let v: serde_json::Value = serde_json::from_str(raw).expect("valid JSON");
    v["version"].as_str().expect("top-level version").to_string()
}

#[test]
fn mcp_version_matches_the_app() {
    let Some(conf) = repo_file("app/src-tauri/tauri.conf.json") else {
        eprintln!("skipping: not inside the SoloMD repo");
        return;
    };
    let app = json_version(&conf);
    assert_eq!(
        env!("CARGO_PKG_VERSION"),
        app,
        "mcp-server/Cargo.toml version must equal tauri.conf.json (run scripts/release.sh)"
    );

    if let Some(cli) = repo_file("scripts/solomd") {
        let baked = cli
            .lines()
            .find_map(|l| l.strip_prefix("SOLOMD_VERSION=\""))
            .and_then(|rest| rest.split('"').next())
            .expect("SOLOMD_VERSION in scripts/solomd");
        assert_eq!(baked, app, "scripts/solomd SOLOMD_VERSION must equal the app version");
    }
}
