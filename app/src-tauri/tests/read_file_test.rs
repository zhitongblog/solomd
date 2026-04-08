use app_lib::commands::{read_file, write_file};
use std::fs;

#[test]
fn read_utf8_with_bom() {
    let path = "/tmp/solomd-utf8-bom.md".to_string();
    let mut bytes = vec![0xEF, 0xBB, 0xBF];
    bytes.extend_from_slice("# Hello 世界".as_bytes());
    fs::write(&path, &bytes).unwrap();

    let r = read_file(path).unwrap();
    assert!(r.had_bom);
    assert_eq!(r.encoding, "UTF-8");
    assert_eq!(r.content, "# Hello 世界");
    assert_eq!(r.language, "markdown");
}

#[test]
fn read_utf8_no_bom() {
    let path = "/tmp/solomd-utf8.md".to_string();
    fs::write(&path, "# Plain UTF-8\n中文测试").unwrap();

    let r = read_file(path).unwrap();
    assert!(!r.had_bom);
    assert!(r.content.contains("中文测试"));
    assert_eq!(r.language, "markdown");
}

#[test]
fn read_gbk_chinese() {
    use encoding_rs::GBK;
    let path = "/tmp/solomd-gbk.txt".to_string();
    // chardetng needs ≥ ~100 bytes to confidently detect GBK; supply a
    // realistic paragraph rather than 4 bytes.
    let text = "中文软件开发笔记。这是一段用 GBK 编码保存的中文文本，\
                用来验证 SoloMD 的编码识别功能能否正确把它读回来并\
                转成 UTF-8 显示。Markdown 编辑器的关键特性之一就是\
                老旧编码的兼容支持。再加一行内容来确保字节数足够。";
    let (gbk_bytes, _, _) = GBK.encode(text);
    fs::write(&path, gbk_bytes.as_ref()).unwrap();

    let r = read_file(path).unwrap();
    assert!(!r.had_bom);
    println!("detected encoding: {}", r.encoding);
    // chardetng may pick GBK or GB18030 — both decode the same here.
    assert!(r.content.contains("中文软件开发笔记"));
    assert_eq!(r.language, "plaintext");
}

#[test]
fn read_utf16_le_bom() {
    let path = "/tmp/solomd-utf16le.md".to_string();
    let mut bytes = vec![0xFF, 0xFE]; // UTF-16 LE BOM
    for ch in "# UTF16 LE".encode_utf16() {
        bytes.push((ch & 0xFF) as u8);
        bytes.push((ch >> 8) as u8);
    }
    fs::write(&path, &bytes).unwrap();

    let r = read_file(path).unwrap();
    assert!(r.had_bom);
    assert_eq!(r.encoding, "UTF-16LE");
    assert!(r.content.contains("UTF16 LE"));
}

#[test]
fn write_then_read_utf8_roundtrip() {
    let path = "/tmp/solomd-roundtrip.md".to_string();
    let original = "# Round Trip\n你好 World!".to_string();
    write_file(path.clone(), original.clone(), "UTF-8".to_string()).unwrap();

    let r = read_file(path).unwrap();
    assert_eq!(r.content, original);
}

#[test]
fn write_gbk_roundtrip() {
    let path = "/tmp/solomd-gbk-rt.txt".to_string();
    let original = "你好世界".to_string();
    write_file(path.clone(), original.clone(), "GBK".to_string()).unwrap();

    let r = read_file(path).unwrap();
    assert!(r.content.contains("你好"));
}

#[test]
fn detect_language_from_extension() {
    let path = "/tmp/solomd-lang.markdown".to_string();
    fs::write(&path, "# heading").unwrap();
    let r = read_file(path).unwrap();
    assert_eq!(r.language, "markdown");

    let path2 = "/tmp/solomd-lang.txt".to_string();
    fs::write(&path2, "plain").unwrap();
    let r2 = read_file(path2).unwrap();
    assert_eq!(r2.language, "plaintext");

    let path3 = "/tmp/solomd-lang.rs".to_string();
    fs::write(&path3, "fn main(){}").unwrap();
    let r3 = read_file(path3).unwrap();
    assert_eq!(r3.language, "plaintext");
}
