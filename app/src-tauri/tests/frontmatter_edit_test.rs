//! Round-trip fidelity tests for the v4.6 Properties-inspector frontmatter
//! editor (`commands::set_frontmatter_property_str` /
//! `delete_frontmatter_property_str`).
//!
//! The contract these tests pin down:
//!   1. The note BODY is preserved byte-for-byte across any property edit.
//!   2. Existing key ORDER is preserved; updates keep a key in place; new
//!      keys append at the end.
//!   3. A note with NO frontmatter gets a synthesized block at the very top,
//!      ahead of a leading `# H1`, without disturbing the body.
//!   4. CJK keys, inline arrays, and quoted scalars survive a round-trip.
//!   5. Deleting the last key removes the frontmatter block entirely.

use app_lib::commands::{delete_frontmatter_property_str, set_frontmatter_property_str};
use serde_json::json;

/// Re-parse the frontmatter block of `s` back into a JSON value for value
/// assertions that don't care about exact YAML spelling.
fn fm_json(s: &str) -> serde_json::Value {
    assert!(s.starts_with("---\n"), "expected a frontmatter block, got:\n{s}");
    let rest = &s[4..];
    let close = rest.find("\n---\n").or_else(|| {
        if rest.ends_with("\n---") {
            Some(rest.len() - 4)
        } else {
            None
        }
    });
    let close = close.expect("frontmatter not closed");
    let yaml = &rest[..close];
    serde_yaml::from_str::<serde_json::Value>(yaml).unwrap()
}

/// Extract the body (everything after the closing `---` line) for byte-fidelity
/// assertions.
fn body_of(s: &str) -> String {
    if !s.starts_with("---\n") {
        return s.to_string();
    }
    let rest = &s[4..];
    if let Some(idx) = rest.find("\n---\n") {
        rest[idx + 5..].to_string()
    } else if let Some(idx) = rest.find("\n...\n") {
        rest[idx + 5..].to_string()
    } else {
        String::new()
    }
}

#[test]
fn updates_value_in_place_preserving_order_and_body() {
    let src = "---\ntitle: Hello\nstatus: draft\ntags: [a, b]\n---\n\n# Heading\n\nBody text with a --- rule below:\n\n---\n\nmore.\n";
    let out = set_frontmatter_property_str(src, "status", &json!("done")).unwrap();
    // Body (after the FM block) is byte-identical.
    assert_eq!(body_of(&out), body_of(src));
    // Key order preserved: title, status, tags.
    let keys: Vec<String> = {
        let rest = &out[4..];
        let close = rest.find("\n---\n").unwrap();
        serde_yaml::from_str::<serde_yaml::Mapping>(&rest[..close])
            .unwrap()
            .keys()
            .map(|k| k.as_str().unwrap().to_string())
            .collect()
    };
    assert_eq!(keys, vec!["title", "status", "tags"]);
    assert_eq!(fm_json(&out)["status"], json!("done"));
    assert_eq!(fm_json(&out)["tags"], json!(["a", "b"]));
}

#[test]
fn appends_new_key_at_end() {
    let src = "---\ntitle: A\nstatus: draft\n---\nbody\n";
    let out = set_frontmatter_property_str(src, "priority", &json!(3)).unwrap();
    let rest = &out[4..];
    let close = rest.find("\n---\n").unwrap();
    let keys: Vec<String> = serde_yaml::from_str::<serde_yaml::Mapping>(&rest[..close])
        .unwrap()
        .keys()
        .map(|k| k.as_str().unwrap().to_string())
        .collect();
    assert_eq!(keys, vec!["title", "status", "priority"]);
    assert_eq!(fm_json(&out)["priority"], json!(3));
    assert_eq!(body_of(&out), "body\n");
}

#[test]
fn cjk_key_round_trips() {
    let src = "---\n标题: 测试\n作者: 李四\n---\n正文内容\n";
    let out = set_frontmatter_property_str(src, "标题", &json!("新标题")).unwrap();
    assert_eq!(fm_json(&out)["标题"], json!("新标题"));
    assert_eq!(fm_json(&out)["作者"], json!("李四"));
    assert_eq!(body_of(&out), "正文内容\n");

    // Adding a brand-new CJK key.
    let out2 = set_frontmatter_property_str(&out, "状态", &json!("完成")).unwrap();
    assert_eq!(fm_json(&out2)["状态"], json!("完成"));
}

#[test]
fn inline_array_value_round_trips() {
    let src = "---\ntags: [one, two]\n---\nbody\n";
    let out = set_frontmatter_property_str(src, "tags", &json!(["x", "y", "z"])).unwrap();
    assert_eq!(fm_json(&out)["tags"], json!(["x", "y", "z"]));
    assert_eq!(body_of(&out), "body\n");
}

