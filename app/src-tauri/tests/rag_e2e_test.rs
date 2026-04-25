//! End-to-end test for the v2.3 local RAG / semantic-search flow.
//!
//! Drives the public sync impls in `rag` against a real temp workspace.
//! No Tauri runtime needed. If chunking, embedding, persistence, or
//! ranking regress, this catches it before the UI does.

use app_lib::rag::{
    rag_index_status_inner, rag_reindex_file_inner, rag_reindex_inner, rag_search_inner,
    rag_set_enabled_inner,
};
use std::fs;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

fn fresh_workspace(label: &str) -> PathBuf {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let dir = std::env::temp_dir().join(format!("solomd-rag-{label}-{nanos}"));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    dir
}

fn write(dir: &PathBuf, name: &str, content: &str) -> PathBuf {
    let p = dir.join(name);
    fs::write(&p, content).unwrap();
    p
}

#[test]
fn rag_full_flow_index_then_search_ranks_relevant_first() {
    let ws = fresh_workspace("flow");
    let folder = ws.to_string_lossy().to_string();

    // Three notes on different topics. One mentions encryption; one is
    // about翻译 / translation in Chinese; one is unrelated.
    write(
        &ws,
        "encryption.md",
        "# Encryption\n\nWe use AES-256 encryption to secure files at rest. The key is\nstored in the OS keychain so even malware can't read it.\n",
    );
    write(
        &ws,
        "translate.md",
        "# 翻译笔记\n\n本文档讲的是把英文翻译成中文的常见误区,以及如何让译文更自然。\n常用的工具包括 DeepL 和 Google Translate。\n",
    );
    write(
        &ws,
        "weather.md",
        "# Weather diary\n\nToday it rained heavily in the afternoon. I stayed inside and read a book.\nTomorrow looks sunny.\n",
    );

    // Initial status: index not built yet.
    let st = rag_index_status_inner(folder.clone()).expect("status");
    assert_eq!(st.total_files, 3, "scanner should see 3 markdown files");

    // Enable + reindex.
    let st = rag_set_enabled_inner(folder.clone(), true).expect("enable");
    assert!(st.enabled);
    assert!(st.ready, "index should be ready after enable");
    assert_eq!(st.indexed_files, 3, "all 3 files should be indexed");
    assert!(st.total_chunks >= 3, "expected at least one chunk per file");

    // Search 1: English keyword that exists ONLY in encryption.md.
    let hits = rag_search_inner(folder.clone(), "encryption".into(), 5).unwrap();
    assert!(!hits.is_empty(), "search should return at least one hit");
    assert!(
        hits[0].path.ends_with("encryption.md"),
        "encryption.md should rank first for query 'encryption', got: {}",
        hits[0].path
    );

    // Search 2: Chinese keyword 翻译 should rank translate.md first.
    let hits_zh = rag_search_inner(folder.clone(), "翻译".into(), 5).unwrap();
    assert!(!hits_zh.is_empty(), "zh search should return hits");
    assert!(
        hits_zh[0].path.ends_with("translate.md"),
        "translate.md should rank first for '翻译', got: {}",
        hits_zh[0].path
    );

    // Search 3: morphology — "encrypt" (without "ion") should still rank
    // encryption.md higher than weather.md. This is the core of the
    // "semantic, not just keyword" promise.
    let hits_morph = rag_search_inner(folder.clone(), "encrypt".into(), 5).unwrap();
    let enc_score = hits_morph
        .iter()
        .find(|h| h.path.ends_with("encryption.md"))
        .map(|h| h.score)
        .unwrap_or(f32::MIN);
    let weather_score = hits_morph
        .iter()
        .find(|h| h.path.ends_with("weather.md"))
        .map(|h| h.score)
        .unwrap_or(f32::MIN);
    assert!(
        enc_score > weather_score,
        "encryption.md ({}) should outrank weather.md ({}) for 'encrypt'",
        enc_score,
        weather_score
    );

    // .gitignore should now contain `.solomd/` so AutoGit skips the index.
    let gi = fs::read_to_string(ws.join(".gitignore")).unwrap_or_default();
    assert!(
        gi.lines().any(|l| l.trim() == ".solomd/"),
        "gitignore should mention .solomd/, got:\n{}",
        gi
    );

    // Sqlite index file should be where we promised.
    assert!(
        ws.join(".solomd").join("embeddings.sqlite").exists(),
        ".solomd/embeddings.sqlite should exist"
    );

    let _ = fs::remove_dir_all(&ws);
}

#[test]
fn rag_incremental_update_picks_up_new_file() {
    let ws = fresh_workspace("inc");
    let folder = ws.to_string_lossy().to_string();
    write(&ws, "a.md", "Apples are crunchy.\n");
    let _ = rag_set_enabled_inner(folder.clone(), true).unwrap();

    // New file appears later — incremental indexer should pick it up
    // either via reindex_inner (called by watcher debounce in production)
    // or via rag_reindex_file_inner for a single-file rescan.
    let new_path = write(&ws, "b.md", "Bananas are yellow and rich in potassium.\n");
    rag_reindex_file_inner(folder.clone(), new_path.to_string_lossy().to_string())
        .expect("incremental reindex of single file");

    let hits = rag_search_inner(folder.clone(), "potassium".into(), 5).unwrap();
    assert!(
        hits.iter().any(|h| h.path.ends_with("b.md")),
        "b.md should appear in hits after incremental reindex; hits: {:?}",
        hits.iter().map(|h| &h.path).collect::<Vec<_>>()
    );

    let _ = fs::remove_dir_all(&ws);
}

#[test]
fn rag_disabled_by_default_no_overhead() {
    let ws = fresh_workspace("off");
    let folder = ws.to_string_lossy().to_string();
    write(&ws, "x.md", "anything\n");

    // Status without enabling: shouldn't have built anything.
    let st = rag_index_status_inner(folder.clone()).unwrap();
    // The shared module-global state may report `enabled=true` from the
    // earlier tests in this binary — what we care about is `ready=false`
    // and that no DB has been created at this folder.
    assert!(
        !st.ready,
        "fresh workspace should not be ready before reindex"
    );
    assert!(
        !ws.join(".solomd").exists(),
        ".solomd should NOT exist before enable"
    );

    let _ = fs::remove_dir_all(&ws);
}

#[test]
fn rag_search_on_empty_query_returns_empty() {
    let ws = fresh_workspace("empty");
    let folder = ws.to_string_lossy().to_string();
    write(&ws, "x.md", "hello\n");
    let _ = rag_reindex_inner(folder.clone()).unwrap();

    let hits = rag_search_inner(folder.clone(), "   ".into(), 5).unwrap();
    assert!(hits.is_empty(), "empty/whitespace query should yield no hits");

    let _ = fs::remove_dir_all(&ws);
}
