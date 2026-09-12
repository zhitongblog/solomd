//! #290 / #267 — moving files and folders from the file tree.
//!
//! The path math (what a relative link becomes after its note moves) is the
//! part that silently corrupts notes if it's wrong, so it's tested directly
//! as well as through the real filesystem.

use app_lib::commands::{
    abs_segments, fs_move_inner, lexical_relative, lexical_resolve, rewrite_links_after_move,
};
use std::fs;
use std::path::{Path, PathBuf};

fn tmp(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("solomd-move-{name}"));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    dir
}

fn segs(p: &str) -> Vec<String> {
    abs_segments(Path::new(p))
}

// --------------------------------------------------------------------------
// Pure path math
// --------------------------------------------------------------------------

#[test]
fn resolve_and_relativize_round_trip() {
    let base = segs("/vault/notes");
    assert_eq!(lexical_resolve(&base, "_assets/a.png").unwrap(), segs("/vault/notes/_assets/a.png"));
    assert_eq!(lexical_resolve(&base, "../top.md").unwrap(), segs("/vault/top.md"));
    assert_eq!(lexical_resolve(&base, "./x/./y.md").unwrap(), segs("/vault/notes/x/y.md"));
    // Climbing above the root is refused rather than guessed at.
    assert!(lexical_resolve(&segs("/a"), "../../../x").is_none());

    assert_eq!(lexical_relative(&segs("/vault/notes/sub"), &segs("/vault/notes/_assets/a.png")), "../_assets/a.png");
    assert_eq!(lexical_relative(&segs("/vault"), &segs("/vault/a/b.md")), "a/b.md");
    assert_eq!(lexical_relative(&segs("/vault/a"), &segs("/vault/a")), ".");
}

#[test]
fn note_moved_one_level_down_keeps_its_images() {
    let old_dir = segs("/vault");
    let new_dir = segs("/vault/sub");
    let moved = vec![segs("/vault/note.md")];
    let body = "![](_assets/a.png)\nSee [other](other.md) and [up](../outside.md).\n";
    let out = rewrite_links_after_move(body, &old_dir, &new_dir, &moved).unwrap();
    assert_eq!(
        out,
        "![](../_assets/a.png)\nSee [other](../other.md) and [up](../../outside.md).\n"
    );
}

#[test]
fn targets_that_moved_along_are_left_alone() {
    let old_dir = segs("/vault");
    let new_dir = segs("/vault/sub");
    // The per-file assets folder travels with the note.
    let moved = vec![segs("/vault/note.md"), segs("/vault/note.assets")];
    let body = "![](note.assets/a.png)\n";
    assert!(rewrite_links_after_move(body, &old_dir, &new_dir, &moved).is_none());
}

#[test]
fn external_targets_anchors_and_titles_survive() {
    let old_dir = segs("/vault");
    let new_dir = segs("/vault/sub");
    let moved = vec![segs("/vault/note.md")];
    let body = concat!(
        "[web](https://example.com/a.png) [mail](mailto:a@b.c) [anchor](#top)\n",
        "[abs](/rooted.md) ![t](_assets/a.png \"A title\") [ang](<my file.md>)\n",
        "[frag](other.md#heading)\n",
    );
    let out = rewrite_links_after_move(body, &old_dir, &new_dir, &moved).unwrap();
    assert!(out.contains("[web](https://example.com/a.png)"));
    assert!(out.contains("[mail](mailto:a@b.c)"));
    assert!(out.contains("[anchor](#top)"));
    assert!(out.contains("[abs](/rooted.md)"));
    assert!(out.contains("![t](../_assets/a.png \"A title\")"));
    assert!(out.contains("[ang](<../my file.md>)"));
    assert!(out.contains("[frag](../other.md#heading)"));
}

#[test]
fn code_is_not_rewritten() {
    let old_dir = segs("/vault");
    let new_dir = segs("/vault/sub");
    let moved = vec![segs("/vault/note.md")];
    let body = "```md\n[x](a.md)\n```\nprose `[x](a.md)` stays\n";
    assert!(rewrite_links_after_move(body, &old_dir, &new_dir, &moved).is_none());
}

#[test]
fn reference_definitions_and_html_src_are_rewritten() {
    let old_dir = segs("/vault");
    let new_dir = segs("/vault/sub");
    let moved = vec![segs("/vault/note.md")];
    let body = "[id]: _assets/a.png\n<img src=\"_assets/b.png\">\n";
    let out = rewrite_links_after_move(body, &old_dir, &new_dir, &moved).unwrap();
    assert_eq!(out, "[id]: ../_assets/a.png\n<img src=\"../_assets/b.png\">\n");
}

