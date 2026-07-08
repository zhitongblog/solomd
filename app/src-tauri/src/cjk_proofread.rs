//! CJK proofread (v2.5 F6) — flag common Chinese typography mistakes
//! and propose fixes.
//!
//! Detection is **regex-/char-based, not LLM-based** by design: zero
//! network, zero per-char cost, deterministic, and works on traditional
//! + simplified Han identically (via `char::is_*` + explicit Unicode
//! ranges).
//!
//! We deliberately use a hand-rolled scanner instead of `regex` with
//! `\p{Han}` — `regex-lite` (already a project dep) does NOT support
//! Unicode classes, and pulling in the full `regex` crate (~1 MB
//! release) just for `\p{Han}` is a poor tradeoff when char-by-char
//! iteration is faster anyway. See the comment in `workspace_index.rs`.
//!
//! Output is a flat `Vec<Issue>` with byte/line/col positions in the
//! source text. The frontend uses these to:
//!   1. Render a list of issues grouped by severity / category.
//!   2. Jump the editor to the position when the user clicks a row.
//!   3. Apply replacements one-at-a-time or in a batch.
//!
//! ## Severity tiers
//!
//! - **High** — clear errors. Half-width punctuation in CJK context,
//!   doubled `的的`/`了了`/`是是` (rare exceptions allowed in casual
//!   text but flagged as low — see `repeat_chars`), Latin quotes
//!   wrapping Han.
//! - **Medium** — probable errors. `的/地/得` misuse against a tiny
//!   adverb dictionary; cannot be 100% certain without a parser.
//! - **Low** — style suggestions. CJK↔Latin/digit spacing, digit↔unit
//!   spacing, doubled CJK chars (could be intentional emphasis).
//!
//! ## Adding more rules
//!
//! Each detector is a free function that pushes `Issue` records onto
//! the shared `out` vec. Adding a new category:
//!   1. Add a `detect_xxx(&str, &mut Vec<Issue>)` function.
//!   2. Call it from `cjk_proofread`.
//!   3. Add a unit test.
//!   4. Add the category constant to the `category` doc list.

use serde::Serialize;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/// One detected proofread issue.
///
/// Positions are **0-indexed byte offsets** within the source string
/// (matching CodeMirror's coordinate system). `line` is 1-indexed for
/// human display.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct Issue {
    /// 1-indexed line number for UI display.
    pub line: u32,
    /// Byte offset of the issue's first byte from the start of the doc.
    pub col_start: u32,
    /// Byte offset one past the last byte (exclusive).
    pub col_end: u32,
    /// `"high" | "medium" | "low"`.
    pub severity: String,
    /// `"punct_halfwidth" | "de_misuse" | "latin_quotes"
    ///  | "cjk_latin_space" | "repeat" | "digit_unit_space"`.
    pub category: String,
    /// The original text spanning `[col_start, col_end)`.
    pub original: String,
    /// Suggested replacement text.
    pub suggestion: String,
    /// Short human-readable explanation.
    pub explanation: String,
}

// ---------------------------------------------------------------------------
// Tauri command
// ---------------------------------------------------------------------------

/// Run all proofread detectors on `text` and return the flagged issues.
///
/// Returns `Vec<Issue>` rather than a `Result` because detection is
/// infallible — we either find issues or we don't. Empty input yields
/// an empty vec; pure-ASCII text likewise (zero CJK = nothing to
/// proofread).
#[tauri::command]
pub async fn cjk_proofread(text: String) -> Vec<Issue> {
    tauri::async_runtime::spawn_blocking(move || proofread(&text))
        .await
        .unwrap_or_default()
}

// ---------------------------------------------------------------------------
// Core
// ---------------------------------------------------------------------------

