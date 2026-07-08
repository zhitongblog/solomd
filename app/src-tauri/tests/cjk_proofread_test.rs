//! Integration tests for v2.5 F6 CJK proofread.
//!
//! Each test is named after the issue category it covers. We assert
//! both the **flag** and the **fix preview** so changes to the
//! suggestion text break loudly.

use app_lib::cjk_proofread::proofread;

// ---------------------------------------------------------------------------
// Category 1 — half-width punctuation in CJK context (high)
// ---------------------------------------------------------------------------

#[test]
fn halfwidth_comma_after_han_flagged() {
    let issues = proofread("汉字,后面");
    let punct: Vec<_> = issues
        .iter()
        .filter(|i| i.category == "punct_halfwidth")
        .collect();
    assert_eq!(punct.len(), 1, "expected one halfwidth flag, got {issues:#?}");
    let issue = punct[0];
    assert_eq!(issue.severity, "high");
    assert_eq!(issue.original, ",");
    assert_eq!(issue.suggestion, "，");
}

#[test]
fn halfwidth_question_after_han_flagged() {
    let issues = proofread("你好?");
    let punct: Vec<_> = issues
        .iter()
        .filter(|i| i.category == "punct_halfwidth")
        .collect();
    assert_eq!(punct.len(), 1);
    assert_eq!(punct[0].suggestion, "？");
}

// ---------------------------------------------------------------------------
// Category 2 — Latin quotes wrapping Han (high)
// ---------------------------------------------------------------------------

#[test]
fn latin_double_quotes_wrapping_han_flagged() {
    let issues = proofread("他说\"汉字\"很有趣");
    let q: Vec<_> = issues
        .iter()
        .filter(|i| i.category == "latin_quotes")
        .collect();
    assert_eq!(q.len(), 1, "expected one quote flag, issues={issues:#?}");
    assert_eq!(q[0].severity, "high");
    assert_eq!(q[0].original, "\"汉字\"");
    assert_eq!(q[0].suggestion, "“汉字”");
}

// ---------------------------------------------------------------------------
// Category 3 — 的/地/得 misuse (medium)
// ---------------------------------------------------------------------------

#[test]
fn feichang_de_followed_by_han_flagged_as_di() {
    let issues = proofread("非常的精彩");
    let de: Vec<_> = issues
        .iter()
        .filter(|i| i.category == "de_misuse")
        .collect();
    assert_eq!(de.len(), 1, "expected one de_misuse flag, issues={issues:#?}");
    assert_eq!(de[0].severity, "medium");
    assert_eq!(de[0].original, "的");
    assert_eq!(de[0].suggestion, "地");
}

// ---------------------------------------------------------------------------
// Category 4 — repeated function chars (low)
// ---------------------------------------------------------------------------

#[test]
fn doubled_de_flagged_low() {
    let issues = proofread("这是的的一个测试");
    let r: Vec<_> = issues
        .iter()
        .filter(|i| i.category == "repeat")
        .collect();
    assert!(!r.is_empty(), "expected repeat flag, issues={issues:#?}");
    assert_eq!(r[0].severity, "low");
    assert_eq!(r[0].original, "的的");
    assert_eq!(r[0].suggestion, "的");
}

// ---------------------------------------------------------------------------
// Category 5 — CJK ↔ Latin/digit spacing (low)
// ---------------------------------------------------------------------------

#[test]
fn cjk_then_latin_flagged_with_thin_space() {
    let issues = proofread("汉字abc汉字");
    let s: Vec<_> = issues
        .iter()
        .filter(|i| i.category == "cjk_latin_space")
        .collect();
    // We expect TWO boundaries: 字↔a and c↔汉. The doubled-flag is
    // intentional — it lets the user fix each side independently.
    assert!(s.len() >= 2, "expected >=2 spacing flags, issues={issues:#?}");
    for issue in &s {
        assert_eq!(issue.severity, "low");
        assert!(
            issue.suggestion.contains('\u{202F}'),
            "expected narrow space in suggestion, got {:?}",
            issue.suggestion
        );
    }
}

// ---------------------------------------------------------------------------
// Category 6 — digit + unit spacing (low)
// ---------------------------------------------------------------------------

#[test]
fn digit_unit_then_han_flagged() {
    let issues = proofread("5GB硬盘");
    let u: Vec<_> = issues
        .iter()
        .filter(|i| i.category == "digit_unit_space")
        .collect();
    assert_eq!(u.len(), 1, "expected one digit_unit flag, issues={issues:#?}");
    assert_eq!(u[0].severity, "low");
    assert_eq!(u[0].original, "5GB硬");
    assert_eq!(u[0].suggestion, "5 GB 硬");
}

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

#[test]
fn empty_input_yields_no_issues() {
    assert!(proofread("").is_empty());
}

#[test]
fn pure_ascii_yields_no_issues() {
    // Half-width punct alone (no CJK context) must not be flagged.
    let issues = proofread("Hello, world. How are you? It's fine.");
    let cats: Vec<_> = issues.iter().map(|i| i.category.as_str()).collect();
    assert!(
        issues.is_empty(),
        "expected empty issues for pure ASCII, got categories: {cats:?}"
    );
}

// ---------------------------------------------------------------------------
// End-to-end smoke test — exercises every category in one pass, mirroring
// the self-test the spec asks for. Run with --nocapture to see the report:
//
//   cargo test --test cjk_proofread_test smoke_mixed_quality_doc -- --nocapture
// ---------------------------------------------------------------------------

#[test]
fn smoke_mixed_quality_doc() {
    let doc = concat!(
        "# 中文校对测试\n",
        "\n",
        "这是一个测试文档,里面有不少问题.\n",
        "\n",
        "他突然的笑了起来,非常的开心.\n",
        "\n",
        "他说\"汉字\"很重要,但是的的确确写错了.\n",
        "\n",
        "电脑有5GB硬盘和8GB内存,搭配一颗M1芯片.\n",
        "\n",
        "汉字abc混排没有空格.\n",
    );

    let issues = proofread(doc);
    println!("=== smoke test: {} issues ===", issues.len());
    let mut by_cat = std::collections::BTreeMap::new();
    for issue in &issues {
        *by_cat.entry(issue.category.clone()).or_insert(0u32) += 1;
        println!(
            "  [{:6}] L{:>2} col {:>3}-{:<3} {:18} {:?} -> {:?}",
            issue.severity,
            issue.line,
            issue.col_start,
            issue.col_end,
            issue.category,
            issue.original,
            issue.suggestion
        );
    }
    println!("=== category counts ===");
    for (cat, n) in &by_cat {
        println!("  {cat:18} = {n}");
    }
    // Expect at least one of each major category.
    assert!(by_cat.contains_key("punct_halfwidth"), "missing halfwidth");
    assert!(by_cat.contains_key("latin_quotes"), "missing latin_quotes");
    assert!(by_cat.contains_key("de_misuse"), "missing de_misuse");
    assert!(by_cat.contains_key("repeat"), "missing repeat");
    assert!(
        by_cat.contains_key("cjk_latin_space"),
        "missing cjk_latin_space"
    );
    assert!(
        by_cat.contains_key("digit_unit_space"),
        "missing digit_unit_space"
    );
}