// --------------------------------------------------------------------------
// Real filesystem
// --------------------------------------------------------------------------

#[test]
fn moves_a_file_and_re_anchors_its_links() {
    let root = tmp("file");
    fs::create_dir_all(root.join("_assets")).unwrap();
    fs::create_dir_all(root.join("sub")).unwrap();
    fs::write(root.join("_assets/a.png"), b"png").unwrap();
    fs::write(root.join("note.md"), "![](_assets/a.png)\n").unwrap();

    fs_move_inner(
        root.join("note.md").to_string_lossy().to_string(),
        root.join("sub/note.md").to_string_lossy().to_string(),
    )
    .unwrap();

    assert!(!root.join("note.md").exists());
    assert_eq!(
        fs::read_to_string(root.join("sub/note.md")).unwrap(),
        "![](../_assets/a.png)\n"
    );
}

#[test]
fn per_file_assets_folder_travels_with_the_note() {
    let root = tmp("assets");
    fs::create_dir_all(root.join("note.assets")).unwrap();
    fs::create_dir_all(root.join("sub")).unwrap();
    fs::write(root.join("note.assets/a.png"), b"png").unwrap();
    fs::write(root.join("note.md"), "![](note.assets/a.png)\n").unwrap();

    fs_move_inner(
        root.join("note.md").to_string_lossy().to_string(),
        root.join("sub/note.md").to_string_lossy().to_string(),
    )
    .unwrap();

    assert!(root.join("sub/note.assets/a.png").is_file());
    assert!(!root.join("note.assets").exists());
    // Unchanged: the folder moved too.
    assert_eq!(
        fs::read_to_string(root.join("sub/note.md")).unwrap(),
        "![](note.assets/a.png)\n"
    );
}

#[test]
fn moves_a_folder_and_keeps_internal_links_intact() {
    let root = tmp("folder");
    fs::create_dir_all(root.join("proj/deep")).unwrap();
    fs::create_dir_all(root.join("dest")).unwrap();
    fs::create_dir_all(root.join("_assets")).unwrap();
    fs::write(root.join("_assets/a.png"), b"png").unwrap();
    fs::write(root.join("proj/one.md"), "[two](deep/two.md)\n![](../_assets/a.png)\n").unwrap();
    fs::write(root.join("proj/deep/two.md"), "[one](../one.md)\n").unwrap();

    fs_move_inner(
        root.join("proj").to_string_lossy().to_string(),
        root.join("dest/proj").to_string_lossy().to_string(),
    )
    .unwrap();

    // Links between two files that moved together are untouched…
    assert_eq!(
        fs::read_to_string(root.join("dest/proj/deep/two.md")).unwrap(),
        "[one](../one.md)\n"
    );
    // …while the one pointing outside the moved folder is re-anchored.
    assert_eq!(
        fs::read_to_string(root.join("dest/proj/one.md")).unwrap(),
        "[two](deep/two.md)\n![](../../_assets/a.png)\n"
    );
}

#[test]
fn refuses_a_collision_a_missing_source_and_a_folder_into_itself() {
    let root = tmp("guards");
    fs::create_dir_all(root.join("a/b")).unwrap();
    fs::write(root.join("a/note.md"), "x").unwrap();
    fs::write(root.join("taken.md"), "y").unwrap();

    let err = fs_move_inner(
        root.join("a/note.md").to_string_lossy().to_string(),
        root.join("taken.md").to_string_lossy().to_string(),
    )
    .unwrap_err();
    assert!(err.contains("already exists"), "{err}");
    // The collision must not have eaten the source.
    assert!(root.join("a/note.md").is_file());
    assert_eq!(fs::read_to_string(root.join("taken.md")).unwrap(), "y");

    let err = fs_move_inner(
        root.join("a/gone.md").to_string_lossy().to_string(),
        root.join("b.md").to_string_lossy().to_string(),
    )
    .unwrap_err();
    assert!(err.contains("source missing"), "{err}");

    let err = fs_move_inner(
        root.join("a").to_string_lossy().to_string(),
        root.join("a/b/a").to_string_lossy().to_string(),
    )
    .unwrap_err();
    assert!(err.contains("inside itself"), "{err}");
    assert!(root.join("a/note.md").is_file());
}

// --------------------------------------------------------------------------
// Listing: hidden entries and the "Move to…" picker's folder list
// --------------------------------------------------------------------------

