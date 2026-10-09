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

/// Build a `Command` that never flashes a console window on Windows
/// (CREATE_NO_WINDOW). markitdown detection/conversion spawns would otherwise
/// pop a black cmd window for a frame. No-op off Windows.
fn no_window_command(program: impl AsRef<std::ffi::OsStr>) -> Command {
    #[allow(unused_mut)]
    let mut c = Command::new(program);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        c.creation_flags(0x0800_0000);
    }
    c
}
use chardetng::{EncodingDetector, Iso2022JpDetection, Utf8Detection};
use encoding_rs::UTF_8;

/// Main entry point. Returns Markdown string or error.
#[tauri::command]
pub async fn convert_file_to_markdown(path: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || convert_file_to_markdown_inner(path))
        .await
        .map_err(|e| format!("join: {e}"))?
}

pub fn convert_file_to_markdown_inner(path: String) -> Result<String, String> {
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
    // Which list definitions are numbered rather than bulleted. Optional:
    // a document without lists has no numbering part.
    let mut numbering = String::new();
    if let Ok(mut f) = archive.by_name("word/numbering.xml") {
        let _ = f.read_to_string(&mut numbering);
    }

    // Hyperlink targets live in the relationships part, keyed by r:id.
    let mut rels = String::new();
    if let Ok(mut f) = archive.by_name("word/_rels/document.xml.rels") {
        let _ = f.read_to_string(&mut rels);
    }

    docx_xml_to_markdown_with_links(&xml, &docx_ordered_lists(&numbering), &docx_link_targets(&rels))
}

/// `r:id` → URL for external hyperlinks, from document.xml.rels.
fn docx_link_targets(rels_xml: &str) -> std::collections::HashMap<String, String> {
    use quick_xml::events::Event;
    use quick_xml::Reader;
    let mut out = std::collections::HashMap::new();
    let mut reader = Reader::from_str(rels_xml);
    let mut buf = Vec::new();
    loop {
        match reader.read_event_into(&mut buf) {
            Ok(Event::Start(ref e)) | Ok(Event::Empty(ref e))
                if e.local_name().as_ref() == b"Relationship" =>
            {
                let mut id = None;
                let mut target = None;
                let mut is_link = false;
                for a in e.attributes().flatten() {
                    let v = String::from_utf8_lossy(&a.value).to_string();
                    match a.key.as_ref() {
                        b"Id" => id = Some(v),
                        b"Target" => target = Some(v),
                        b"Type" => is_link = v.ends_with("/hyperlink"),
                        _ => {}
                    }
                }
                if let (true, Some(id), Some(t)) = (is_link, id, target) {
                    out.insert(id, t);
                }
            }
            Ok(Event::Eof) | Err(_) => break,
            _ => {}
        }
        buf.clear();
    }
    out
}

