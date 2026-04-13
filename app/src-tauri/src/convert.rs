// File-to-Markdown conversion.
//
// Strategy:
//   - Built-in (Rust): DOCX, HTML, CSV, XLSX — zero external deps, instant.
//   - Fallback (markitdown CLI): PDF, PPTX, images, audio — if installed.
//
// The Tauri command `convert_file_to_markdown` is called when a non-.md file
// is dragged into the editor or opened via File → Open.

use std::io::Read;
use std::path::Path;
use std::process::Command;
use chardetng::{EncodingDetector, Iso2022JpDetection, Utf8Detection};
use encoding_rs::UTF_8;

/// Main entry point. Returns Markdown string or error.
#[tauri::command]
pub fn convert_file_to_markdown(path: String) -> Result<String, String> {
    let p = Path::new(&path);
    let ext = p
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();

    match ext.as_str() {
        // ---- Built-in conversions ----
        "docx" => convert_docx(&path),
        "html" | "htm" => convert_html(&path),
        "csv" => convert_csv(&path),
        "xlsx" | "xls" => convert_xlsx(&path),
        "json" => convert_json(&path),
        "xml" => convert_xml_file(&path),

        "pptx" => convert_pptx(&path),

        "pdf" => convert_pdf(&path),

        // ---- Fallback to markitdown CLI ----
        "epub" => convert_via_markitdown(&path),
        "jpg" | "jpeg" | "png" | "gif" | "webp" | "bmp" => convert_via_markitdown(&path),
        "mp3" | "wav" | "m4a" | "ogg" | "flac" => convert_via_markitdown(&path),

        _ => Err(format!("Unsupported file type: .{ext}")),
    }
}

// ====================================================================
// DOCX → Markdown (ZIP of XML)
// ====================================================================

fn convert_docx(path: &str) -> Result<String, String> {
    let file = std::fs::File::open(path).map_err(|e| format!("Can't open file: {e}"))?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| format!("Not a valid DOCX: {e}"))?;

    let mut xml = String::new();
    archive
        .by_name("word/document.xml")
        .map_err(|e| format!("No document.xml in DOCX: {e}"))?
        .read_to_string(&mut xml)
        .map_err(|e| format!("Read error: {e}"))?;

    docx_xml_to_markdown(&xml)
}

fn docx_xml_to_markdown(xml: &str) -> Result<String, String> {
    use quick_xml::events::Event;
    use quick_xml::Reader;

    let mut reader = Reader::from_str(xml);
    let mut out = String::new();
    let mut current_line = String::new();
    let mut in_table_row = false;
    let mut table_cells: Vec<String> = Vec::new();
    let mut table_started = false;
    let mut heading_level: u8 = 0;
    let mut is_bold = false;
    let mut is_italic = false;
    let mut is_list_item = false;
    let mut buf = Vec::new();

    loop {
        match reader.read_event_into(&mut buf) {
            Ok(Event::Start(ref e)) | Ok(Event::Empty(ref e)) => {
                let name = String::from_utf8_lossy(e.local_name().as_ref()).to_string();
                match name.as_str() {
                    "p" => {
                        current_line.clear();
                        heading_level = 0;
                        is_list_item = false;
                    }
                    "pStyle" => {
                        for attr in e.attributes().flatten() {
                            if attr.key.as_ref() == b"w:val" {
                                let val =
                                    String::from_utf8_lossy(&attr.value).to_ascii_lowercase();
                                if val.starts_with("heading") || val.starts_with("title") {
                                    heading_level = val
                                        .chars()
                                        .last()
                                        .and_then(|c| c.to_digit(10))
                                        .unwrap_or(1)
                                        as u8;
                                }
                                if val.contains("list") {
                                    is_list_item = true;
                                }
                            }
                        }
                    }
                    "b" => is_bold = true,
                    "i" => is_italic = true,
                    "tr" => {
                        in_table_row = true;
                        table_cells.clear();
                    }
                    "tc" => {
                        current_line.clear();
                    }
                    _ => {}
                }
            }
            Ok(Event::Text(ref e)) => {
                if let Ok(text) = e.unescape() {
                    let t = text.to_string();
                    if is_bold && is_italic {
                        current_line.push_str(&format!("***{t}***"));
                    } else if is_bold {
                        current_line.push_str(&format!("**{t}**"));
                    } else if is_italic {
                        current_line.push_str(&format!("*{t}*"));
                    } else {
                        current_line.push_str(&t);
                    }
                }
            }
            Ok(Event::End(ref e)) => {
                let name = String::from_utf8_lossy(e.local_name().as_ref()).to_string();
                match name.as_str() {
                    "b" => is_bold = false,
                    "i" => is_italic = false,
                    "p" => {
                        let line = current_line.trim().to_string();
                        if in_table_row {
                            table_cells.push(line);
                        } else if !line.is_empty() {
                            if heading_level > 0 && heading_level <= 6 {
                                let hashes = "#".repeat(heading_level as usize);
                                out.push_str(&format!("{hashes} {line}\n\n"));
                            } else if is_list_item {
                                out.push_str(&format!("- {line}\n"));
                            } else {
                                out.push_str(&format!("{line}\n\n"));
                            }
                        }
                        current_line.clear();
                    }
                    "tr" => {
                        if !table_cells.is_empty() {
                            out.push_str("| ");
                            out.push_str(&table_cells.join(" | "));
                            out.push_str(" |\n");
                            if !table_started {
                                out.push_str("|");
                                for _ in &table_cells {
                                    out.push_str(" --- |");
                                }
                                out.push('\n');
                                table_started = true;
                            }
                        }
                        in_table_row = false;
                    }
                    "tbl" => {
                        table_started = false;
                        out.push('\n');
                    }
                    _ => {}
                }
            }
            Ok(Event::Eof) => break,
            Err(e) => return Err(format!("XML parse error: {e}")),
            _ => {}
        }
        buf.clear();
    }

    Ok(out.trim().to_string())
}

