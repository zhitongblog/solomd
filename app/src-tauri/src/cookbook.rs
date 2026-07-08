//! v4.0 — Recipe cookbook.
//!
//! Bundled YAML recipe templates the user can copy into their workspace
//! with one click from Settings → Recipes → "Browse cookbook". Templates
//! live under `app/src-tauri/cookbook/*.yml` and are baked into the binary
//! via `include_str!`, so we don't depend on the Tauri resource bundle (no
//! extra build wiring, no AppImage / dmg / nsis path differences to handle).
//!
//! Each entry is parsed once via `recipes::parse_recipe` so we can surface
//! `name` / `trigger` / `provider` / `match_glob` / `allow_write` to the UI
//! without re-implementing the schema. Install copies the raw YAML verbatim
//! into `<workspace>/.solomd/agents/<slug>.yml` (or `<slug>-N.yml` if the
//! user already installed that recipe).

use std::path::PathBuf;

use serde::Serialize;
use serde_json::json;

use super::recipes;

/// One bundled recipe. The raw YAML lives in the binary; metadata fields
/// are parsed from it on demand.
struct Bundled {
    /// Human-readable filename (no extension) — also doubles as the
    /// install-suggestion stem before we slugify the actual recipe name.
    file_stem: &'static str,
    /// Raw YAML source.
    yaml: &'static str,
}

/// Compile-time embed of every cookbook entry. Keep this list in
/// alphabetical-ish order matching the file numbering on disk.
const BUNDLED: &[Bundled] = &[
    Bundled {
        file_stem: "01-weekly-review",
        yaml: include_str!("../cookbook/01-weekly-review.yml"),
    },
    Bundled {
        file_stem: "02-todo-extract",
        yaml: include_str!("../cookbook/02-todo-extract.yml"),
    },
    Bundled {
        file_stem: "03-translate-zh-to-en",
        yaml: include_str!("../cookbook/03-translate-zh-to-en.yml"),
    },
    Bundled {
        file_stem: "04-cjk-proofread",
        yaml: include_str!("../cookbook/04-cjk-proofread.yml"),
    },
    Bundled {
        file_stem: "05-citation-cleanup",
        yaml: include_str!("../cookbook/05-citation-cleanup.yml"),
    },
    Bundled {
        file_stem: "06-meeting-notes-summary",
        yaml: include_str!("../cookbook/06-meeting-notes-summary.yml"),
    },
    Bundled {
        file_stem: "07-link-suggester",
        yaml: include_str!("../cookbook/07-link-suggester.yml"),
    },
    Bundled {
        file_stem: "08-daily-summary",
        yaml: include_str!("../cookbook/08-daily-summary.yml"),
    },
    Bundled {
        file_stem: "09-orphan-notes",
        yaml: include_str!("../cookbook/09-orphan-notes.yml"),
    },
    Bundled {
        file_stem: "10-on-commit-changelog",
        yaml: include_str!("../cookbook/10-on-commit-changelog.yml"),
    },
    Bundled {
        file_stem: "11-tag-classifier",
        yaml: include_str!("../cookbook/11-tag-classifier.yml"),
    },
];

#[derive(Debug, Clone, Serialize)]
pub struct CookbookEntry {
    pub file_stem: String,
    pub name: String,
    pub trigger: String,
    pub allow_write: bool,
    pub provider: String,
    pub schedule: Option<String>,
    pub match_glob: Option<String>,
    /// First non-empty line of the prompt — used as a one-line description.
    pub description: String,
    /// Raw YAML; also returned by `cookbook_get` so the UI can show a
    /// preview before the user commits to the install.
    pub yaml: String,
}

fn entry_for(b: &Bundled) -> CookbookEntry {
    // We parse to surface metadata. Bundled recipes ship known-valid, but
    // we still fall back gracefully if a dev breaks one mid-edit.
    let parsed = recipes::parse_recipe(b.yaml, None).ok();
    let (name, trigger, allow_write, provider, schedule, match_glob) = match &parsed {
        Some(r) => (
            r.name.clone(),
            r.trigger.as_str().to_string(),
            r.allow_write,
            r.provider.clone(),
            r.schedule.clone(),
            r.match_glob.clone(),
        ),
        None => (
            b.file_stem.to_string(),
            "manual".to_string(),
            false,
            String::new(),
            None,
            None,
        ),
    };
    let description = first_prompt_line(b.yaml);
    CookbookEntry {
        file_stem: b.file_stem.to_string(),
        name,
        trigger,
        allow_write,
        provider,
        schedule,
        match_glob,
        description,
        yaml: b.yaml.to_string(),
    }
}