/// `numId`s whose level-0 format is a number (`decimal`, `lowerLetter`, …)
/// rather than `bullet`, resolved through `w:num` → `w:abstractNum`.
fn docx_ordered_lists(numbering_xml: &str) -> std::collections::HashSet<String> {
    use quick_xml::events::Event;
    use quick_xml::Reader;
    use std::collections::{HashMap, HashSet};

    let mut abstract_ordered: HashMap<String, bool> = HashMap::new();
    let mut num_to_abstract: HashMap<String, String> = HashMap::new();
    let mut cur_abstract: Option<String> = None;
    let mut cur_num: Option<String> = None;
    let mut cur_lvl: Option<String> = None;
    let mut reader = Reader::from_str(numbering_xml);
    let mut buf = Vec::new();
    let attr = |e: &quick_xml::events::BytesStart, key: &[u8]| -> Option<String> {
        e.attributes()
            .flatten()
            .find(|a| a.key.as_ref() == key)
            .map(|a| String::from_utf8_lossy(&a.value).to_string())
    };
    loop {
        match reader.read_event_into(&mut buf) {
            Ok(Event::Start(ref e)) | Ok(Event::Empty(ref e)) => {
                match e.local_name().as_ref() {
                    b"abstractNum" => cur_abstract = attr(e, b"w:abstractNumId"),
                    b"lvl" => cur_lvl = attr(e, b"w:ilvl"),
                    b"numFmt" => {
                        if let (Some(a), Some("0")) = (&cur_abstract, cur_lvl.as_deref()) {
                            let fmt = attr(e, b"w:val").unwrap_or_default();
                            abstract_ordered.insert(a.clone(), fmt != "bullet" && fmt != "none");
                        }
                    }
                    b"num" => cur_num = attr(e, b"w:numId"),
                    b"abstractNumId" => {
                        if let (Some(n), Some(a)) = (&cur_num, attr(e, b"w:val")) {
                            num_to_abstract.insert(n.clone(), a);
                        }
                    }
                    _ => {}
                }
            }
            Ok(Event::End(ref e)) => match e.local_name().as_ref() {
                b"abstractNum" => cur_abstract = None,
                b"num" => cur_num = None,
                b"lvl" => cur_lvl = None,
                _ => {}
            },
            Ok(Event::Eof) | Err(_) => break,
            _ => {}
        }
        buf.clear();
    }
    num_to_abstract
        .into_iter()
        .filter(|(_, a)| abstract_ordered.get(a).copied().unwrap_or(false))
        .map(|(n, _)| n)
        .collect::<HashSet<_>>()
}

/// Bold/italic text of one paragraph, as runs; adjacent runs with the same
/// formatting are joined so `**a** **b**` doesn't come out as `**a****b**`.
fn render_runs(runs: &[(String, bool, bool)]) -> String {
    let mut merged: Vec<(String, bool, bool)> = Vec::new();
    for (t, b, i) in runs {
        match merged.last_mut() {
            Some(last) if last.1 == *b && last.2 == *i => last.0.push_str(t),
            _ => merged.push((t.clone(), *b, *i)),
        }
    }
    let mut out = String::new();
    for (t, b, i) in merged {
        // Markers can't hug whitespace in Markdown, so keep it outside them.
        let core = t.trim();
        if core.is_empty() || (!b && !i) {
            out.push_str(&t);
            continue;
        }
        let lead = &t[..t.len() - t.trim_start().len()];
        let trail = &t[t.trim_end().len()..];
        let mark = match (b, i) {
            (true, true) => "***",
            (true, false) => "**",
            _ => "*",
        };
        out.push_str(lead);
        out.push_str(mark);
        out.push_str(core);
        out.push_str(mark);
        out.push_str(trail);
    }
    out
}

#[cfg(test)]
fn docx_xml_to_markdown(
    xml: &str,
    ordered_lists: &std::collections::HashSet<String>,
) -> Result<String, String> {
    docx_xml_to_markdown_with_links(xml, ordered_lists, &Default::default())
}