// ====================================================================
// HTML → Markdown
// ====================================================================

fn convert_html(path: &str) -> Result<String, String> {
    let raw = read_with_encoding(path)?;
    // Strip <style>, <script>, <head> blocks — htmd doesn't filter these
    // and would output their contents as plain text.
    let clean = strip_html_noise(&raw);
    Ok(htmd::convert(&clean).map_err(|e| format!("HTML conversion failed: {e}"))?)
}

/// Remove <style>…</style>, <script>…</script>, <head>…</head>, and HTML
/// comments before converting to Markdown.
fn strip_html_noise(html: &str) -> String {
    use std::borrow::Cow;
    let mut s: Cow<str> = Cow::Borrowed(html);
    // Each pattern: case-insensitive, dotall (. matches newline via [\s\S])
    for tag in &["style", "script", "head", "nav", "footer", "noscript"] {
        let re_str = format!(r"(?i)<{tag}[\s>][\s\S]*?</{tag}\s*>", tag = tag);
        if let Ok(re) = regex_lite::Regex::new(&re_str) {
            let replaced = re.replace_all(&s, "");
            if let Cow::Owned(o) = replaced {
                s = Cow::Owned(o);
            }
        }
    }
    // Also strip HTML comments
    if let Ok(re) = regex_lite::Regex::new(r"<!--[\s\S]*?-->") {
        let replaced = re.replace_all(&s, "");
        if let Cow::Owned(o) = replaced {
            s = Cow::Owned(o);
        }
    }
    s.into_owned()
}

/// Read a file with automatic encoding detection (UTF-8, GBK, Big5, etc.)
/// Reuses the same chardetng logic as the main read_file command.
fn read_with_encoding(path: &str) -> Result<String, String> {
    let bytes = std::fs::read(path).map_err(|e| format!("Can't read file: {e}"))?;

    // Try BOM first
    let (encoding, skip) = if bytes.starts_with(&[0xEF, 0xBB, 0xBF]) {
        (UTF_8 as &encoding_rs::Encoding, 3)
    } else if bytes.starts_with(&[0xFF, 0xFE]) {
        (encoding_rs::UTF_16LE as &encoding_rs::Encoding, 2)
    } else if bytes.starts_with(&[0xFE, 0xFF]) {
        (encoding_rs::UTF_16BE as &encoding_rs::Encoding, 2)
    } else {
        // Auto-detect with chardetng
        let mut detector = EncodingDetector::new(Iso2022JpDetection::Allow);
        detector.feed(&bytes, true);
        let enc = detector.guess(None, Utf8Detection::Allow);
        (enc, 0)
    };

    let body = &bytes[skip..];
    let (text, _, _) = encoding.decode(body);
    Ok(text.into_owned())
}