/// Pull the first non-empty line of the `prompt:` block out of the YAML.
/// Crude but does the job for the cookbook list — the raw YAML is right
/// there for users who want the full picture.
fn first_prompt_line(yaml: &str) -> String {
    let mut in_prompt = false;
    for line in yaml.lines() {
        let trimmed = line.trim_start();
        if !in_prompt {
            if trimmed.starts_with("prompt:") {
                in_prompt = true;
            }
            continue;
        }
        if trimmed.is_empty() {
            continue;
        }
        // Inside the literal block; first non-empty body line wins.
        let cleaned = trimmed.trim_start_matches('|').trim();
        if cleaned.is_empty() {
            continue;
        }
        // Truncate so a verbose prompt doesn't blow up the UI row.
        let mut out: String = cleaned.chars().take(120).collect();
        if cleaned.chars().count() > 120 {
            out.push('…');
        }
        return out;
    }
    String::new()
}

#[tauri::command]
pub fn cookbook_list() -> Vec<CookbookEntry> {
    BUNDLED.iter().map(entry_for).collect()
}

#[tauri::command]
pub fn cookbook_get(file_stem: String) -> Result<CookbookEntry, String> {
    BUNDLED
        .iter()
        .find(|b| b.file_stem == file_stem)
        .map(entry_for)
        .ok_or_else(|| format!("cookbook entry not found: {file_stem}"))
}

/// Install a cookbook entry into `<workspace>/.solomd/agents/<slug>.yml`.
/// On filename collision we suffix with `-2`, `-3`, … so the user can
/// install multiple variants without confirmation prompts. Returns the
/// final on-disk path so the UI can reveal it.
#[tauri::command]
pub fn cookbook_install(workspace: String, file_stem: String) -> Result<String, String> {
    let bundled = BUNDLED
        .iter()
        .find(|b| b.file_stem == file_stem)
        .ok_or_else(|| format!("cookbook entry not found: {file_stem}"))?;

    // Parse so we have a clean slug for the destination filename.
    let parsed = recipes::parse_recipe(bundled.yaml, None)
        .map_err(|e| format!("parse cookbook entry: {e}"))?;

    let ws = PathBuf::from(workspace);
    if !ws.is_dir() {
        return Err(format!("workspace not found: {}", ws.display()));
    }
    let dir = ws.join(".solomd").join("agents");
    std::fs::create_dir_all(&dir).map_err(|e| format!("mkdir {}: {e}", dir.display()))?;

    let mut candidate = dir.join(format!("{}.yml", parsed.slug));
    let mut n = 2;
    while candidate.exists() {
        candidate = dir.join(format!("{}-{}.yml", parsed.slug, n));
        n += 1;
        if n > 100 {
            return Err("too many copies of this recipe already installed".into());
        }
    }
    std::fs::write(&candidate, bundled.yaml)
        .map_err(|e| format!("write {}: {e}", candidate.display()))?;
    Ok(candidate.to_string_lossy().to_string())
}

/// Convenience accessor used by the integration test.
#[allow(dead_code)]
pub fn _entries_json() -> serde_json::Value {
    json!(cookbook_list())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn list_returns_at_least_ten_entries() {
        let entries = cookbook_list();
        assert!(
            entries.len() >= 10,
            "cookbook should ship 10+ recipes, has {}",
            entries.len()
        );
    }

    #[test]
    fn every_bundled_recipe_parses() {
        for b in BUNDLED {
            let parsed = recipes::parse_recipe(b.yaml, None);
            assert!(
                parsed.is_ok(),
                "bundled recipe {} failed to parse: {:?}",
                b.file_stem,
                parsed.err()
            );
        }
    }

    #[test]
    fn install_writes_to_workspace_agents_dir() {
        let tmp = std::env::temp_dir().join(format!(
            "solomd-cookbook-test-{}",
            super::super::agent_run::mint_run_id()
        ));
        std::fs::create_dir_all(&tmp).unwrap();
        let stem = BUNDLED[0].file_stem.to_string();
        let written = cookbook_install(tmp.to_string_lossy().to_string(), stem.clone()).unwrap();
        assert!(std::path::Path::new(&written).exists());

        // Re-installing should produce a -2 variant rather than overwriting.
        let written2 = cookbook_install(tmp.to_string_lossy().to_string(), stem).unwrap();
        assert_ne!(written, written2);
        assert!(written2.ends_with("-2.yml"));
        let _ = std::fs::remove_dir_all(&tmp);
    }
}