fn docx_xml_to_markdown_with_links(
    xml: &str,
    ordered_lists: &std::collections::HashSet<String>,
    links: &std::collections::HashMap<String, String>,
) -> Result<String, String> {
    use quick_xml::events::Event;
    use quick_xml::Reader;
    use std::collections::HashMap;

    let mut reader = Reader::from_str(xml);
    let mut out = String::new();
    let mut runs: Vec<(String, bool, bool)> = Vec::new();
    let mut in_table_row = false;
    let mut table_cells: Vec<String> = Vec::new();
    let mut table_started = false;
    let mut heading_level: u8 = 0;
    // Run properties: `<w:b/>` is an empty element (no end tag), and
    // `<w:b w:val="0"/>` turns bold *off* — so they are set per run and
    // reset at every `<w:r>`, never left on for the rest of the document.
    let mut is_bold = false;
    let mut is_italic = false;
    let mut in_run_props = false;
    let mut list_style = false;
    let mut num_id: Option<String> = None;
    let mut ilvl: usize = 0;
    let mut prev_was_list = false;
    let mut prev_num_id: Option<String> = None;
    // Next number per (numId, level), reset when the list ends.
    let mut counters: HashMap<(String, usize), usize> = HashMap::new();
    // An open <w:hyperlink>: where its runs start, and its URL if external.
    let mut link_start: Option<(usize, Option<String>)> = None;
    let mut buf = Vec::new();
    let val_of = |e: &quick_xml::events::BytesStart| -> Option<String> {
        e.attributes()
            .flatten()
            .find(|a| a.key.as_ref() == b"w:val")
            .map(|a| String::from_utf8_lossy(&a.value).to_string())
    };
    let on = |v: Option<String>| !matches!(v.as_deref(), Some("0") | Some("false") | Some("none"));

    loop {
        match reader.read_event_into(&mut buf) {
            Ok(Event::Start(ref e)) | Ok(Event::Empty(ref e)) => {
                match e.local_name().as_ref() {
                    b"p" => {
                        runs.clear();
                        heading_level = 0;
                        list_style = false;
                        num_id = None;
                        ilvl = 0;
                    }
                    b"r" => {
                        is_bold = false;
                        is_italic = false;
                    }
                    b"rPr" => in_run_props = true,
                    b"pStyle" => {
                        let val = val_of(e).unwrap_or_default().to_ascii_lowercase();
                        if val.starts_with("heading") || val.starts_with("title") {
                            heading_level = val
                                .chars()
                                .last()
                                .and_then(|c| c.to_digit(10))
                                .unwrap_or(1) as u8;
                        }
                        if val.contains("list") {
                            list_style = true;
                        }
                    }
                    b"numId" => num_id = val_of(e).filter(|v| v != "0"),
                    b"ilvl" => ilvl = val_of(e).and_then(|v| v.parse().ok()).unwrap_or(0),
                    b"b" if in_run_props => is_bold = on(val_of(e)),
                    b"i" if in_run_props => is_italic = on(val_of(e)),
                    b"tr" => {
                        in_table_row = true;
                        table_cells.clear();
                    }
                    b"tc" => runs.clear(),
                    b"hyperlink" => {
                        let url = e
                            .attributes()
                            .flatten()
                            .find(|a| a.key.as_ref() == b"r:id")
                            .and_then(|a| links.get(String::from_utf8_lossy(&a.value).as_ref()).cloned());
                        link_start = Some((runs.len(), url));
                    }
                    _ => {}
                }
            }
            Ok(Event::Text(ref e)) => {
                if let Ok(text) = e.unescape() {
                    runs.push((text.to_string(), is_bold, is_italic));
                }
            }
            Ok(Event::End(ref e)) => match e.local_name().as_ref() {
                b"rPr" => in_run_props = false,
                b"hyperlink" => {
                    if let Some((start, url)) = link_start.take() {
                        if let Some(url) = url {
                            let text = render_runs(&runs[start.min(runs.len())..]);
                            runs.truncate(start.min(runs.len()));
                            runs.push((format!("[{}]({url})", text.trim()), false, false));
                        }
                    }
                }
                b"p" => {
                    let line = render_runs(&runs).trim().to_string();
                    let is_list = num_id.is_some() || list_style;
                    if in_table_row {
                        table_cells.push(line);
                    } else if !line.is_empty() {
                        // A blank line ends a list — and separates two
                        // different lists, which would otherwise run together.
                        if prev_was_list && (!is_list || num_id != prev_num_id) {
                            out.push('\n');
                            if !is_list {
                                counters.clear();
                            }
                        }
                        if heading_level > 0 && heading_level <= 6 {
                            let hashes = "#".repeat(heading_level as usize);
                            out.push_str(&format!("{hashes} {line}\n\n"));
                        } else if is_list {
                            let ordered =
                                num_id.as_ref().is_some_and(|n| ordered_lists.contains(n));
                            let indent = "  ".repeat(ilvl);
                            // A task item exported by SoloMD starts with a ballot box.
                            let (task, body) = if let Some(rest) = line.strip_prefix('☐') {
                                (Some(' '), rest.trim_start())
                            } else if let Some(rest) =
                                line.strip_prefix('☑').or_else(|| line.strip_prefix('☒'))
                            {
                                (Some('x'), rest.trim_start())
                            } else {
                                (None, line.as_str())
                            };
                            let marker = if ordered {
                                let key = (num_id.clone().unwrap_or_default(), ilvl);
                                let n = counters.entry(key).or_insert(0);
                                *n += 1;
                                format!("{n}.")
                            } else {
                                "-".to_string()
                            };
                            match task {
                                Some(c) => out.push_str(&format!("{indent}{marker} [{c}] {body}\n")),
                                None => out.push_str(&format!("{indent}{marker} {body}\n")),
                            }
                        } else {
                            out.push_str(&format!("{line}\n\n"));
                        }
                        prev_was_list = is_list && heading_level == 0;
                        prev_num_id = num_id.clone();
                    }
                    runs.clear();
                }
                b"tr" => {
                    if !table_cells.is_empty() {
                        out.push_str("| ");
                        out.push_str(&table_cells.join(" | "));
                        out.push_str(" |\n");
                        if !table_started {
                            out.push('|');
                            for _ in &table_cells {
                                out.push_str(" --- |");
                            }
                            out.push('\n');
                            table_started = true;
                        }
                    }
                    in_table_row = false;
                }
                b"tbl" => {
                    table_started = false;
                    out.push('\n');
                }
                _ => {}
            },
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

    // Clean up: PDF extraction often includes garbage strings like resource
    // IDs, font hashes, image references (e.g. "30fad226...HZ-3dW6...~~").
    let mut out = String::new();
    for line in text.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            out.push('\n');
            continue;
        }
        if is_pdf_garbage(trimmed) {
            continue;
        }
        // Clean inline garbage within a line
        let cleaned = clean_pdf_line(trimmed);
        let cleaned = cleaned.trim();
        if !cleaned.is_empty() {
            out.push_str(cleaned);
            out.push('\n');
        }
    }

    // Collapse 3+ newlines to 2
    let re = regex_lite::Regex::new(r"\n{3,}").unwrap();
    let out = re.replace_all(&out, "\n\n");

    Ok(out.trim().to_string())
}