// ====================================================================
// CSV → Markdown table
// ====================================================================

fn convert_csv(path: &str) -> Result<String, String> {
    // CSV files are often GBK-encoded in China. Read with encoding detection
    // first, then parse the resulting UTF-8 string.
    let text = read_with_encoding(path)?;
    let mut rdr = csv::Reader::from_reader(text.as_bytes());
    let mut out = String::new();

    // Header
    let headers: Vec<String> = rdr
        .headers()
        .map_err(|e| format!("CSV header error: {e}"))?
        .iter()
        .map(|h| h.to_string())
        .collect();

    if !headers.is_empty() {
        out.push_str("| ");
        out.push_str(&headers.join(" | "));
        out.push_str(" |\n|");
        for _ in &headers {
            out.push_str(" --- |");
        }
        out.push('\n');
    }

    // Rows
    for result in rdr.records() {
        let record = result.map_err(|e| format!("CSV row error: {e}"))?;
        out.push_str("| ");
        let cells: Vec<&str> = record.iter().collect();
        out.push_str(&cells.join(" | "));
        out.push_str(" |\n");
    }

    Ok(out.trim().to_string())
}

// ====================================================================
// XLSX → Markdown table(s)
// ====================================================================

fn convert_xlsx(path: &str) -> Result<String, String> {
    use calamine::{open_workbook_auto, Data, Reader};

    let mut workbook =
        open_workbook_auto(path).map_err(|e| format!("Can't open spreadsheet: {e}"))?;

    let mut out = String::new();
    let sheet_names: Vec<String> = workbook.sheet_names().to_vec();

    for name in &sheet_names {
        if let Ok(range) = workbook.worksheet_range(name) {
            if sheet_names.len() > 1 {
                out.push_str(&format!("## {name}\n\n"));
            }
            let mut first_row = true;
            for row in range.rows() {
                out.push_str("| ");
                let cells: Vec<String> = row
                    .iter()
                    .map(|cell| match cell {
                        Data::Empty => String::new(),
                        Data::String(s) => s.clone(),
                        Data::Float(f) => format!("{f}"),
                        Data::Int(i) => format!("{i}"),
                        Data::Bool(b) => format!("{b}"),
                        Data::Error(e) => format!("#{e:?}"),
                        _ => cell.to_string(),
                    })
                    .collect();
                out.push_str(&cells.join(" | "));
                out.push_str(" |\n");
                if first_row {
                    out.push_str("|");
                    for _ in &cells {
                        out.push_str(" --- |");
                    }
                    out.push('\n');
                    first_row = false;
                }
            }
            out.push('\n');
        }
    }

    Ok(out.trim().to_string())
}

// ====================================================================
// JSON → fenced code block
// ====================================================================

fn convert_json(path: &str) -> Result<String, String> {
    let raw = read_with_encoding(path)?;
    // Pretty-print if valid JSON
    let pretty = serde_json::from_str::<serde_json::Value>(&raw)
        .map(|v| serde_json::to_string_pretty(&v).unwrap_or(raw.clone()))
        .unwrap_or(raw);
    Ok(format!("```json\n{pretty}\n```"))
}

// ====================================================================
// XML → fenced code block
// ====================================================================

fn convert_xml_file(path: &str) -> Result<String, String> {
    let raw = read_with_encoding(path)?;
    Ok(format!("```xml\n{raw}\n```"))
}

// ====================================================================
// PDF → Markdown (text extraction)
// ====================================================================

fn convert_pdf(path: &str) -> Result<String, String> {
    let bytes = std::fs::read(path).map_err(|e| format!("Can't read file: {e}"))?;
    let text = pdf_extract::extract_text_from_mem(&bytes)
        .map_err(|e| format!("PDF extraction failed: {e}"))?;

    if text.trim().is_empty() {
        return Err(
            "No text found in PDF (scanned/image PDF). \
             For OCR, install markitdown: pip install 'markitdown[all]'"
                .to_string(),
        );
    }

    // Basic structure: split by double newlines into paragraphs
    let mut out = String::new();
    for para in text.split("\n\n") {
        let trimmed = para.trim();
        if !trimmed.is_empty() {
            out.push_str(trimmed);
            out.push_str("\n\n");
        }
    }

    Ok(out.trim().to_string())
}