#[test]
fn quoted_scalar_with_special_chars_round_trips() {
    let src = "---\ntitle: plain\n---\nbody\n";
    // A value with a leading `#`, a colon, and a trailing space — must stay a
    // single scalar after the round-trip.
    let out = set_frontmatter_property_str(src, "note", &json!("#tag: value here")).unwrap();
    assert_eq!(fm_json(&out)["note"], json!("#tag: value here"));
    // The value must re-parse to exactly the same string (quoting handled by
    // serde_yaml; we don't assert the exact spelling, only the parsed value).
}

#[test]
fn synthesizes_block_for_note_without_frontmatter() {
    let src = "# My Note\n\nSome body text.\n";
    let out = set_frontmatter_property_str(src, "status", &json!("draft")).unwrap();
    assert!(out.starts_with("---\n"), "expected synthesized FM block");
    assert_eq!(fm_json(&out)["status"], json!("draft"));
    // The leading H1 + body must survive intact, separated by one blank line.
    assert!(out.contains("# My Note\n\nSome body text.\n"));
    // No frontmatter should leak into the body section.
    assert_eq!(body_of(&out), "# My Note\n\nSome body text.\n");
}

#[test]
fn synthesizes_block_for_empty_file() {
    let src = "";
    let out = set_frontmatter_property_str(src, "k", &json!("v")).unwrap();
    assert_eq!(fm_json(&out)["k"], json!("v"));
    assert_eq!(body_of(&out), "");
}

#[test]
fn deleting_last_key_drops_block_leaving_body() {
    let src = "---\nonly: value\n---\n\n# Body\n";
    let out = delete_frontmatter_property_str(src, "only").unwrap();
    assert!(!out.starts_with("---\n"), "block should be gone");
    assert_eq!(out, "\n# Body\n");
}

#[test]
fn deleting_one_of_many_preserves_order_and_body() {
    let src = "---\na: 1\nb: 2\nc: 3\n---\nbody\n";
    let out = delete_frontmatter_property_str(src, "b").unwrap();
    let rest = &out[4..];
    let close = rest.find("\n---\n").unwrap();
    let keys: Vec<String> = serde_yaml::from_str::<serde_yaml::Mapping>(&rest[..close])
        .unwrap()
        .keys()
        .map(|k| k.as_str().unwrap().to_string())
        .collect();
    assert_eq!(keys, vec!["a", "c"]);
    assert_eq!(body_of(&out), "body\n");
}

#[test]
fn deleting_missing_key_is_noop_for_values() {
    let src = "---\na: 1\n---\nbody\n";
    let out = delete_frontmatter_property_str(src, "zzz").unwrap();
    assert_eq!(fm_json(&out)["a"], json!(1));
    assert_eq!(body_of(&out), "body\n");
}

#[test]
fn boolean_and_number_types_are_bare() {
    let src = "---\nx: 1\n---\nbody\n";
    let out = set_frontmatter_property_str(src, "done", &json!(true)).unwrap();
    assert_eq!(fm_json(&out)["done"], json!(true));
    let out2 = set_frontmatter_property_str(&out, "count", &json!(42)).unwrap();
    assert_eq!(fm_json(&out2)["count"], json!(42));
}

#[test]
fn body_with_internal_hr_is_preserved_byte_for_byte() {
    let src = "---\ntitle: T\n---\nintro\n\n---\n\nafter divider\n";
    let out = set_frontmatter_property_str(src, "title", &json!("T2")).unwrap();
    assert_eq!(body_of(&out), "intro\n\n---\n\nafter divider\n");
}

// ---------------------------------------------------------------------------
// v4.6.1 DEPTH — line-surgical fidelity: editing one key must NOT reflow,
// reformat, or drop any other line in the block.
// ---------------------------------------------------------------------------

/// The whole frontmatter block (the `---`…`---` region, exclusive of fences)
/// as a single string, for byte-exact neighbor assertions.
fn block_of(s: &str) -> String {
    let rest = &s[4..];
    let close = rest.find("\n---\n").expect("closed block");
    rest[..close].to_string()
}

#[test]
fn editing_one_key_preserves_inline_array_neighbor_verbatim() {
    // Regression: serde_yaml would reflow `tags: [a, b]` into block style when
    // re-emitting the whole map. Line-surgical editing must leave it untouched.
    let src = "---\ntitle: x\ntags: [a, b]\ncount: 1\n---\nbody\n";
    let out = set_frontmatter_property_str(src, "title", &json!("y")).unwrap();
    assert_eq!(block_of(&out), "title: y\ntags: [a, b]\ncount: 1");
    assert_eq!(body_of(&out), "body\n");
}

#[test]
fn editing_one_key_preserves_comments() {
    // Regression: serde_yaml drops comments. Line-surgical editing keeps every
    // comment line that isn't the edited key's own line.
    let src = "---\n# top comment\ntitle: x  # inline note\nstatus: draft\n# trailing\n---\nbody\n";
    let out = set_frontmatter_property_str(src, "status", &json!("done")).unwrap();
    assert_eq!(
        block_of(&out),
        "# top comment\ntitle: x  # inline note\nstatus: done\n# trailing"
    );
}