/// Detect garbage lines from PDF extraction: resource IDs, font hashes, etc.
fn is_pdf_garbage(line: &str) -> bool {
    // Lines that are mostly hex/base64 hash-like characters (no spaces, long)
    if line.len() > 20 && !line.contains(' ') {
        let alnum = line.chars().filter(|c| c.is_alphanumeric() || *c == '-' || *c == '_' || *c == '~').count();
        if alnum as f64 / line.len() as f64 > 0.85 {
            return true;
        }
    }
    // Lines ending with ~~ are typically resource references
    if line.ends_with("~~") && line.len() > 10 {
        return true;
    }
    false
}

/// Remove inline garbage tokens from a line (hash-like strings mixed with text).
fn clean_pdf_line(line: &str) -> String {
    let mut result = String::new();
    for word in line.split_whitespace() {
        if is_pdf_garbage(word) {
            continue;
        }
        if !result.is_empty() {
            result.push(' ');
        }
        result.push_str(word);
    }
    result
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
        no_window_command("where").arg("markitdown").output()
    } else {
        no_window_command("which").arg("markitdown").output()
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

    let output = no_window_command("markitdown")
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

#[cfg(test)]
mod docx_import_tests {
    use super::*;

    fn p(inner: &str) -> String {
        format!("<w:p>{inner}</w:p>")
    }
    fn r(text: &str, props: &str) -> String {
        format!("<w:r><w:rPr>{props}</w:rPr><w:t xml:space=\"preserve\">{text}</w:t></w:r>")
    }
    fn doc(body: &str) -> String {
        format!("<w:document><w:body>{body}</w:body></w:document>")
    }
    fn li(num: &str, lvl: u8, text: &str) -> String {
        p(&format!(
            "<w:pPr><w:numPr><w:ilvl w:val=\"{lvl}\"/><w:numId w:val=\"{num}\"/></w:numPr></w:pPr>{}",
            r(text, "")
        ))
    }

    #[test]
    fn bold_from_an_empty_b_element_does_not_leak() {
        // `<w:b/>` never gets an end tag — it used to stay on for the rest
        // of the document ("**bold**** and a ****link**").
        let xml = doc(&p(&format!(
            "{}{}{}",
            r("Intro with ", ""),
            r("bold", "<w:b/>"),
            r(" and plain.", "")
        )));
        let md = docx_xml_to_markdown(&xml, &Default::default()).unwrap();
        assert_eq!(md, "Intro with **bold** and plain.");
    }

    #[test]
    fn b_val_zero_turns_bold_off_and_adjacent_runs_merge() {
        let xml = doc(&p(&format!(
            "{}{}{}",
            r("one ", "<w:b/>"),
            r("two", "<w:b/>"),
            r(" three", "<w:b w:val=\"0\"/>")
        )));
        let md = docx_xml_to_markdown(&xml, &Default::default()).unwrap();
        assert_eq!(md, "**one two** three");
    }

    #[test]
    fn ordered_and_bullet_lists_and_tasks_round_trip() {
        let mut ordered = std::collections::HashSet::new();
        ordered.insert("2".to_string());
        let xml = doc(&format!(
            "{}{}{}{}{}{}",
            li("1", 0, "☐ open task"),
            li("1", 0, "☑ done task"),
            li("2", 0, "first"),
            li("2", 0, "second"),
            li("2", 1, "nested"),
            p(&r("After the list.", ""))
        ));
        let md = docx_xml_to_markdown(&xml, &ordered).unwrap();
        assert_eq!(
            md,
            "- [ ] open task\n- [x] done task\n\n1. first\n2. second\n  1. nested\n\nAfter the list."
        );
    }

    #[test]
    fn external_hyperlinks_keep_their_url() {
        let mut links = std::collections::HashMap::new();
        links.insert("rId9".to_string(), "https://example.com/target".to_string());
        let xml = doc(&p(&format!(
            "{}<w:hyperlink r:id=\"rId9\">{}</w:hyperlink>{}",
            r("See ", ""),
            r("the target", ""),
            r(".", "")
        )));
        let md = docx_xml_to_markdown_with_links(&xml, &Default::default(), &links).unwrap();
        assert_eq!(md, "See [the target](https://example.com/target).");
    }

    #[test]
    fn rels_part_maps_hyperlink_ids() {
        let rels = r#"<Relationships><Relationship Id="rId9" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://example.com/x" TargetMode="External"/><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>"#;
        let m = docx_link_targets(rels);
        assert_eq!(m.get("rId9").map(String::as_str), Some("https://example.com/x"));
        assert!(!m.contains_key("rId1"));
    }

    #[test]
    fn numbering_part_tells_numbered_from_bulleted() {
        let numbering = r#"<w:numbering>
          <w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:numFmt w:val="bullet"/></w:lvl></w:abstractNum>
          <w:abstractNum w:abstractNumId="1"><w:lvl w:ilvl="0"><w:numFmt w:val="decimal"/></w:lvl><w:lvl w:ilvl="1"><w:numFmt w:val="bullet"/></w:lvl></w:abstractNum>
          <w:num w:numId="5"><w:abstractNumId w:val="0"/></w:num>
          <w:num w:numId="6"><w:abstractNumId w:val="1"/></w:num>
        </w:numbering>"#;
        let set = docx_ordered_lists(numbering);
        assert!(set.contains("6"));
        assert!(!set.contains("5"));
    }
}