// ====================================================================
// PPTX → Markdown (ZIP of XML, similar to DOCX)
// ====================================================================

fn convert_pptx(path: &str) -> Result<String, String> {
    let file = std::fs::File::open(path).map_err(|e| format!("Can't open file: {e}"))?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| format!("Not a valid PPTX: {e}"))?;

    // Collect slide filenames (ppt/slides/slide1.xml, slide2.xml, ...)
    let mut slide_names: Vec<String> = Vec::new();
    for i in 0..archive.len() {
        if let Ok(entry) = archive.by_index(i) {
            let name = entry.name().to_string();
            if name.starts_with("ppt/slides/slide") && name.ends_with(".xml") {
                slide_names.push(name);
            }
        }
    }
    slide_names.sort();

    let mut out = String::new();

    for (idx, slide_name) in slide_names.iter().enumerate() {
        let mut xml = String::new();
        archive
            .by_name(slide_name)
            .map_err(|e| format!("Can't read {slide_name}: {e}"))?
            .read_to_string(&mut xml)
            .map_err(|e| format!("Read error: {e}"))?;

        let texts = extract_pptx_texts(&xml);
        if !texts.is_empty() {
            out.push_str(&format!("## Slide {}\n\n", idx + 1));
            for text in &texts {
                let trimmed = text.trim();
                if !trimmed.is_empty() {
                    out.push_str(trimmed);
                    out.push_str("\n\n");
                }
            }
        }
    }

    if out.is_empty() {
        return Err("No text content found in PPTX".to_string());
    }

    Ok(out.trim().to_string())
}

/// Extract text runs from a PPTX slide XML. Each <a:p> becomes a separate
/// text block; <a:r><a:t> elements provide the actual text.
fn extract_pptx_texts(xml: &str) -> Vec<String> {
    use quick_xml::events::Event;
    use quick_xml::Reader;

    let mut reader = Reader::from_str(xml);
    let mut paragraphs: Vec<String> = Vec::new();
    let mut current = String::new();
    let mut in_text = false;
    let mut buf = Vec::new();

    loop {
        match reader.read_event_into(&mut buf) {
            Ok(Event::Start(ref e)) => {
                let name = String::from_utf8_lossy(e.local_name().as_ref()).to_string();
                if name == "t" {
                    in_text = true;
                } else if name == "p" {
                    current.clear();
                }
            }
            Ok(Event::Text(ref e)) => {
                if in_text {
                    if let Ok(text) = e.unescape() {
                        current.push_str(&text);
                    }
                }
            }
            Ok(Event::End(ref e)) => {
                let name = String::from_utf8_lossy(e.local_name().as_ref()).to_string();
                if name == "t" {
                    in_text = false;
                } else if name == "p" {
                    let trimmed = current.trim().to_string();
                    if !trimmed.is_empty() {
                        paragraphs.push(trimmed);
                    }
                    current.clear();
                }
            }
            Ok(Event::Eof) => break,
            Err(_) => break,
            _ => {}
        }
        buf.clear();
    }

    paragraphs
}

// ====================================================================
// Fallback: markitdown CLI
// ====================================================================

fn convert_via_markitdown(path: &str) -> Result<String, String> {
    // Check if markitdown is installed
    let which = if cfg!(target_os = "windows") {
        Command::new("where").arg("markitdown").output()
    } else {
        Command::new("which").arg("markitdown").output()
    };

    match which {
        Ok(out) if out.status.success() => {}
        _ => {
            let ext = Path::new(path)
                .extension()
                .and_then(|e| e.to_str())
                .unwrap_or("?");
            return Err(format!(
                "Converting .{ext} files requires markitdown. Install with:\n\
                 pip install 'markitdown[all]'\n\n\
                 Then try again."
            ));
        }
    }

    let output = Command::new("markitdown")
        .arg(path)
        .output()
        .map_err(|e| format!("Failed to run markitdown: {e}"))?;

    if output.status.success() {
        String::from_utf8(output.stdout).map_err(|e| format!("Output encoding error: {e}"))
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr);
        Err(format!("markitdown failed: {stderr}"))
    }
}