#[test]
fn editing_preserves_block_style_array_neighbor() {
    let src = "---\nlist:\n  - one\n  - two\nother: keep\n---\nbody\n";
    let out = set_frontmatter_property_str(src, "other", &json!("changed")).unwrap();
    assert_eq!(
        block_of(&out),
        "list:\n  - one\n  - two\nother: changed"
    );
}

#[test]
fn editing_a_block_style_array_replaces_only_its_lines() {
    let src = "---\nbefore: a\nlist:\n  - one\n  - two\nafter: z\n---\nbody\n";
    let out = set_frontmatter_property_str(src, "list", &json!(["x", "y", "z"])).unwrap();
    assert_eq!(fm_json(&out)["list"], json!(["x", "y", "z"]));
    // Neighbors untouched verbatim.
    assert!(block_of(&out).starts_with("before: a\n"));
    assert!(block_of(&out).ends_with("\nafter: z"));
    assert_eq!(body_of(&out), "body\n");
}

#[test]
fn editing_preserves_single_quoted_neighbor_style() {
    // A single-quoted scalar neighbor must keep its quotes (serde_yaml would
    // re-emit it differently).
    let src = "---\ntitle: x\nname: 'O''Brien: special'\nstatus: draft\n---\nbody\n";
    let out = set_frontmatter_property_str(src, "status", &json!("done")).unwrap();
    assert!(block_of(&out).contains("name: 'O''Brien: special'"));
    assert_eq!(fm_json(&out)["status"], json!("done"));
}

#[test]
fn crlf_block_round_trips_with_crlf() {
    let src = "---\r\ntitle: x\r\nstatus: draft\r\n---\r\nbody line\r\n";
    let out = set_frontmatter_property_str(src, "status", &json!("done")).unwrap();
    // Newlines inside the block stay CRLF.
    assert!(out.starts_with("---\r\n"));
    assert!(out.contains("status: done\r\n"));
    assert!(out.contains("title: x\r\n"));
    // Body preserved verbatim.
    assert!(out.ends_with("body line\r\n"));
}

#[test]
fn no_frontmatter_synthesis_has_no_blank_line_before_h1() {
    let src = "# My Note\n\nSome body text.\n";
    let out = set_frontmatter_property_str(src, "status", &json!("draft")).unwrap();
    // Block closes with `---\n` directly followed by the H1 — NO blank line.
    assert_eq!(out, "---\nstatus: draft\n---\n# My Note\n\nSome body text.\n");
}

#[test]
fn cjk_key_edit_preserves_other_cjk_keys_verbatim() {
    let src = "---\n标题: 测试\n标签: [一, 二]\n作者: 李四\n---\n正文\n";
    let out = set_frontmatter_property_str(src, "标题", &json!("新标题")).unwrap();
    // The inline CJK array neighbor must stay inline + untouched.
    assert!(block_of(&out).contains("标签: [一, 二]"));
    assert!(block_of(&out).contains("作者: 李四"));
    assert_eq!(fm_json(&out)["标题"], json!("新标题"));
    assert_eq!(body_of(&out), "正文\n");
}

#[test]
fn quoted_key_with_colon_round_trips_in_place() {
    let src = "---\n\"a: b\": one\nother: two\n---\nbody\n";
    let out = set_frontmatter_property_str(src, "a: b", &json!("changed")).unwrap();
    assert_eq!(fm_json(&out)["a: b"], json!("changed"));
    // `other` is untouched and stays a single line.
    assert!(block_of(&out).contains("other: two"));
}

#[test]
fn deleting_block_style_array_removes_all_its_lines() {
    let src = "---\nkeep: 1\nlist:\n  - one\n  - two\ntail: 2\n---\nbody\n";
    let out = delete_frontmatter_property_str(src, "list").unwrap();
    assert_eq!(block_of(&out), "keep: 1\ntail: 2");
    assert_eq!(body_of(&out), "body\n");
}

#[test]
fn appending_new_key_does_not_reflow_existing_inline_array() {
    let src = "---\ntags: [a, b]\n---\nbody\n";
    let out = set_frontmatter_property_str(src, "status", &json!("done")).unwrap();
    assert_eq!(block_of(&out), "tags: [a, b]\nstatus: done");
    assert_eq!(body_of(&out), "body\n");
}

#[test]
fn empty_string_value_round_trips() {
    let src = "---\ntitle: x\n---\nbody\n";
    let out = set_frontmatter_property_str(src, "note", &json!("")).unwrap();
    assert_eq!(fm_json(&out)["note"], json!(""));
    assert_eq!(body_of(&out), "body\n");
}