#[test]
fn hidden_entries_are_listed_only_when_asked_for() {
    use app_lib::commands::list_dir_inner;
    let root = tmp("hidden");
    fs::create_dir_all(root.join(".config")).unwrap();
    fs::write(root.join(".gitignore"), b"x").unwrap();
    fs::write(root.join("visible.md"), b"x").unwrap();

    let plain = list_dir_inner(root.to_string_lossy().to_string(), false).unwrap();
    assert_eq!(
        plain.iter().map(|e| e.name.as_str()).collect::<Vec<_>>(),
        vec!["visible.md"]
    );

    let all = list_dir_inner(root.to_string_lossy().to_string(), true).unwrap();
    let names: Vec<&str> = all.iter().map(|e| e.name.as_str()).collect();
    // Dirs still sort ahead of files.
    assert_eq!(names, vec![".config", ".gitignore", "visible.md"]);
}

#[test]
fn the_folder_picker_prunes_junk_and_follows_the_hidden_setting() {
    use app_lib::commands::fs_list_dirs_inner;
    let root = tmp("dirs");
    for d in [
        "Notes/Deep",
        "_assets/nested",
        "note.assets",
        "node_modules/pkg",
        ".git/objects",
        ".config",
    ] {
        fs::create_dir_all(root.join(d)).unwrap();
    }

    let plain = fs_list_dirs_inner(root.to_string_lossy().to_string(), false).unwrap();
    assert_eq!(plain, vec!["Notes", "Notes/Deep"]);

    let with_hidden = fs_list_dirs_inner(root.to_string_lossy().to_string(), true).unwrap();
    // `.config` shows up, `.git` never does — walking an object store to fill
    // a picker is pure cost.
    assert_eq!(with_hidden, vec![".config", "Notes", "Notes/Deep"]);
}

// --------------------------------------------------------------------------
// #282 — the file-tree extension filter
// --------------------------------------------------------------------------

#[test]
fn extensions_are_counted_most_common_first() {
    use app_lib::commands::fs_list_extensions_inner;
    let root = tmp("exts");
    fs::create_dir_all(root.join("sub")).unwrap();
    fs::create_dir_all(root.join(".git")).unwrap();
    fs::create_dir_all(root.join("node_modules")).unwrap();
    for f in ["a.md", "b.md", "c.txt", "Makefile", "d.MD"] {
        fs::write(root.join(f), b"x").unwrap();
    }
    fs::write(root.join("sub/e.md"), b"x").unwrap();
    fs::write(root.join(".hidden.md"), b"x").unwrap();
    fs::write(root.join(".git/config"), b"x").unwrap();
    fs::write(root.join("node_modules/pkg.json"), b"x").unwrap();

    let got = fs_list_extensions_inner(root.to_string_lossy().to_string(), false).unwrap();
    let pairs: Vec<(&str, usize)> = got.iter().map(|e| (e.ext.as_str(), e.count)).collect();
    // `.MD` folds into `md`; no-extension files get their own bucket; the
    // hidden file, .git and node_modules are all out.
    assert_eq!(pairs, vec![("md", 4), ("", 1), ("txt", 1)]);

    let with_hidden = fs_list_extensions_inner(root.to_string_lossy().to_string(), true).unwrap();
    assert_eq!(
        with_hidden.iter().find(|e| e.ext == "md").map(|e| e.count),
        Some(5)
    );
}

#[test]
fn dirs_with_extensions_reports_every_ancestor_of_a_match() {
    use app_lib::commands::fs_dirs_with_extensions_inner;
    let root = tmp("extdirs");
    fs::create_dir_all(root.join("a/b/c")).unwrap();
    fs::create_dir_all(root.join("only-md")).unwrap();
    fs::create_dir_all(root.join("empty")).unwrap();
    fs::write(root.join("a/b/c/deep.txt"), b"x").unwrap();
    fs::write(root.join("only-md/note.md"), b"x").unwrap();
    fs::write(root.join("top.txt"), b"x").unwrap();

    let dirs = fs_dirs_with_extensions_inner(
        root.to_string_lossy().to_string(),
        vec!["txt".to_string()],
        false,
    )
    .unwrap();
    // The whole chain above the match is kept; folders holding only .md or
    // nothing at all are not. A match at the vault root adds no entry.
    assert_eq!(dirs, vec!["a", "a/b", "a/b/c"]);

    // A leading dot on the requested extension is accepted.
    let dotted = fs_dirs_with_extensions_inner(
        root.to_string_lossy().to_string(),
        vec![".MD".to_string()],
        false,
    )
    .unwrap();
    assert_eq!(dotted, vec!["only-md"]);

    let none = fs_dirs_with_extensions_inner(
        root.to_string_lossy().to_string(),
        vec!["canvas".to_string()],
        false,
    )
    .unwrap();
    assert!(none.is_empty());
}