pub fn proofread(text: &str) -> Vec<Issue> {
    if text.is_empty() {
        return Vec::new();
    }

    let mut out: Vec<Issue> = Vec::new();
    let line_idx = LineIndex::new(text);

    detect_halfwidth_punct(text, &line_idx, &mut out);
    detect_latin_quotes(text, &line_idx, &mut out);
    detect_de_misuse(text, &line_idx, &mut out);
    detect_repeat_chars(text, &line_idx, &mut out);
    detect_cjk_latin_space(text, &line_idx, &mut out);
    detect_digit_unit_space(text, &line_idx, &mut out);

    // Stable sort by start position so the frontend gets issues
    // in document order regardless of detector order.
    out.sort_by_key(|i| (i.col_start, i.col_end));
    out
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// Pre-computed map of byte-offset → 1-indexed line number, used to
/// avoid O(n) linear scan per issue. Built once per `proofread` call.
struct LineIndex {
    /// `line_starts[i]` = byte offset of the start of line `i+1`.
    line_starts: Vec<usize>,
}

impl LineIndex {
    fn new(text: &str) -> Self {
        let mut starts = vec![0usize];
        for (i, b) in text.bytes().enumerate() {
            if b == b'\n' {
                starts.push(i + 1);
            }
        }
        Self { line_starts: starts }
    }

    /// 1-indexed line for the given byte offset.
    fn line_of(&self, byte: usize) -> u32 {
        // binary search for the largest line_start <= byte
        match self.line_starts.binary_search(&byte) {
            Ok(idx) => (idx + 1) as u32,
            Err(idx) => idx as u32, // idx is the insert point; line is idx (1-indexed because line_starts[0]=0)
        }
    }
}

/// True for CJK Unified Ideographs (Han) covering both simplified and
/// traditional. Range pulled from the Unicode standard:
///   U+3400..U+4DBF   CJK Unified Ideographs Extension A
///   U+4E00..U+9FFF   CJK Unified Ideographs
///   U+20000..U+2A6DF Extension B
///   U+2A700..U+2B73F Extension C
///   U+2B740..U+2B81F Extension D
///   U+2B820..U+2CEAF Extension E
///   U+F900..U+FAFF   CJK Compatibility Ideographs
fn is_han(c: char) -> bool {
    let cp = c as u32;
    (0x3400..=0x4DBF).contains(&cp)
        || (0x4E00..=0x9FFF).contains(&cp)
        || (0xF900..=0xFAFF).contains(&cp)
        || (0x20000..=0x2A6DF).contains(&cp)
        || (0x2A700..=0x2B73F).contains(&cp)
        || (0x2B740..=0x2B81F).contains(&cp)
        || (0x2B820..=0x2CEAF).contains(&cp)
}

/// Map a half-width ASCII punctuation char to its full-width CJK
/// equivalent. Returns `None` for anything we don't auto-correct
/// (deliberately omits `()` and `[]` — those are widely used
/// half-width inside Chinese tech writing).
fn halfwidth_to_fullwidth(c: char) -> Option<char> {
    match c {
        ',' => Some('，'),
        '.' => Some('。'),
        '?' => Some('？'),
        '!' => Some('！'),
        ':' => Some('：'),
        ';' => Some('；'),
        _ => None,
    }
}

// ---------------------------------------------------------------------------
// Detectors
// ---------------------------------------------------------------------------

/// **Half-width punctuation in CJK context.** Scan for `[Han][,.?!:;]`
/// and flag the punctuation byte. Severity: high.
///
/// We require the *immediately preceding* char to be Han — this
/// avoids false positives inside English-only sentences that happen
/// to live in a mixed-language doc.
fn detect_halfwidth_punct(text: &str, idx: &LineIndex, out: &mut Vec<Issue>) {
    let mut prev: Option<char> = None;
    for (byte_off, c) in text.char_indices() {
        if let Some(replacement) = halfwidth_to_fullwidth(c) {
            if let Some(p) = prev {
                if is_han(p) {
                    let len = c.len_utf8();
                    out.push(Issue {
                        line: idx.line_of(byte_off),
                        col_start: byte_off as u32,
                        col_end: (byte_off + len) as u32,
                        severity: "high".into(),
                        category: "punct_halfwidth".into(),
                        original: c.to_string(),
                        suggestion: replacement.to_string(),
                        explanation: format!(
                            "汉字之后应使用全角标点 {} 而非半角 {}",
                            replacement, c
                        ),
                    });
                }
            }
        }
        prev = Some(c);
    }
}

/// **Latin quotes around Han.** `"汉字"` → `"汉字"`; `'汉字'` → `'汉字'`.
/// Match a straight `"` or `'`, look forward for at least one Han
/// char, then a matching close quote. Severity: high.
fn detect_latin_quotes(text: &str, idx: &LineIndex, out: &mut Vec<Issue>) {
    detect_quote_pair(text, idx, '"', '“', '”', out);
    detect_quote_pair(text, idx, '\'', '‘', '’', out);
}

fn detect_quote_pair(
    text: &str,
    idx: &LineIndex,
    quote: char,
    open: char,
    close: char,
    out: &mut Vec<Issue>,
) {
    let bytes = text.as_bytes();
    let q_byte = quote as u8;
    let mut i = 0usize;
    while i < bytes.len() {
        if bytes[i] != q_byte {
            i += 1;
            continue;
        }
        // Find the matching close quote on the same line.
        let mut j = i + 1;
        let mut saw_han = false;
        while j < bytes.len() {
            if bytes[j] == b'\n' {
                break;
            }
            if bytes[j] == q_byte {
                break;
            }
            j += 1;
        }
        if j >= bytes.len() || bytes[j] != q_byte {
            i += 1;
            continue;
        }
        // Now `text[i..=j]` is `"…"`. Scan inner content for any Han.
        let inner = &text[i + 1..j];
        if inner.is_empty() {
            i = j + 1;
            continue;
        }
        for c in inner.chars() {
            if is_han(c) {
                saw_han = true;
                break;
            }
        }
        if saw_han {
            let original = &text[i..=j];
            let suggestion = format!("{}{}{}", open, inner, close);
            out.push(Issue {
                line: idx.line_of(i),
                col_start: i as u32,
                col_end: (j + 1) as u32,
                severity: "high".into(),
                category: "latin_quotes".into(),
                original: original.to_string(),
                suggestion,
                explanation: format!("中文文本应使用全角引号 {}…{}", open, close),
            });
        }
        i = j + 1;
    }
}

/// **的/地/得 misuse — the medium-severity bucket.**
///
/// Real `的/地/得` disambiguation needs a Chinese parser. We use a
/// **conservative dictionary** of well-known adverb stems that are
/// almost always followed by `地` (not `的`) when modifying a verb.
/// False-negatives (missing genuine misuse) are preferred over
/// false-positives (annoying writers with bad flags).
///
/// Pattern: `<adverb-stem>的<Han>` → suggest `<stem>地<Han>`.
/// We only fire when the next char is also Han (i.e. modifying a verb
/// like `精彩` not a noun phrase that could legitimately take `的`).
fn detect_de_misuse(text: &str, idx: &LineIndex, out: &mut Vec<Issue>) {
    // ~30 high-confidence adverb stems. Picked for high precision —
    // these words rarely take `的` correctly. Add cautiously.
    const ADVERB_STEMS: &[&str] = &[
        "非常", "突然", "仔细", "认真", "慢慢", "渐渐", "悄悄", "默默",
        "轻轻", "重重", "深深", "静静", "缓缓", "匆匆", "急急", "渐次",
        "迅速", "迅猛", "猛烈", "剧烈", "热烈", "强烈", "顺利", "完美",
        "高兴", "愉快", "愤怒", "兴奋", "激动", "勇敢", "亲切",
    ];

    for stem in ADVERB_STEMS {
        let needle = format!("{}的", stem);
        let mut start = 0usize;
        while let Some(rel) = text[start..].find(&needle) {
            let abs = start + rel;
            // The matched span is `<stem>的`. The `的` is the last char.
            let de_start = abs + stem.len();
            let de_end = de_start + '的'.len_utf8();
            // Look at next char after `的` — only flag if Han.
            let after = &text[de_end..];
            if let Some(next_char) = after.chars().next() {
                if is_han(next_char) {
                    out.push(Issue {
                        line: idx.line_of(de_start),
                        col_start: de_start as u32,
                        col_end: de_end as u32,
                        severity: "medium".into(),
                        category: "de_misuse".into(),
                        original: "的".into(),
                        suggestion: "地".into(),
                        explanation: format!(
                            "副词 “{}” 修饰动词时应用 “地” 而非 “的”",
                            stem
                        ),
                    });
                }
            }
            start = abs + needle.len();
        }
    }
}

/// **Repeated CJK chars** — `的的` `了了` `是是` `啊啊`. Flag any run
/// of length >= 2 of the same char from a small "function word" set
/// where doubling is almost always a typo.
///
/// Severity: low. (Casual writing legitimately uses `的的的的的` or
/// `啊啊啊啊` for emphasis on social media — we don't want to be the
/// fun police.)
fn detect_repeat_chars(text: &str, idx: &LineIndex, out: &mut Vec<Issue>) {
    const REPEAT_CANDIDATES: &[char] = &['的', '了', '是', '在', '和', '与', '及'];

    let chars: Vec<(usize, char)> = text.char_indices().collect();
    let mut i = 0usize;
    while i < chars.len() {
        let (off, c) = chars[i];
        if !REPEAT_CANDIDATES.contains(&c) {
            i += 1;
            continue;
        }
        // Count consecutive identical chars.
        let mut run_end = i + 1;
        while run_end < chars.len() && chars[run_end].1 == c {
            run_end += 1;
        }
        if run_end - i >= 2 {
            let last = chars[run_end - 1];
            let end_byte = last.0 + last.1.len_utf8();
            out.push(Issue {
                line: idx.line_of(off),
                col_start: off as u32,
                col_end: end_byte as u32,
                severity: "low".into(),
                category: "repeat".into(),
                original: text[off..end_byte].to_string(),
                suggestion: c.to_string(),
                explanation: format!("疑似重复的 “{}”，请确认是否为笔误", c),
            });
        }
        i = run_end;
    }
}

/// **CJK ↔ Latin/digit spacing.** Per modern CJK typography (Pangu),
/// a thin space (U+202F) belongs between Han and ASCII letter/digit.
///
/// We flag the *boundary* (zero-width) and suggest inserting U+202F.
/// We model this as an Issue whose `col_start == col_end` is **not**
/// allowed (the frontend would not know what to highlight) — instead
/// we span the two boundary chars and the suggestion is the same two
/// chars with the thin space inserted between them.
///
/// Severity: low.
fn detect_cjk_latin_space(text: &str, idx: &LineIndex, out: &mut Vec<Issue>) {
    let mut prev: Option<(usize, char)> = None;
    for (byte_off, c) in text.char_indices() {
        if let Some((p_off, p)) = prev {
            let han_then_latin = is_han(p) && is_latin_or_digit(c);
            let latin_then_han = is_latin_or_digit(p) && is_han(c);
            if han_then_latin || latin_then_han {
                let end = byte_off + c.len_utf8();
                let original = &text[p_off..end];
                // U+202F NARROW NO-BREAK SPACE
                let suggestion = format!("{}\u{202F}{}", p, c);
                out.push(Issue {
                    line: idx.line_of(p_off),
                    col_start: p_off as u32,
                    col_end: end as u32,
                    severity: "low".into(),
                    category: "cjk_latin_space".into(),
                    original: original.to_string(),
                    suggestion,
                    explanation: "汉字与西文/数字之间建议加窄空格".into(),
                });
            }
        }
        prev = Some((byte_off, c));
    }
}

fn is_latin_or_digit(c: char) -> bool {
    c.is_ascii_alphabetic() || c.is_ascii_digit()
}

/// **Digit + unit spacing**, e.g. `5GB硬盘` → `5 GB 硬盘`.
///
/// Conservative: only fire when the digit-run is followed by a
/// known unit token AND the next char after the unit is Han (so we
/// don't break English contexts like `5GB max`).
///
/// Severity: low.
fn detect_digit_unit_space(text: &str, idx: &LineIndex, out: &mut Vec<Issue>) {
    // Multi-char units must come before their substrings (`min` before `m`)
    // so the longest match wins.
    const UNITS: &[&str] = &[
        "GB", "MB", "KB", "TB", "PB", "kg", "mg", "cm", "mm", "km",
        "min", "sec", "ms", "us", "ns", "Hz", "kHz", "MHz", "GHz",
        "kg", "h", "s", "m",
    ];

    let bytes = text.as_bytes();
    let mut i = 0usize;
    while i < bytes.len() {
        // Find a digit run.
        if !bytes[i].is_ascii_digit() {
            i += 1;
            continue;
        }
        let digit_start = i;
        while i < bytes.len() && bytes[i].is_ascii_digit() {
            i += 1;
        }
        let after_digits = i;
        // Try to match a unit at this position.
        let rest = &text[after_digits..];
        let mut matched_unit: Option<&str> = None;
        for u in UNITS {
            if rest.starts_with(u) {
                // ensure the unit isn't part of a longer alpha token (e.g.
                // `5GBmax` — we don't want to flag this).
                let after_unit = after_digits + u.len();
                let after_char = text[after_unit..].chars().next();
                let next_is_alpha = matches!(after_char, Some(c) if c.is_ascii_alphabetic());
                if !next_is_alpha {
                    matched_unit = Some(u);
                    break;
                }
            }
        }
        let Some(unit) = matched_unit else { continue };
        let after_unit = after_digits + unit.len();
        // Only fire if next char is Han.
        let Some(next_char) = text[after_unit..].chars().next() else { continue };
        if !is_han(next_char) {
            continue;
        }
        let end = after_unit + next_char.len_utf8();
        let original = &text[digit_start..end];
        let digits = &text[digit_start..after_digits];
        let suggestion = format!("{} {} {}", digits, unit, next_char);
        out.push(Issue {
            line: idx.line_of(digit_start),
            col_start: digit_start as u32,
            col_end: end as u32,
            severity: "low".into(),
            category: "digit_unit_space".into(),
            original: original.to_string(),
            suggestion,
            explanation: "数字与单位之间、单位与汉字之间建议加空格".into(),
        });
    }
}

// ---------------------------------------------------------------------------
// In-module unit tests (doctest-adjacent quick checks). Full
// integration coverage lives in tests/cjk_proofread_test.rs.
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_input_no_issues() {
        assert!(proofread("").is_empty());
    }

    #[test]
    fn pure_ascii_no_issues() {
        assert!(proofread("Hello, world. How are you?").is_empty());
    }

    #[test]
    fn line_index_basic() {
        let idx = LineIndex::new("a\nbb\nccc");
        assert_eq!(idx.line_of(0), 1);
        assert_eq!(idx.line_of(1), 1);
        assert_eq!(idx.line_of(2), 2);
        assert_eq!(idx.line_of(5), 3);
    }

    #[test]
    fn is_han_basic() {
        assert!(is_han('汉'));
        assert!(is_han('字'));
        assert!(is_han('學')); // traditional
        assert!(!is_han('a'));
        assert!(!is_han('，'));
    }
}
