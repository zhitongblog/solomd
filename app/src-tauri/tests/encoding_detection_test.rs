//! Encoding detection for opened files.
//!
//! `read_file_inner` sniffs a BOM, then falls back to chardetng. The existing
//! `read_file_test.rs` covers the BOM cases and one long GBK sample, with a
//! note that chardetng "needs ≥ ~100 bytes to confidently detect GBK" — which
//! would make short CJK notes a mojibake risk. These pin down that the short
//! cases decode correctly too, across the encodings a CJK user's existing
//! notes are actually saved in.
use app_lib::commands::read_file_inner as read_file;
use encoding_rs::{Encoding, BIG5, EUC_KR, GBK, SHIFT_JIS};
use std::fs;

fn write_raw(name: &str, bytes: &[u8]) -> String {
    let dir = std::env::temp_dir().join("solomd_encoding_tests");
    fs::create_dir_all(&dir).unwrap();
    let p = dir.join(name);
    fs::write(&p, bytes).unwrap();
    p.to_string_lossy().into_owned()
}

fn roundtrip(name: &str, enc: &'static Encoding, text: &str) -> String {
    let (bytes, _, _) = enc.encode(text);
    read_file(write_raw(name, &bytes)).unwrap().content
}

/// Most .md files in the wild are UTF-8 with no BOM. A misdetection here
/// would garble every character of the document.
#[test]
fn utf8_without_bom_survives_at_any_length() {
    for (i, text) in [
        "一",
        "你好",
        "会议记录",
        "今天的会议记录",
        "# 标题\n\n正文内容。",
        "备忘\n- 买菜\n- 交电费\n- 给妈妈打电话",
    ]
    .iter()
    .enumerate()
    {
        let got = read_file(write_raw(&format!("u8_{i}.md"), text.as_bytes()))
            .unwrap()
            .content;
        assert_eq!(&got, text, "UTF-8 sample {i} decoded wrong");
    }
}

/// A short GBK note is the case the ≥100-byte caveat predicts would fail.
#[test]
fn short_gbk_note() {
    assert_eq!(
        roundtrip("gbk_short.md", GBK, "今天的会议记录"),
        "今天的会议记录"
    );
}

#[test]
fn medium_gbk_note() {
    let text = "项目进度\n\n今天和团队讨论了下个版本的排期，主要问题是测试资源不足。";
    assert_eq!(roundtrip("gbk_medium.md", GBK, text), text);
}

/// Traditional Chinese, Japanese and Korean legacy encodings — all plausible
/// for a user's pre-existing notes, none covered before.
#[test]
fn other_cjk_legacy_encodings() {
    assert_eq!(roundtrip("big5_short.md", BIG5, "會議記錄"), "會議記錄");
    let big5_long = "今天的會議記錄，討論了下個版本的排期與測試資源。";
    assert_eq!(roundtrip("big5_long.md", BIG5, big5_long), big5_long);
    assert_eq!(roundtrip("sjis.md", SHIFT_JIS, "会議メモ"), "会議メモ");
    assert_eq!(roundtrip("euckr.md", EUC_KR, "회의 기록"), "회의 기록");
}
