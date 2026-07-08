use app_lib::search::{search_in_dir_inner as search_in_dir, SearchHit};
use std::fs;
use std::sync::Once;

/// One-time fixture setup — older versions of these tests assumed an
/// externally-populated `/tmp/solomd-search-test` and silently passed
/// zero hits when the dir didn't exist. Always create it ourselves so the
/// suite is deterministic.
static FIXTURE: Once = Once::new();
fn ensure_fixture() {
    FIXTURE.call_once(|| {
        let root = "/tmp/solomd-search-test";
        let _ = fs::remove_dir_all(root);
        fs::create_dir_all(root).unwrap();
        fs::write(format!("{root}/search_test.md"),
            "# Search Test\n\nThe needle in the haystack.\nNothing here.\n").unwrap();
        fs::write(format!("{root}/other.md"),
            "Some other note. The needle pops up again.\n").unwrap();
        fs::write(format!("{root}/notes.txt"),
            "plain text. needle should be findable here too.\n").unwrap();
        fs::write(format!("{root}/binary.png"), b"fake png bytes").unwrap();
    });
}

#[test]
fn finds_needle_across_files() {
    ensure_fixture();
    let hits: Vec<SearchHit> =
        search_in_dir("/tmp/solomd-search-test".to_string(), "needle".to_string(), 100).unwrap();
    println!("hits: {:#?}", hits);
    assert!(hits.len() >= 3, "expected >=3 hits, got {}", hits.len());
    assert!(hits.iter().any(|h| h.file.ends_with("search_test.md")));
    assert!(hits.iter().any(|h| h.file.ends_with("other.md")));
    assert!(hits.iter().any(|h| h.file.ends_with("notes.txt")));
}

#[test]
fn case_insensitive() {
    ensure_fixture();
    let hits = search_in_dir("/tmp/solomd-search-test".to_string(), "NEEDLE".to_string(), 100).unwrap();
    assert!(hits.len() >= 3);
}

#[test]
fn empty_query_returns_empty() {
    ensure_fixture();
    let hits = search_in_dir("/tmp/solomd-search-test".to_string(), "".to_string(), 100).unwrap();
    assert_eq!(hits.len(), 0);
}

#[test]
fn respects_max_results() {
    ensure_fixture();
    let hits = search_in_dir("/tmp/solomd-search-test".to_string(), "the".to_string(), 2).unwrap();
    assert!(hits.len() <= 2);
}
