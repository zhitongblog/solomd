//! F5 Pandoc export driver.
//!
//! We do **not** bundle pandoc — instead we look it up on PATH and surface
//! a structured error to the UI when missing. This keeps the installer
//! slim (~50 MB savings) and matches Zettlr's approach.
//!
//! Two commands are exposed:
//!
//!   * `pandoc_detect` — returns `{ path, version }` if found, `None` otherwise.
//!   * `pandoc_export` — writes the input markdown to a temp file then runs
//!     `pandoc <tmp> -o <output_path> [--citeproc --bibliography=… --csl=…]
//!     [--template=…] [extra_args…]`. The temp file is cleaned up on success
//!     or failure.
//!
//! All errors are returned as `Err(String)` formatted for direct surfacing
//! in a toast. The frontend differentiates "pandoc not found" from runtime
//! errors via the `pandoc_detect` call (it's invoked before `pandoc_export`).
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::process::Command;

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct PandocInfo {
    pub path: String,
    pub version: String,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct ExportArgs {
    pub input_markdown: String,
    /// Pandoc output format, e.g. `epub`, `odt`, `latex`, `rtf`, or any
    /// `--to` format Pandoc supports. We don't pass this to `--to` directly
    /// because pandoc auto-detects from the output extension; it's used for
    /// telemetry / informational purposes by the caller.
    pub format: String,
    /// Absolute path of the output file. Pandoc derives the format from the
    /// extension (`.epub`, `.odt`, `.tex`, `.rtf`, …).
    pub output_path: String,
    /// Optional bibliography file (.bib or .csl-json). When set we pass
    /// `--citeproc --bibliography=<path>`.
    pub bibliography: Option<String>,
    /// Optional CSL style file. When set we pass `--csl=<path>` (only
    /// effective if `bibliography` is also set).
    pub csl: Option<String>,
    /// Optional pandoc template file (`--template=<path>`).
    pub template: Option<String>,
    /// Free-form extra args appended verbatim. Use with care; the user is
    /// responsible for shell-safety. We do **not** invoke a shell, so each
    /// element is a single argv entry.
    pub extra_args: Vec<String>,
}

/// Look up `pandoc` on PATH. We prefer the `which`/`where` shellouts here
/// over pulling in the `which` crate — the cost is one extra Command spawn
/// at app start (or first export) which is negligible, and we keep the
/// dependency graph small (no new crates in Cargo.toml in this worktree).
#[tauri::command]
pub fn pandoc_detect() -> Result<Option<PandocInfo>, String> {
    let path = match locate_pandoc() {
        Some(p) => p,
        None => return Ok(None),
    };

    // Read `pandoc --version` to confirm it's actually pandoc and not a
    // broken shim. First line looks like "pandoc 3.1.11.1".
    let out = Command::new(&path)
        .arg("--version")
        .output()
        .map_err(|e| format!("pandoc found at {path:?} but failed to run: {e}"))?;
    if !out.status.success() {
        return Err(format!(
            "pandoc at {:?} returned non-zero on --version",
            path
        ));
    }
    let stdout = String::from_utf8_lossy(&out.stdout);
    let first_line = stdout.lines().next().unwrap_or("").trim();
    let version = first_line
        .strip_prefix("pandoc ")
        .unwrap_or(first_line)
        .to_string();

    Ok(Some(PandocInfo {
        path: path.to_string_lossy().to_string(),
        version,
    }))
}

#[cfg(not(target_os = "windows"))]
fn locate_pandoc() -> Option<PathBuf> {
    // Try `which` (POSIX). Don't use a shell — direct exec keeps PATH
    // semantics inherited from the Tauri app process.
    let out = Command::new("which").arg("pandoc").output().ok()?;
    if !out.status.success() {
        return None;
    }
    let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if s.is_empty() {
        // Fallback: probe a few common install locations. macOS GUI apps
        // started outside a terminal often have a stripped-down PATH that
        // misses `/opt/homebrew/bin` and `/usr/local/bin`.
        for candidate in [
            "/opt/homebrew/bin/pandoc",
            "/usr/local/bin/pandoc",
            "/usr/bin/pandoc",
        ] {
            if std::path::Path::new(candidate).is_file() {
                return Some(PathBuf::from(candidate));
            }
        }
        return None;
    }
    Some(PathBuf::from(s))
}

#[cfg(target_os = "windows")]
fn locate_pandoc() -> Option<PathBuf> {
    // `where pandoc` may print multiple lines — first hit wins.
    let out = Command::new("where").arg("pandoc").output().ok()?;
    if !out.status.success() {
        return None;
    }
    let stdout = String::from_utf8_lossy(&out.stdout);
    let first = stdout.lines().next().unwrap_or("").trim().to_string();
    if first.is_empty() {
        return None;
    }
    Some(PathBuf::from(first))
}

/// Run a Pandoc conversion. We always go through a temp file rather than
/// piping to stdin so pandoc's `--citeproc` resource resolver picks up
/// relative paths correctly (it resolves relative to the input file).
#[tauri::command]
pub fn pandoc_export(args: ExportArgs) -> Result<(), String> {
    let pandoc_path = match locate_pandoc() {
        Some(p) => p,
        None => {
            return Err(
                "Pandoc not found on PATH. Install pandoc (https://pandoc.org/installing.html) and retry."
                    .into(),
            );
        }
    };

    // Write input markdown to a temp .md file. We do this manually rather
    // than use a tempfile crate — std::env::temp_dir + a unique name based
    // on the system clock is good enough for a one-shot export.
    let tmp_dir = std::env::temp_dir();
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let tmp_path = tmp_dir.join(format!("solomd-pandoc-{stamp}.md"));
    std::fs::write(&tmp_path, args.input_markdown.as_bytes())
        .map_err(|e| format!("could not write temp input file: {e}"))?;

    // Build argv.
    let mut cmd = Command::new(&pandoc_path);
    cmd.arg(&tmp_path);
    cmd.arg("-o").arg(&args.output_path);

    if let Some(bib) = args.bibliography.as_deref().filter(|s| !s.is_empty()) {
        cmd.arg("--citeproc");
        cmd.arg(format!("--bibliography={bib}"));
        if let Some(csl) = args.csl.as_deref().filter(|s| !s.is_empty()) {
            cmd.arg(format!("--csl={csl}"));
        }
    }

    if let Some(tpl) = args.template.as_deref().filter(|s| !s.is_empty()) {
        cmd.arg(format!("--template={tpl}"));
    }

    for extra in &args.extra_args {
        if !extra.is_empty() {
            cmd.arg(extra);
        }
    }

    // Make sure pandoc resolves relative paths (e.g. images) from the
    // *output* directory rather than our temp dir. `--resource-path` would
    // be cleaner but requires the user's source directory which we don't
    // have at this layer; the temp dir + absolute output_path gets us 95%.
    let exec_result = cmd.output();

    // Always clean up the temp file, even on failure.
    let _ = std::fs::remove_file(&tmp_path);

    let out = exec_result.map_err(|e| format!("failed to run pandoc: {e}"))?;
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
        let stdout = String::from_utf8_lossy(&out.stdout).trim().to_string();
        let detail = if !stderr.is_empty() {
            stderr
        } else if !stdout.is_empty() {
            stdout
        } else {
            format!("exit code {:?}", out.status.code())
        };
        return Err(format!("pandoc failed: {detail}"));
    }
    Ok(())
}
