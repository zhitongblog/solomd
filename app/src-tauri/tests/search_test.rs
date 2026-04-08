use app_lib::search::{search_in_dir, SearchHit};

#[test]
fn finds_needle_across_files() {
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
    let hits = search_in_dir("/tmp/solomd-search-test".to_string(), "NEEDLE".to_string(), 100).unwrap();
    assert!(hits.len() >= 3);
}

#[test]
fn empty_query_returns_empty() {
    let hits = search_in_dir("/tmp/solomd-search-test".to_string(), "".to_string(), 100).unwrap();
    assert_eq!(hits.len(), 0);
}

#[test]
fn respects_max_results() {
    let hits = search_in_dir("/tmp/solomd-search-test".to_string(), "the".to_string(), 2).unwrap();
    assert!(hits.len() <= 2);
}
