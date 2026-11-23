use chardetng::{EncodingDetector, Iso2022JpDetection, Utf8Detection};
use encoding_rs::{Encoding, UTF_8};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::Path;

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct FileReadResult {
    pub content: String,
    pub encoding: String,
    pub language: String,
    pub had_bom: bool,
}

/// Read a file from disk, auto-detecting its text encoding (UTF-8/16, GBK, etc.)
/// and returning UTF-8 content along with the original encoding label so we can
/// re-save in the same encoding later.
///
/// Async wrapper to keep file I/O off the IPC thread — see the audit note in
/// `feedback_tauri_sync_command_audit.md`. The inner is exposed for tests.
#[tauri::command]
pub async fn read_file(path: String) -> Result<FileReadResult, String> {
    tauri::async_runtime::spawn_blocking(move || read_file_inner(path))
        .await
        .map_err(|e| format!("join: {e}"))?
}

pub fn read_file_inner(path: String) -> Result<FileReadResult, String> {
    // #139 — iOS delivers a Files-app open as a copy in the app's volatile
    // `tmp/<bundleid>-Inbox/` dir. That copy can lag behind the open event or
    // be reclaimed by the system, so a single `fs::read` intermittently hit
    // ENOENT ("looked successful sometimes"). Retry briefly on NotFound to win
    // the race; if it still fails, attach the parent-dir listing so the cause
    // (empty dir = gone, other name = mismatch, missing dir = bad path) is
    // visible in the diagnostic. iOS-only: on desktop a missing file is just
    // missing (stale recent, moved in Finder) and should fail fast, not stall
    // a spawn_blocking slot for 800ms. Non-NotFound errors return immediately.
    let bytes = match fs::read(&path) {
        Ok(b) => b,
        #[cfg(target_os = "ios")]
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            // Keep the LAST error, not the initial NotFound: if the file shows
            // up mid-retry but with a transient permission/IO error, that is
            // the truthful cause to report.
            let mut last_err = e;
            let mut recovered: Option<Vec<u8>> = None;
            for _ in 0..8 {
                std::thread::sleep(std::time::Duration::from_millis(100));
                match fs::read(&path) {
                    Ok(b) => {
                        recovered = Some(b);
                        break;
                    }
                    Err(re) => last_err = re,
                }
            }
            match recovered {
                Some(b) => b,
                None => {
                    let listing = match Path::new(&path).parent() {
                        Some(dir) => match fs::read_dir(dir) {
                            Ok(rd) => {
                                let names: Vec<String> = rd
                                    .filter_map(|e| e.ok())
                                    .map(|e| e.file_name().to_string_lossy().into_owned())
                                    .collect();
                                format!("dir {} => [{}]", dir.display(), names.join(", "))
                            }
                            Err(de) => format!("dir {} unreadable: {de}", dir.display()),
                        },
                        None => "no parent dir".to_string(),
                    };
                    return Err(format!("read failed: {last_err} | {listing}"));
                }
            }
        }
        Err(e) => return Err(format!("read failed: {e}")),
    };

    // Try BOM first.
    let (encoding, had_bom, body) = if let Some((enc, bom_len)) = sniff_bom(&bytes) {
        (enc, true, &bytes[bom_len..])
    } else {
        // chardetng for everything else.
        let mut detector = EncodingDetector::new(Iso2022JpDetection::Allow);
        detector.feed(&bytes, true);
        let enc = detector.guess(None, Utf8Detection::Allow);
        (enc, false, bytes.as_slice())
    };

    let (cow, _used_enc, had_errors) = encoding.decode_without_bom_handling_and_without_replacement(body)
        .map(|c| (c, encoding, false))
        .unwrap_or_else(|| {
            let (c, used, errs) = encoding.decode(body);
            (c, used, errs)
        });

    if had_errors {
        // Fall back to lossy UTF-8 so the user sees something rather than an error.
        let lossy = String::from_utf8_lossy(body).into_owned();
        return Ok(FileReadResult {
            content: lossy,
            encoding: encoding.name().to_string(),
            language: detect_language(&path),
            had_bom,
        });
    }

    Ok(FileReadResult {
        content: cow.into_owned(),
        encoding: encoding.name().to_string(),
        language: detect_language(&path),
        had_bom,
    })
}

/// Write a UTF-8 string back to disk in the requested encoding.
/// `encoding` should be a label like "UTF-8", "GBK", "UTF-16LE".
///
/// v4.0 Pillar 2 — also fires the `on-save` / `on-tag-add` recipe
/// triggers if the saved file lives inside the active workspace. The
/// dispatch is async + best-effort so a save never blocks on a recipe.
/// `workspace` is optional; when absent, no recipe dispatch happens
/// (this keeps callers that save scratch files outside any workspace
/// from accidentally triggering recipes against the wrong vault).
#[tauri::command]
pub async fn write_file(
    app: tauri::AppHandle,
    path: String,
    content: String,
    encoding: String,
    workspace: Option<String>,
) -> Result<(), String> {
    let path_for_dispatch = path.clone();
    let content_for_dispatch = content.clone();
    let app_for_write = app.clone();
    tauri::async_runtime::spawn_blocking({
        let path = path.clone();
        let content = content.clone();
        move || {
            #[cfg(target_os = "android")]
            if path.starts_with("content://") {
                let bytes = encode_for_disk(&content, &encoding)?;
                return write_android_content_uri(&app_for_write, &path, &bytes);
            }
            #[cfg(not(target_os = "android"))]
            let _ = &app_for_write;
            write_file_inner(path, content, encoding)
        }
    })
    .await
    .map_err(|e| format!("join: {e}"))??;

    // #621 — Immediately refresh the workspace index for the saved file so
    // removed/edited tags disappear from the Tags panel & sidebar right away.
    #[cfg(not(target_os = "android"))]
    super::workspace_index::reindex_path(&app, std::path::Path::new(&path_for_dispatch));

    // After a successful save, fire the on-save / on-tag-add triggers
    // for the active workspace. We re-extract tags from the *content*
    // we just wrote (rather than re-reading from disk) so the trigger
    // sees the same bytes the user just saved.
    #[cfg(not(target_os = "android"))]
    if let Some(ws) = workspace {
        let ws_path = std::path::PathBuf::from(&ws);
        let new_tags = extract_tags_for_dispatch(&content_for_dispatch);
        // Detached — we don't want the save IPC call to wait on a
        // recipe firing.
        tauri::async_runtime::spawn(async move {
            super::recipe_runner::dispatch_on_save(app, ws_path, path_for_dispatch, new_tags).await;
        });
    }
    #[cfg(target_os = "android")]
    {
        let _ = (workspace, content_for_dispatch, path_for_dispatch, app);
    }

    Ok(())
}

/// Quick-and-dirty tag extraction used by the on-tag-add trigger. We
/// reuse the same scanner shape as `mcp-server/src/workspace.rs` —
/// duplicated here because P4 (Federation) hasn't merged yet and we
/// don't want to depend on the mcp-server crate from inside the Tauri
/// app. After P4 lands, swap this for the canonical helper.
///
/// Android disables the recipe-runner / on-save trigger surface (AutoGit
/// and the whole desktop-class workflow), so this helper is unused on
/// that target. cfg-gating the definition silences the dead_code
/// warning that started showing up after v4.0 Android port landed.
#[cfg(not(target_os = "android"))]
fn extract_tags_for_dispatch(body: &str) -> Vec<String> {
    let mut tags: Vec<String> = Vec::new();
    let mut in_fence = false;
    for line in body.lines() {
        if line.trim_start().starts_with("```") {
            in_fence = !in_fence;
            continue;
        }
        if in_fence {
            continue;
        }
        let chars: Vec<char> = line.chars().collect();
        let mut i = 0;
        while i < chars.len() {
            let c = chars[i];
            let preceded_ok = i == 0 || chars[i - 1].is_whitespace();
            if c == '#' && preceded_ok {
                if i + 1 < chars.len() && chars[i + 1].is_alphanumeric() {
                    let mut j = i + 1;
                    while j < chars.len()
                        && (chars[j].is_alphanumeric()
                            || chars[j] == '_'
                            || chars[j] == '/'
                            || chars[j] == '-')
                    {
                        j += 1;
                    }
                    tags.push(chars[i + 1..j].iter().collect());
                    i = j;
                    continue;
                }
            }
            i += 1;
        }
    }
    tags.sort();
    tags.dedup();
    tags
}

/// Encode `content` into the bytes that go on disk for `encoding`.
///
/// encoding_rs's `Encoding::encode` never produces UTF-16: per the WHATWG
/// spec the *output encoding* of UTF-16LE/BE is UTF-8, so a UTF-16 file
/// used to be silently rewritten as UTF-8. UTF-16 is therefore encoded by
/// hand, always with a BOM — the reader only recognises UTF-16 by its BOM
/// (chardetng never guesses UTF-16), so a BOM-less write would not reopen
/// as UTF-16.
pub fn encode_for_disk(content: &str, encoding: &str) -> Result<Vec<u8>, String> {
    let enc = Encoding::for_label(encoding.as_bytes()).unwrap_or(UTF_8);
    if enc == encoding_rs::UTF_16LE || enc == encoding_rs::UTF_16BE {
        let le = enc == encoding_rs::UTF_16LE;
        let mut out = Vec::with_capacity(2 + content.len() * 2);
        out.extend_from_slice(if le { &[0xFF, 0xFE] } else { &[0xFE, 0xFF] });
        for unit in content.encode_utf16() {
            out.extend_from_slice(&if le {
                unit.to_le_bytes()
            } else {
                unit.to_be_bytes()
            });
        }
        return Ok(out);
    }
    let (cow, _, had_errors) = enc.encode(content);
    if had_errors {
        return Err(format!(
            "Some characters cannot be represented in {}",
            enc.name()
        ));
    }
    Ok(cow.into_owned())
}

pub fn write_file_inner(path: String, content: String, encoding: String) -> Result<(), String> {
    let bytes = encode_for_disk(&content, &encoding)?;
    fs::write(&path, &bytes).map_err(|e| format!("write failed: {e}"))?;

    super::watcher::mark_self_write(&path);

    Ok(())
}

/// Read raw bytes from disk. v3.5: counterpart to `write_binary_file` —
/// the export pipeline (PDF / DOCX / PNG) needs to embed local images
/// into the output document, which means it has to read those image
/// bytes regardless of the webview's CSP. Returns a `Vec<u8>`; on the
/// JS side this lands as `number[]` so the caller can construct a Blob
/// or base64-encode for the renderer. Async + spawn_blocking like its
/// siblings so a slow disk doesn't queue parallel IPC calls.
#[tauri::command]
pub async fn read_binary_file(path: String) -> Result<Vec<u8>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        fs::read(&path).map_err(|e| format!("read failed: {e}"))
    })
    .await
    .map_err(|e| format!("join: {e}"))?
}

/// Upper bound for `fetch_image_bytes`: an image bigger than this is not
/// something anyone means to paste into a forum post, and it keeps a bad URL
/// from streaming an arbitrary amount of data into memory.
const FETCH_IMAGE_MAX_BYTES: usize = 50 * 1024 * 1024;

/// #362 — fetch a remote (http/https) image's bytes for "Copy image".
///
/// The webview can display a remote `<img>` but can't read its pixels: a
/// cross-origin image without CORS headers taints the canvas, and `fetch()`
/// from the page is blocked by the same rule. Fetching from Rust has no such
/// restriction. Only http(s) URLs are accepted; the body is capped at
/// `FETCH_IMAGE_MAX_BYTES`.
#[tauri::command]
pub async fn fetch_image_bytes(url: String) -> Result<Vec<u8>, String> {
    let lower = url.to_ascii_lowercase();
    if !(lower.starts_with("http://") || lower.starts_with("https://")) {
        return Err("only http(s) URLs can be fetched".into());
    }
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .user_agent(concat!("SoloMD/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|e| format!("client: {e}"))?;
    let resp = client
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("request failed: {e}"))?;
    let status = resp.status();
    if !status.is_success() {
        return Err(format!("HTTP {status}"));
    }
    if let Some(len) = resp.content_length() {
        if len as usize > FETCH_IMAGE_MAX_BYTES {
            return Err("image is too large".into());
        }
    }
    let bytes = resp
        .bytes()
        .await
        .map_err(|e| format!("read failed: {e}"))?;
    if bytes.len() > FETCH_IMAGE_MAX_BYTES {
        return Err("image is too large".into());
    }
    Ok(bytes.to_vec())
}

/// Write raw bytes to disk. Used for binary export targets like DOCX/PDF.
#[tauri::command]
pub async fn write_binary_file(
    app: tauri::AppHandle,
    path: String,
    data: Vec<u8>,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        #[cfg(target_os = "android")]
        if path.starts_with("content://") {
            return write_android_content_uri(&app, &path, &data);
        }
        #[cfg(not(target_os = "android"))]
        let _ = &app;
        write_binary_file_inner(path, data)
    })
    .await
    .map_err(|e| format!("join: {e}"))?
}

/// #148 / Android export fix — `saveDialog` on Android launches SAF's
/// `Intent.ACTION_CREATE_DOCUMENT` and returns a `content://` URI, which
/// `std::fs::write` / `std::fs::create_dir_all` cannot open (attempting to
/// `mkdir("content:/...")` on Android's read-only `/` rootfs fails with
/// `EROFS` / `ENOENT` and leaves a 0-byte file). Write through ContentResolver
/// via `tauri_plugin_fs::FsExt`, falling back to `MainActivity.writeContentUriBase64`
/// for providers that reject `"wt"` on `openAssetFileDescriptor`.
#[cfg(target_os = "android")]
fn write_android_content_uri(
    app: &tauri::AppHandle,
    uri: &str,
    data: &[u8],
) -> Result<(), String> {
    use std::io::Write;
    use std::str::FromStr;
    use tauri_plugin_fs::{FilePath, FsExt, OpenOptions};

    let Ok(fp) = FilePath::from_str(uri);
    let mut opts = OpenOptions::new();
    opts.read(false).write(true).create(true).truncate(true);
    if let Ok(mut file) = app.fs().open(fp, opts) {
        if file.write_all(data).and_then(|()| file.flush()).is_ok() {
            return Ok(());
        }
    }
    super::saf_android::write_content_uri_bytes(uri, data)
}

pub fn write_binary_file_inner(path: String, data: Vec<u8>) -> Result<(), String> {
    if let Some(parent) = Path::new(&path).parent() {
        if !parent.as_os_str().is_empty() {
            fs::create_dir_all(parent)
                .map_err(|e| format!("mkdir failed: {e}"))?;
        }
    }
    fs::write(&path, &data).map_err(|e| format!("write failed: {e}"))?;
    // #148 follow-up — binary writes (content:// imports, pasted images) are
    // our own writes too; without the mark, a late watcher event for them
    // pops the "File Changed on Disk" dialog on the file the user just opened.
    super::watcher::mark_self_write(&path);
    Ok(())
}

/// Trigger the OS native print dialog for the given webview window. The
/// frontend should first mount a print-friendly overlay so only the rendered
/// markdown (not the editor UI) is included in the print.
///
/// Why here instead of `window.print()` in JS? WKWebView on macOS silently
/// no-ops `window.print()`, so the native call is the only way.
///
/// iOS / Android: `WebviewWindow::print()` doesn't exist on mobile in Tauri 2
/// (no system print dialog), so we expose a no-op there to keep `tauri::generate_handler!`
/// happy. The JS side never invokes this on mobile anyway — Print is gated behind
/// the macOS / Windows / Linux toolbar entry.
#[cfg(desktop)]
#[tauri::command]
pub fn print_webview(window: tauri::WebviewWindow) -> Result<(), String> {
    window.print().map_err(|e| format!("print failed: {e}"))
}

/// macOS "Export PDF (text)": write the print layout straight to `path`.
///
/// `print_webview` opens the system print sheet, and on a Mac with no printer
/// set up that sheet asks the user to add one before it shows "Save as PDF"
/// — people read that as "exporting a PDF needs a printer". This runs the
/// same WKWebView print operation (same @media print layout, real selectable
/// text) as a save job: NSPrintSaveJob + NSPrintJobSavingURL, with the print
/// and progress panels off, so no printer is ever involved.
///
/// `paper` / `margins` are in points (1/72 in) when the user chose a page
/// size (Settings → PDF or `pdf:` front matter); otherwise the system default
/// paper is used, as the print sheet would.
#[cfg(target_os = "macos")]
#[tauri::command]
pub async fn print_webview_to_pdf(
    window: tauri::WebviewWindow,
    path: String,
    paper: Option<(f64, f64)>,
    margins: Option<(f64, f64, f64, f64)>,
    outlines: Option<Vec<(u8, String, usize, f64)>>,
) -> Result<(), String> {
    use objc2::runtime::AnyObject;
    use objc2::{class, msg_send};
    use objc2_foundation::{NSPoint, NSSize, NSString, NSURL};

    #[link(name = "AppKit", kind = "framework")]
    extern "C" {
        static NSPrintSaveJob: &'static NSString;
        static NSPrintJobSavingURL: &'static NSString;
    }

    #[link(name = "PDFKit", kind = "framework")]
    extern "C" {}

    if let Some(parent) = std::path::Path::new(&path).parent() {
        if !parent.as_os_str().is_empty() {
            let _ = std::fs::create_dir_all(parent);
        }
    }
    let _ = std::fs::remove_file(&path);
    let (tx, rx) = std::sync::mpsc::channel::<Result<(), String>>();
    let target = path.clone();
    window
        .with_webview(move |wv| unsafe {
            let webview = wv.inner() as *mut AnyObject;
            if webview.is_null() {
                let _ = tx.send(Err("no webview".into()));
                return;
            }
            let shared: *mut AnyObject = msg_send![class!(NSPrintInfo), sharedPrintInfo];
            let info: *mut AnyObject = msg_send![shared, copy];
            let _: () = msg_send![info, setJobDisposition: NSPrintSaveJob];
            let url = NSURL::fileURLWithPath(&NSString::from_str(&target));
            let dict: *mut AnyObject = msg_send![info, dictionary];
            let _: () = msg_send![dict, setObject: &*url, forKey: NSPrintJobSavingURL];
            if let Some((w, h)) = paper {
                let _: () = msg_send![info, setPaperSize: NSSize::new(w, h)];
            }
            // Same as Tauri's own print (wry's print_with_options): margins
            // default to 0 and the @page / overlay CSS does the spacing, so
            // the file matches what the print sheet produced.
            let (top, right, bottom, left) = margins.unwrap_or((0.0, 0.0, 0.0, 0.0));
            let _: () = msg_send![info, setTopMargin: top];
            let _: () = msg_send![info, setRightMargin: right];
            let _: () = msg_send![info, setBottomMargin: bottom];
            let _: () = msg_send![info, setLeftMargin: left];
            let op: *mut AnyObject = msg_send![webview, printOperationWithPrintInfo: info];
            let _: () = msg_send![info, release];
            if op.is_null() {
                let _ = tx.send(Err("WKWebView returned no print operation".into()));
                return;
            }
            let _: () = msg_send![op, setShowsPrintPanel: false];
            let _: () = msg_send![op, setShowsProgressPanel: false];
            let _: () = msg_send![op, setCanSpawnSeparateThread: true];
            // Window-modal, like wry. (A synchronous `runOperation` on a
            // WKWebView print operation never finishes paginating: it kept
            // appending pages until the file passed 400 MB.) It returns at
            // once; completion is detected from the file below.
            let nswindow: *mut AnyObject = msg_send![webview, window];
            let nil: *mut AnyObject = std::ptr::null_mut();
            let _: () = msg_send![
                op,
                runOperationModalForWindow: nswindow,
                delegate: nil,
                didRunSelector: None::<objc2::runtime::Sel>,
                contextInfo: std::ptr::null_mut::<std::ffi::c_void>()
            ];
            let _ = tx.send(Ok(()));
        })
        .map_err(|e| format!("with_webview: {e}"))?;
    rx.recv_timeout(std::time::Duration::from_secs(10))
        .map_err(|_| "could not start the print operation".to_string())??;
    // Done when the file is a complete PDF (ends with %%EOF) and has stopped
    // growing. Bounded in time and size so a runaway job can't fill the disk.
    let path2 = path.clone();
    tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        use std::io::{Read, Seek, SeekFrom};
        const MAX_BYTES: u64 = 200 * 1024 * 1024;
        let start = std::time::Instant::now();
        let mut last = 0u64;
        let mut stable = 0u32;
        loop {
            std::thread::sleep(std::time::Duration::from_millis(250));
            if start.elapsed() > std::time::Duration::from_secs(120) {
                return Err("PDF export timed out".into());
            }
            let Ok(meta) = std::fs::metadata(&path2) else { continue };
            let len = meta.len();
            if len > MAX_BYTES {
                return Err("PDF export stopped: the file grew past 200 MB".into());
            }
            if len == 0 || len != last {
                last = len;
                stable = 0;
                continue;
            }
            stable += 1;
            if stable < 2 {
                continue;
            }
            let mut f = std::fs::File::open(&path2).map_err(|e| e.to_string())?;
            let tail = len.min(1024);
            f.seek(SeekFrom::End(-(tail as i64))).map_err(|e| e.to_string())?;
            let mut buf = Vec::new();
            f.read_to_end(&mut buf).map_err(|e| e.to_string())?;
            if buf.windows(5).any(|w| w == b"%%EOF") {
                if let Some(items) = outlines.as_ref().filter(|v| !v.is_empty()) {
                    unsafe {
                        let url = NSURL::fileURLWithPath(&NSString::from_str(&path2));
                        let doc_alloc: *mut AnyObject = msg_send![class!(PDFDocument), alloc];
                        let doc: *mut AnyObject = msg_send![doc_alloc, initWithURL: &*url];
                        if !doc.is_null() {
                            let page_count: usize = msg_send![doc, pageCount];
                            if page_count > 0 {
                                let page_h = paper.map(|(_, h)| h).unwrap_or(841.89);
                                let (top_m, bottom_m) = margins
                                    .map(|(t, _, b, _)| (t, b))
                                    .unwrap_or((42.52, 42.52));
                                let printable_h = (page_h - top_m - bottom_m).max(1.0);
                                let root: *mut AnyObject = msg_send![class!(PDFOutline), new];
                                let mut stack: Vec<(u8, *mut AnyObject)> = Vec::new();
                                for (level, label, page_num, y_ratio) in items {
                                    let idx = page_num.saturating_sub(1).min(page_count - 1);
                                    let page: *mut AnyObject = msg_send![doc, pageAtIndex: idx];
                                    if page.is_null() {
                                        continue;
                                    }
                                    let child: *mut AnyObject = msg_send![class!(PDFOutline), new];
                                    let label_ns = NSString::from_str(label);
                                    let _: () = msg_send![child, setLabel: &*label_ns];
                                    let dest_alloc: *mut AnyObject =
                                        msg_send![class!(PDFDestination), alloc];
                                    let clamped_ratio = y_ratio.clamp(0.0, 1.0);
                                    let target_y = (page_h - top_m - clamped_ratio * printable_h + 12.0)
                                        .clamp(0.0, page_h);
                                    let dest: *mut AnyObject = msg_send![
                                        dest_alloc,
                                        initWithPage: page,
                                        atPoint: NSPoint::new(0.0, target_y)
                                    ];
                                    if !dest.is_null() {
                                        let _: () = msg_send![child, setDestination: dest];
                                        let _: () = msg_send![dest, release];
                                    }
                                    while stack.last().is_some_and(|(l, _)| *l >= *level) {
                                        stack.pop();
                                    }
                                    let parent = stack.last().map_or(root, |(_, node)| *node);
                                    let n_children: usize = msg_send![parent, numberOfChildren];
                                    let _: () =
                                        msg_send![parent, insertChild: child, atIndex: n_children];
                                    let _: () = msg_send![child, release];
                                    stack.push((*level, child));
                                }
                                let _: () = msg_send![doc, setOutlineRoot: root];
                                let _: bool = msg_send![doc, writeToURL: &*url];
                                let _: () = msg_send![root, release];
                            }
                            let _: () = msg_send![doc, release];
                        }
                    }
                }
                return Ok(());
            }
        }
    })
    .await
    .map_err(|e| format!("join: {e}"))?
}

/// #607 / #552 / #625 — Inject hierarchical UTF-16BE BOM PDF outlines (bookmarks)
/// into a generated vector PDF file using `lopdf` (used on Windows & Linux where
/// macOS PDFKit is not available), with explicit `/XYZ` Y-coordinates so PDF
/// viewers scroll directly to each heading instead of leaving vertical scroll stuck.
#[allow(dead_code)]
fn inject_pdf_outlines_lopdf(
    path: &str,
    items: &[(u8, String, usize, f64)],
    margins: Option<(f64, f64, f64, f64)>,
) -> Result<(), String> {
    use lopdf::{Dictionary, Document, Object, ObjectId, StringFormat};

    if items.is_empty() {
        return Ok(());
    }
    let mut doc = Document::load(path).map_err(|e| format!("load pdf for outlines: {e}"))?;
    let pages = doc.get_pages();
    if pages.is_empty() {
        return Ok(());
    }
    let page_ids: Vec<ObjectId> = pages.values().copied().collect();
    let page_count = page_ids.len();

    fn media_box_height(doc: &Document, mut obj_id: ObjectId) -> Option<f64> {
        for _ in 0..8 {
            let dict = doc.get_object(obj_id).ok()?.as_dict().ok()?;
            if let Ok(mb) = dict.get(b"MediaBox") {
                let arr = match mb {
                    Object::Array(a) => Some(a),
                    Object::Reference(r) => doc.get_object(*r).ok().and_then(|o| o.as_array().ok()),
                    _ => None,
                };
                if let Some(a) = arr {
                    if a.len() >= 4 {
                        let y1 = match &a[1] {
                            Object::Integer(v) => *v as f64,
                            Object::Real(v) => *v as f64,
                            _ => 0.0,
                        };
                        let y2 = match &a[3] {
                            Object::Integer(v) => *v as f64,
                            Object::Real(v) => *v as f64,
                            _ => 841.89,
                        };
                        let h = (y2 - y1).abs();
                        if h > 1.0 {
                            return Some(h);
                        }
                    }
                }
            }
            obj_id = dict.get(b"Parent").ok()?.as_reference().ok()?;
        }
        None
    }

    let (top_m, bottom_m) = margins.map(|(t, _, b, _)| (t, b)).unwrap_or((42.52, 42.52));

    struct Node {
        title: String,
        page_obj: ObjectId,
        target_y: f32,
        children: Vec<usize>,
        obj_id: ObjectId,
    }

    let root_id = doc.new_object_id();
    let mut nodes: Vec<Node> = Vec::with_capacity(items.len());
    let mut top_indices: Vec<usize> = Vec::new();
    let mut stack: Vec<(u8, usize)> = Vec::new();

    for (level, label, page_num, y_ratio) in items {
        let idx = page_num.saturating_sub(1).min(page_count - 1);
        let page_obj = page_ids[idx];
        let page_h = media_box_height(&doc, page_obj).unwrap_or(841.89);
        let printable_h = (page_h - top_m - bottom_m).max(1.0);
        let clamped_ratio = y_ratio.clamp(0.0, 1.0);
        let target_y = (page_h - top_m - clamped_ratio * printable_h + 12.0).clamp(0.0, page_h) as f32;
        let node_idx = nodes.len();
        let obj_id = doc.new_object_id();
        nodes.push(Node {
            title: label.clone(),
            page_obj,
            target_y,
            children: Vec::new(),
            obj_id,
        });
        while stack.last().is_some_and(|(l, _)| *l >= *level) {
            stack.pop();
        }
        if let Some((_, parent_idx)) = stack.last() {
            nodes[*parent_idx].children.push(node_idx);
        } else {
            top_indices.push(node_idx);
        }
        stack.push((*level, node_idx));
    }

    fn utf16be_bom_bytes(s: &str) -> Vec<u8> {
        let mut out = Vec::with_capacity(2 + s.len() * 2);
        out.push(0xFE);
        out.push(0xFF);
        for u in s.encode_utf16() {
            out.extend_from_slice(&u.to_be_bytes());
        }
        out
    }

    fn count_descendants(nodes: &[Node], indices: &[usize]) -> i64 {
        let mut total = indices.len() as i64;
        for &idx in indices {
            total += count_descendants(nodes, &nodes[idx].children);
        }
        total
    }

    fn populate_siblings(
        doc: &mut Document,
        nodes: &[Node],
        siblings: &[usize],
        parent_id: ObjectId,
    ) {
        for (pos, &node_idx) in siblings.iter().enumerate() {
            let node = &nodes[node_idx];
            let mut dict = Dictionary::new();
            dict.set(
                "Title",
                Object::String(utf16be_bom_bytes(&node.title), StringFormat::Hexadecimal),
            );
            dict.set("Parent", parent_id);
            dict.set(
                "Dest",
                Object::Array(vec![
                    node.page_obj.into(),
                    Object::Name(b"XYZ".to_vec()),
                    Object::Real(0.0),
                    Object::Real(node.target_y),
                    Object::Null,
                ]),
            );
            if pos > 0 {
                dict.set("Prev", nodes[siblings[pos - 1]].obj_id);
            }
            if pos + 1 < siblings.len() {
                dict.set("Next", nodes[siblings[pos + 1]].obj_id);
            }
            if !node.children.is_empty() {
                dict.set("First", nodes[node.children[0]].obj_id);
                dict.set("Last", nodes[*node.children.last().unwrap()].obj_id);
                dict.set(
                    "Count",
                    Object::Integer(count_descendants(nodes, &node.children)),
                );
                populate_siblings(doc, nodes, &node.children, node.obj_id);
            }
            doc.objects.insert(node.obj_id, Object::Dictionary(dict));
        }
    }

    populate_siblings(&mut doc, &nodes, &top_indices, root_id);

    let mut root_dict = Dictionary::new();
    root_dict.set("Type", Object::Name(b"Outlines".to_vec()));
    if !top_indices.is_empty() {
        root_dict.set("First", nodes[top_indices[0]].obj_id);
        root_dict.set("Last", nodes[*top_indices.last().unwrap()].obj_id);
        root_dict.set(
            "Count",
            Object::Integer(count_descendants(&nodes, &top_indices)),
        );
    }
    doc.objects.insert(root_id, Object::Dictionary(root_dict));

    if let Ok(catalog) = doc.catalog_mut() {
        catalog.set("Outlines", root_id);
    }
    doc.save(path).map_err(|e| format!("save pdf outlines: {e}"))?;
    Ok(())
}

#[cfg(target_os = "windows")]
#[tauri::command]
pub async fn print_webview_to_pdf(
    window: tauri::WebviewWindow,
    path: String,
    paper: Option<(f64, f64)>,
    margins: Option<(f64, f64, f64, f64)>,
    outlines: Option<Vec<(u8, String, usize, f64)>>,
) -> Result<(), String> {
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        ICoreWebView2Environment6, ICoreWebView2_2, ICoreWebView2_7,
        COREWEBVIEW2_PRINT_ORIENTATION_LANDSCAPE, COREWEBVIEW2_PRINT_ORIENTATION_PORTRAIT,
    };
    use webview2_com::PrintToPdfCompletedHandler;
    use windows_core::{Interface, PCWSTR};

    if let Some(parent) = std::path::Path::new(&path).parent() {
        if !parent.as_os_str().is_empty() {
            let _ = std::fs::create_dir_all(parent);
        }
    }
    let _ = std::fs::remove_file(&path);

    let (start_tx, start_rx) = std::sync::mpsc::channel::<Result<(), String>>();
    let (done_tx, done_rx) = tokio::sync::oneshot::channel::<Result<(), String>>();
    let target = path.clone();

    window
        .with_webview(move |platform| unsafe {
            let run = || -> Result<(), String> {
                let core = platform
                    .controller()
                    .CoreWebView2()
                    .map_err(|e| format!("CoreWebView2: {e}"))?;
                let core7 = core
                    .cast::<ICoreWebView2_7>()
                    .map_err(|e| format!("ICoreWebView2_7 (PrintToPdf requires WebView2 91+): {e}"))?;
                let core2 = core
                    .cast::<ICoreWebView2_2>()
                    .map_err(|e| format!("ICoreWebView2_2: {e}"))?;
                let env = core2
                    .Environment()
                    .map_err(|e| format!("WebView2 Environment: {e}"))?;
                let env6 = env
                    .cast::<ICoreWebView2Environment6>()
                    .map_err(|e| format!("ICoreWebView2Environment6: {e}"))?;
                let ps = env6
                    .CreatePrintSettings()
                    .map_err(|e| format!("CreatePrintSettings: {e}"))?;

                if let Some((w_pt, h_pt)) = paper {
                    if w_pt > h_pt {
                        let _ = ps.SetOrientation(COREWEBVIEW2_PRINT_ORIENTATION_LANDSCAPE);
                        let _ = ps.SetPageWidth(h_pt / 72.0);
                        let _ = ps.SetPageHeight(w_pt / 72.0);
                    } else {
                        let _ = ps.SetOrientation(COREWEBVIEW2_PRINT_ORIENTATION_PORTRAIT);
                        let _ = ps.SetPageWidth(w_pt / 72.0);
                        let _ = ps.SetPageHeight(h_pt / 72.0);
                    }
                }
                let (top, right, bottom, left) =
                    margins.unwrap_or((42.52, 42.52, 42.52, 42.52));
                let _ = ps.SetMarginTop(top / 72.0);
                let _ = ps.SetMarginRight(right / 72.0);
                let _ = ps.SetMarginBottom(bottom / 72.0);
                let _ = ps.SetMarginLeft(left / 72.0);
                let _ = ps.SetShouldPrintBackgrounds(true);
                let _ = ps.SetShouldPrintHeaderAndFooter(false);

                let wide_path: Vec<u16> = target.encode_utf16().chain(std::iter::once(0)).collect();
                let handler = PrintToPdfCompletedHandler::create(Box::new(move |hr, is_success| {
                    let outcome = match hr {
                        Ok(()) if is_success => Ok(()),
                        Ok(()) => Err("WebView2 PrintToPdf failed to write PDF".to_string()),
                        Err(e) => Err(format!("WebView2 PrintToPdf error: {e}")),
                    };
                    let _ = done_tx.send(outcome);
                    Ok(())
                }));

                core7
                    .PrintToPdf(PCWSTR::from_raw(wide_path.as_ptr()), &ps, &handler)
                    .map_err(|e| format!("PrintToPdf start: {e}"))?;
                Ok(())
            };
            let _ = start_tx.send(run());
        })
        .map_err(|e| format!("with_webview: {e}"))?;

    start_rx
        .recv_timeout(std::time::Duration::from_secs(10))
        .map_err(|_| "Timed out starting WebView2 PrintToPdf".to_string())??;

    tokio::time::timeout(std::time::Duration::from_secs(120), done_rx)
        .await
        .map_err(|_| "PDF export timed out".to_string())?
        .map_err(|_| "WebView2 PrintToPdf channel closed unexpectedly".to_string())??;

    if let Some(items) = outlines.filter(|v| !v.is_empty()) {
        let path2 = path.clone();
        let margins2 = margins;
        let _ = tauri::async_runtime::spawn_blocking(move || {
            if let Err(e) = inject_pdf_outlines_lopdf(&path2, &items, margins2) {
                eprintln!("[pdf] outline injection warning: {e}");
            }
        })
        .await;
    }
    Ok(())
}

#[cfg(target_os = "linux")]
#[tauri::command]
pub async fn print_webview_to_pdf(
    window: tauri::WebviewWindow,
    path: String,
    paper: Option<(f64, f64)>,
    margins: Option<(f64, f64, f64, f64)>,
    outlines: Option<Vec<(u8, String, usize, f64)>>,
) -> Result<(), String> {
    use gio::prelude::*;
    use std::sync::{Arc, Mutex};
    use webkit2gtk::{PrintOperation, PrintOperationExt};

    if let Some(parent) = std::path::Path::new(&path).parent() {
        if !parent.as_os_str().is_empty() {
            let _ = std::fs::create_dir_all(parent);
        }
    }
    let _ = std::fs::remove_file(&path);

    let (start_tx, start_rx) = std::sync::mpsc::channel::<Result<(), String>>();
    let (done_tx, done_rx) = tokio::sync::oneshot::channel::<Result<(), String>>();
    let done_tx = Arc::new(Mutex::new(Some(done_tx)));
    let target = path.clone();

    window
        .with_webview(move |wv| {
            let webview = wv.inner();
            let op = PrintOperation::new(&webview);

            let ps = gtk::PrintSettings::new();
            ps.set_printer("Print to File");
            ps.set("output-file-format", Some("pdf"));
            let file_uri = gio::File::for_path(&target).uri();
            ps.set(gtk::PRINT_SETTINGS_OUTPUT_URI.as_str(), Some(file_uri.as_str()));
            ps.set_print_pages(gtk::PrintPages::All);

            let page_setup = gtk::PageSetup::new();
            if let Some((w_pt, h_pt)) = paper {
                let paper_size = gtk::PaperSize::new_custom(
                    "solomd-paper",
                    "SoloMD Paper",
                    w_pt,
                    h_pt,
                    gtk::Unit::Points,
                );
                page_setup.set_paper_size(&paper_size);
            }
            let (top, right, bottom, left) = margins.unwrap_or((42.52, 42.52, 42.52, 42.52));
            page_setup.set_top_margin(top, gtk::Unit::Points);
            page_setup.set_right_margin(right, gtk::Unit::Points);
            page_setup.set_bottom_margin(bottom, gtk::Unit::Points);
            page_setup.set_left_margin(left, gtk::Unit::Points);

            op.set_print_settings(&ps);
            op.set_page_setup(&page_setup);

            let tx_ok = Arc::clone(&done_tx);
            op.connect_finished(move |_| {
                if let Some(tx) = tx_ok.lock().unwrap().take() {
                    let _ = tx.send(Ok(()));
                }
            });
            let tx_err = Arc::clone(&done_tx);
            op.connect_failed(move |_, err| {
                if let Some(tx) = tx_err.lock().unwrap().take() {
                    let _ = tx.send(Err(err.to_string()));
                }
            });

            op.print();
            let _ = start_tx.send(Ok(()));
        })
        .map_err(|e| format!("with_webview: {e}"))?;

    start_rx
        .recv_timeout(std::time::Duration::from_secs(10))
        .map_err(|_| "Timed out starting WebKitGTK print operation".to_string())??;

    tokio::time::timeout(std::time::Duration::from_secs(120), done_rx)
        .await
        .map_err(|_| "PDF export timed out".to_string())?
        .map_err(|_| "WebKitGTK print channel closed unexpectedly".to_string())??;

    if let Some(items) = outlines.filter(|v| !v.is_empty()) {
        let path2 = path.clone();
        let margins2 = margins;
        let _ = tauri::async_runtime::spawn_blocking(move || {
            if let Err(e) = inject_pdf_outlines_lopdf(&path2, &items, margins2) {
                eprintln!("[pdf] outline injection warning: {e}");
            }
        })
        .await;
    }
    Ok(())
}

#[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
#[tauri::command]
pub async fn print_webview_to_pdf(
    _window: tauri::WebviewWindow,
    _path: String,
    _paper: Option<(f64, f64)>,
    _margins: Option<(f64, f64, f64, f64)>,
    _outlines: Option<Vec<(u8, String, usize, f64)>>,
) -> Result<(), String> {
    Err("direct PDF export is desktop-only; use print_webview".into())
}

#[cfg(target_os = "android")]
#[tauri::command]
pub async fn print_webview(_window: tauri::WebviewWindow) -> Result<(), String> {
    super::saf_android::android_print_webview("SoloMD")?;
    tauri::async_runtime::spawn_blocking(|| {
        let start = std::time::Instant::now();
        while start.elapsed() < std::time::Duration::from_secs(300) {
            std::thread::sleep(std::time::Duration::from_millis(200));
            if super::saf_android::android_poll_print_finished().unwrap_or(false) {
                return Ok(());
            }
        }
        Ok(())
    })
    .await
    .map_err(|e| format!("join: {e}"))?
}

#[cfg(target_os = "ios")]
mod ios_print {
    use objc2::rc::Retained;
    use objc2::runtime::{AnyClass, AnyObject, Bool, NSObject};
    use objc2::{declare_class, msg_send, msg_send_id, mutability, ClassType, DeclaredClass};
    use std::ptr::null_mut;
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

    #[link(name = "UIKit", kind = "framework")]
    extern "C" {}

    pub static PRINT_DONE: AtomicBool = AtomicBool::new(false);
    static DELEGATE: AtomicUsize = AtomicUsize::new(0);

    declare_class!(
        struct PrintDelegate;

        unsafe impl ClassType for PrintDelegate {
            type Super = NSObject;
            type Mutability = mutability::InteriorMutable;
            const NAME: &'static str = "SoloMDPrintDelegate";
        }

        impl DeclaredClass for PrintDelegate {}

        unsafe impl PrintDelegate {
            #[method(printInteractionControllerDidDismissPrinterOptions:)]
            fn did_dismiss(&self, _controller: *mut AnyObject) {
                PRINT_DONE.store(true, Ordering::SeqCst);
            }

            #[method(printInteractionControllerDidFinishJob:)]
            fn did_finish(&self, _controller: *mut AnyObject) {
                PRINT_DONE.store(true, Ordering::SeqCst);
            }
        }
    );

    impl PrintDelegate {
        fn new() -> Retained<Self> {
            let this = Self::alloc().set_ivars(());
            unsafe { msg_send_id![super(this), init] }
        }
    }

    pub unsafe fn present(webview: *mut AnyObject) -> Result<(), String> {
        if webview.is_null() {
            return Err("no webview".into());
        }
        let Some(pic_cls) = AnyClass::get("UIPrintInteractionController") else {
            return Err("UIPrintInteractionController unavailable".into());
        };
        let pic: *mut AnyObject = msg_send![pic_cls, sharedPrintController];
        if pic.is_null() {
            return Err("sharedPrintController returned null".into());
        }
        if let Some(info_cls) = AnyClass::get("UIPrintInfo") {
            let info: *mut AnyObject = msg_send![info_cls, printInfo];
            if !info.is_null() {
                // UIPrintInfoOutputGeneral = 0
                let _: () = msg_send![info, setOutputType: 0isize];
                let _: () = msg_send![pic, setPrintInfo: info];
            }
        }
        let formatter: *mut AnyObject = msg_send![webview, viewPrintFormatter];
        if formatter.is_null() {
            return Err("WKWebView returned no viewPrintFormatter".into());
        }
        let _: () = msg_send![pic, setPrintFormatter: formatter];

        let mut delegate = DELEGATE.load(Ordering::SeqCst) as *mut AnyObject;
        if delegate.is_null() {
            delegate = Retained::into_raw(PrintDelegate::new()) as *mut AnyObject;
            DELEGATE.store(delegate as usize, Ordering::SeqCst);
        }
        let _: () = msg_send![pic, setDelegate: delegate];
        PRINT_DONE.store(false, Ordering::SeqCst);

        let ok: Bool = msg_send![
            pic,
            presentAnimated: Bool::YES,
            completionHandler: null_mut::<AnyObject>()
        ];
        if !ok.as_bool() {
            return Err("failed to present UIPrintInteractionController".into());
        }
        Ok(())
    }
}

#[cfg(target_os = "ios")]
#[tauri::command]
pub async fn print_webview(window: tauri::WebviewWindow) -> Result<(), String> {
    use std::sync::atomic::Ordering;
    let (tx, rx) = std::sync::mpsc::channel::<Result<(), String>>();
    window
        .with_webview(move |wv| unsafe {
            let res = ios_print::present(wv.inner() as *mut objc2::runtime::AnyObject);
            let _ = tx.send(res);
        })
        .map_err(|e| format!("with_webview: {e}"))?;
    rx.recv_timeout(std::time::Duration::from_secs(10))
        .map_err(|_| "could not start the print operation".to_string())??;
    tauri::async_runtime::spawn_blocking(|| {
        let start = std::time::Instant::now();
        while start.elapsed() < std::time::Duration::from_secs(300) {
            std::thread::sleep(std::time::Duration::from_millis(200));
            if ios_print::PRINT_DONE.swap(false, Ordering::SeqCst) {
                return Ok(());
            }
        }
        Ok(())
    })
    .await
    .map_err(|e| format!("join: {e}"))?
}

/// Copy a file from `src` to `dst`, creating parent dirs as needed.
/// Used by image drag-drop to bring an OS file into the document's
/// `_assets/` folder without round-tripping bytes through JavaScript.
#[tauri::command]
pub async fn copy_file(src: String, dst: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || copy_file_inner(src, dst))
        .await
        .map_err(|e| format!("join: {e}"))?
}

pub fn copy_file_inner(src: String, dst: String) -> Result<(), String> {
    if let Some(parent) = Path::new(&dst).parent() {
        if !parent.as_os_str().is_empty() {
            fs::create_dir_all(parent)
                .map_err(|e| format!("mkdir failed: {e}"))?;
        }
    }
    fs::copy(&src, &dst).map_err(|e| format!("copy failed: {e}"))?;
    Ok(())
}

/// v3.0 file-tree edit ops — backing the New File / New Folder / Rename /
/// Delete buttons in the left sidebar. Refuse to clobber existing files
/// so the UI can show "already exists" without us silently overwriting.
#[tauri::command]
pub fn fs_create_file(path: String, content: Option<String>) -> Result<(), String> {
    let p = Path::new(&path);
    if p.exists() {
        return Err(format!("already exists: {path}"));
    }
    if let Some(parent) = p.parent() {
        if !parent.as_os_str().is_empty() {
            fs::create_dir_all(parent).map_err(|e| format!("mkdir failed: {e}"))?;
        }
    }
    fs::write(p, content.unwrap_or_default().as_bytes())
        .map_err(|e| format!("create failed: {e}"))
}

#[tauri::command]
pub fn fs_create_dir(path: String) -> Result<(), String> {
    let p = Path::new(&path);
    if p.exists() {
        return Err(format!("already exists: {path}"));
    }
    fs::create_dir_all(p).map_err(|e| format!("mkdir failed: {e}"))
}

#[tauri::command]
pub fn fs_delete(
    watcher: tauri::State<'_, super::watcher::WatcherState>,
    path: String,
) -> Result<(), String> {
    super::watcher::unwatch_under_path(&watcher, Path::new(&path));
    fs_delete_inner(path)
}

pub fn fs_delete_inner(path: String) -> Result<(), String> {
    let p = Path::new(&path);
    if !p.exists() {
        return Ok(()); // idempotent — already gone is fine
    }
    // #112 — on desktop, deleting moves to the OS trash (Finder 废纸篓 /
    // Windows recycle bin / XDG trash) so a mis-click is recoverable; a user
    // permanently lost a file to the old unlink behavior. Fall back to the
    // permanent path only if the trash service errors (e.g. a filesystem
    // without trash support), so delete still works everywhere.
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    {
        if trash::delete(p).is_ok() {
            return Ok(());
        }
    }
    if p.is_dir() {
        fs::remove_dir_all(p).map_err(|e| format!("delete dir failed: {e}"))
    } else {
        fs::remove_file(p).map_err(|e| format!("delete file failed: {e}"))
    }
}

/// Does this path exist and is it a directory?
///
/// The file tree needs to tell "the folder is empty" from "the folder is not
/// there any more" — a moved or deleted workspace otherwise renders as an
/// empty tree under its own name, which reads as "my notes are gone".
/// Matching on `read_dir`'s error string would be a guess: it is localized on
/// Windows.
/// Version of the system webview (WebView2 on Windows, e.g. "154.0.4258.48").
/// The frontend picks the Windows editor engine from it: CodeMirror's
/// input-method problems were WebView2-side and are gone from 154 on.
#[tauri::command]
pub fn webview_runtime_version() -> Option<String> {
    tauri::webview_version().ok()
}

/// #541 — Fallback clipboard text reader for Linux Wayland (e.g. Ubuntu 26.04 /
/// GNOME 50 + GSConnect), where WebKitGTK's `ClipboardEvent.clipboardData` can
/// arrive empty and `arboard` X11/wlr-data-control cannot read GNOME Shell's
/// Wayland selection offer while `wl-paste` (or `xclip` / `xsel`) succeeds.
#[tauri::command]
pub async fn clipboard_read_text_fallback() -> Result<String, String> {
    #[cfg(target_os = "linux")]
    {
        return tokio::task::spawn_blocking(|| {
            let candidates: &[(&str, &[&str])] = &[
                ("wl-paste", &["--no-newline"]),
                ("wl-paste", &["--no-newline", "--type", "text/plain;charset=utf-8"]),
                ("wl-paste", &["--no-newline", "--type", "text/plain"]),
                ("wl-paste", &["--no-newline", "--type", "UTF8_STRING"]),
                ("xclip", &["-o", "-selection", "clipboard"]),
                ("xsel", &["-ob"]),
            ];
            for (bin, args) in candidates {
                if let Ok(out) = std::process::Command::new(bin).args(*args).output() {
                    if out.status.success() && !out.stdout.is_empty() {
                        let text = String::from_utf8_lossy(&out.stdout).into_owned();
                        if !text.is_empty() {
                            return Ok(text);
                        }
                    }
                }
            }
            Ok(String::new())
        })
        .await
        .map_err(|e| e.to_string())?;
    }
    #[cfg(not(target_os = "linux"))]
    {
        Ok(String::new())
    }
}

/// #492 — Automatically switch the OS input method to an ASCII layout when
/// leaving Vim Insert mode (`mode == "normal"`), and restore the user's
/// previous input method when re-entering Insert mode (`mode == "insert"`).
#[tauri::command]
pub fn vim_switch_input_method(app: tauri::AppHandle, mode: String) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        use std::ffi::c_void;
        use std::sync::atomic::{AtomicUsize, Ordering};

        #[link(name = "Carbon", kind = "framework")]
        extern "C" {
            fn TISCopyCurrentKeyboardInputSource() -> *mut c_void;
            fn TISCopyCurrentASCIICapableKeyboardInputSource() -> *mut c_void;
            fn TISSelectInputSource(source: *mut c_void) -> i32;
        }
        #[link(name = "CoreFoundation", kind = "framework")]
        extern "C" {
            fn CFRelease(cf: *const c_void);
        }

        static SAVED_INPUT_SOURCE: AtomicUsize = AtomicUsize::new(0);

        let is_insert = mode == "insert";
        let _ = app.run_on_main_thread(move || unsafe {
            if is_insert {
                let prev = SAVED_INPUT_SOURCE.swap(0, Ordering::SeqCst) as *mut c_void;
                if !prev.is_null() {
                    let _ = TISSelectInputSource(prev);
                    CFRelease(prev);
                }
            } else {
                let current = TISCopyCurrentKeyboardInputSource();
                let ascii = TISCopyCurrentASCIICapableKeyboardInputSource();
                if !current.is_null() && !ascii.is_null() {
                    if current != ascii {
                        let old = SAVED_INPUT_SOURCE.swap(current as usize, Ordering::SeqCst)
                            as *mut c_void;
                        if !old.is_null() {
                            CFRelease(old);
                        }
                        let _ = TISSelectInputSource(ascii);
                    } else {
                        CFRelease(current);
                    }
                } else if !current.is_null() {
                    CFRelease(current);
                }
                if !ascii.is_null() {
                    CFRelease(ascii);
                }
            }
        });
        return Ok(());
    }
    #[cfg(target_os = "linux")]
    {
        use std::sync::atomic::{AtomicBool, Ordering};
        static SAVED_FCITX_ACTIVE: AtomicBool = AtomicBool::new(false);
        let _ = &app;
        let is_insert = mode == "insert";
        std::thread::spawn(move || {
            for bin in ["fcitx5-remote", "fcitx-remote"] {
                if is_insert {
                    if SAVED_FCITX_ACTIVE.swap(false, Ordering::SeqCst) {
                        let _ = std::process::Command::new(bin).arg("-o").output();
                    }
                    break;
                } else if let Ok(out) = std::process::Command::new(bin).output() {
                    if out.status.success() {
                        let state = String::from_utf8_lossy(&out.stdout).trim().to_string();
                        if state == "2" {
                            SAVED_FCITX_ACTIVE.store(true, Ordering::SeqCst);
                            let _ = std::process::Command::new(bin).arg("-c").output();
                        }
                        break;
                    }
                }
            }
        });
        return Ok(());
    }
    #[cfg(target_os = "windows")]
    {
        use std::sync::atomic::{AtomicBool, AtomicIsize, Ordering};
        use tauri::Manager;
        use windows_sys::Win32::UI::WindowsAndMessaging::{GetForegroundWindow, SendMessageW};

        #[link(name = "imm32")]
        extern "system" {
            fn ImmGetDefaultIMEWnd(hwnd: isize) -> isize;
        }

        const WM_IME_CONTROL: u32 = 0x0283;
        const IMC_GETCONVERSIONMODE: usize = 0x0001;
        const IMC_SETCONVERSIONMODE: usize = 0x0002;
        const IMC_GETOPENSTATUS: usize = 0x0005;
        const IMC_SETOPENSTATUS: usize = 0x0006;
        const IME_CMODE_NATIVE: isize = 0x0001;

        static SAVED_IME_ACTIVE: AtomicBool = AtomicBool::new(false);
        static SAVED_IME_CONV: AtomicIsize = AtomicIsize::new(IME_CMODE_NATIVE);

        let is_insert = mode == "insert";
        let main_hwnd = app
            .get_webview_window("main")
            .and_then(|w| w.hwnd().ok())
            .map(|h| h.0 as isize)
            .unwrap_or(0);

        unsafe {
            let fg = GetForegroundWindow() as isize;
            let target_hwnd = if fg != 0 { fg } else { main_hwnd };
            if target_hwnd == 0 {
                return Ok(());
            }
            let ime_wnd = ImmGetDefaultIMEWnd(target_hwnd);
            if ime_wnd == 0 {
                return Ok(());
            }
            if is_insert {
                if SAVED_IME_ACTIVE.swap(false, Ordering::SeqCst) {
                    let conv = SAVED_IME_CONV.load(Ordering::SeqCst);
                    SendMessageW(ime_wnd as _, WM_IME_CONTROL, IMC_SETOPENSTATUS, 1);
                    SendMessageW(
                        ime_wnd as _,
                        WM_IME_CONTROL,
                        IMC_SETCONVERSIONMODE,
                        conv | IME_CMODE_NATIVE,
                    );
                }
            } else {
                let open = SendMessageW(ime_wnd as _, WM_IME_CONTROL, IMC_GETOPENSTATUS, 0);
                let conv = SendMessageW(ime_wnd as _, WM_IME_CONTROL, IMC_GETCONVERSIONMODE, 0);
                if open != 0 && (conv & IME_CMODE_NATIVE) != 0 {
                    SAVED_IME_CONV.store(conv, Ordering::SeqCst);
                    SAVED_IME_ACTIVE.store(true, Ordering::SeqCst);
                    SendMessageW(
                        ime_wnd as _,
                        WM_IME_CONTROL,
                        IMC_SETCONVERSIONMODE,
                        conv & !IME_CMODE_NATIVE,
                    );
                }
            }
        }
        return Ok(());
    }
    #[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
    {
        let _ = (&app, mode);
        Ok(())
    }
}

#[tauri::command]
pub fn fs_dir_exists(path: String) -> bool {
    Path::new(&path).is_dir()
}

#[tauri::command]
pub fn fs_files_exist(paths: Vec<String>) -> Vec<bool> {
    paths.iter().map(|p| Path::new(p).is_file()).collect()
}

#[tauri::command]
pub fn fs_file_exists(path: String) -> bool {
    Path::new(&path).is_file()
}

#[tauri::command]
pub async fn fs_rename(
    watcher: tauri::State<'_, super::watcher::WatcherState>,
    from: String,
    to: String,
    workspace_root: Option<String>,
    update_links: Option<bool>,
) -> Result<Vec<String>, String> {
    // Release any OS-level directory watches covering `from` or its children
    // before renaming. On Windows, `ReadDirectoryChangesW` holds an open
    // directory handle that causes `fs::rename` to fail with os error 5/32.
    super::watcher::unwatch_under_path(&watcher, Path::new(&from));
    tauri::async_runtime::spawn_blocking(move || {
        fs_rename_with_workspace(from, to, workspace_root, update_links.unwrap_or(true))
    })
    .await
    .map_err(|e| format!("join: {e}"))?
}

pub fn fs_rename_with_workspace(
    from: String,
    to: String,
    workspace_root: Option<String>,
    update_links: bool,
) -> Result<Vec<String>, String> {
    let from_p = Path::new(&from);
    let to_p = Path::new(&to);
    if !from_p.exists() {
        return Err(format!("source missing: {from}"));
    }
    let case_only_rename = from_p != to_p
        && from_p
            .to_string_lossy()
            .eq_ignore_ascii_case(&to_p.to_string_lossy());
    if to_p.exists() && !case_only_rename {
        return Err(format!("target already exists: {to}"));
    }

    // v4.3.5 — per-file `.assets/` follow-along. Only applies to markdown files
    // (never directories).
    let is_md_file = from_p.is_file() && is_markdown_path(from_p);
    let from_assets = if is_md_file { sibling_assets_dir(from_p) } else { None };
    let to_assets = if is_md_file { sibling_assets_dir(to_p) } else { None };
    let stems_differ = from_assets
        .as_ref()
        .zip(to_assets.as_ref())
        .map(|(a, b)| {
            a.file_name() != b.file_name()
        })
        .unwrap_or(false);

    if case_only_rename {
        // Two-step rename through a temporary sibling name so case-insensitive
        // filesystems (NTFS / APFS) update the directory entry casing cleanly.
        let parent = from_p.parent().unwrap_or_else(|| Path::new("."));
        let tmp = parent.join(format!(
            ".solomd-rename-tmp-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        fs::rename(from_p, &tmp).map_err(|e| format!("rename failed: {e}"))?;
        if let Err(e) = fs::rename(&tmp, to_p) {
            let _ = fs::rename(&tmp, from_p);
            return Err(format!("rename failed: {e}"));
        }
    } else {
        fs::rename(from_p, to_p).map_err(|e| format!("rename failed: {e}"))?;
    }

    let mut extra_pairs: Vec<(Vec<String>, Vec<String>)> = Vec::new();
    if let (Some(fa), Some(ta)) = (from_assets, to_assets) {
        if fa.is_dir() && !ta.exists() {
            if let Err(e) = fs::rename(&fa, &ta) {
                eprintln!("[fs_rename] assets folder rename failed: {e}");
            } else {
                extra_pairs.push((abs_segments(&fa), abs_segments(&ta)));
                if stems_differ && is_markdown_path(to_p) {
                    // Stem changed → relative refs inside the body now point at
                    // a folder that no longer exists. Rewrite them in place.
                    if let Err(e) = rewrite_assets_refs(to_p, &fa, &ta) {
                        eprintln!("[fs_rename] body rewrite failed: {e}");
                    }
                }
            }
        }
    }

    let mut updated = Vec::new();
    if update_links {
        if let Some(ws) = workspace_root.as_deref().filter(|s| !s.is_empty()) {
            updated = relink_inbound_workspace_links(Path::new(ws), from_p, to_p, &extra_pairs);
        }
    }
    Ok(updated)
}

/// Given a path like `/a/b/foo.md`, return `/a/b/foo.assets`. Returns None
/// if the path has no stem (e.g. `/`, an empty string).
fn sibling_assets_dir(p: &Path) -> Option<std::path::PathBuf> {
    let stem = p.file_stem()?.to_string_lossy().to_string();
    if stem.is_empty() {
        return None;
    }
    let parent = p.parent()?;
    Some(parent.join(format!("{stem}.assets")))
}

fn is_markdown_path(p: &Path) -> bool {
    matches!(
        p.extension().and_then(|e| e.to_str()).map(|s| s.to_ascii_lowercase()).as_deref(),
        Some("md") | Some("markdown") | Some("mdown") | Some("mkd")
    )
}

/// Rewrite `<old_stem>.assets/` references inside the file body to
/// `<new_stem>.assets/`. Reads as UTF-8 (which markdown effectively is for
/// our purposes — link paths are always ASCII-safe), does a literal
/// substring replace, and writes back. Best-effort: if the file isn't
/// readable as UTF-8 or has no matches, the original bytes are preserved.
fn rewrite_assets_refs(file: &Path, old_assets: &Path, new_assets: &Path) -> Result<(), String> {
    let old_name = old_assets
        .file_name()
        .and_then(|s| s.to_str())
        .ok_or_else(|| "old assets name missing".to_string())?;
    let new_name = new_assets
        .file_name()
        .and_then(|s| s.to_str())
        .ok_or_else(|| "new assets name missing".to_string())?;
    let bytes = fs::read(file).map_err(|e| format!("read for rewrite: {e}"))?;
    let body = match std::str::from_utf8(&bytes) {
        Ok(s) => s,
        Err(_) => return Ok(()), // non-UTF-8 body, skip rewrite
    };
    // Match the assets folder followed by `/` so we don't accidentally
    // rewrite occurrences inside prose (`foo.assets` mentioned in text).
    let old_pat = format!("{old_name}/");
    let new_pat = format!("{new_name}/");
    if !body.contains(&old_pat) {
        return Ok(());
    }
    let rewritten = body.replace(&old_pat, &new_pat);
    fs::write(file, rewritten).map_err(|e| format!("write back: {e}"))
}

// ---------------------------------------------------------------------------
// Moving files and folders inside the tree (#290 + #267).
//
// `fs_rename` above is already a filesystem move, but it only ever moves
// within ONE directory, so two things a real move breaks never came up:
//
//   1. **Cross-device.** A vault can span a mount point (a symlinked
//      subfolder on an external disk, a network share). `fs::rename` returns
//      EXDEV there and nothing happens. We fall back to copy-then-remove,
//      and only remove once the copy is complete, so a failure halfway
//      leaves the original intact.
//
//   2. **Relative links.** A note carries its body to the new folder, and
//      every relative `](…)` target in that body was written from the OLD
//      folder. `![](_assets/a.png)` resolves to nothing one level down —
//      "I moved a note and all its images broke" is the bug report this
//      exists to prevent. We re-express those targets from the new location.
//
// The link rewrite is deliberately **lexical**: it never hits the disk to
// resolve a target, it only adds or cancels leading `../` segments. So
// percent-encoding (`My%20file.png`), targets whose file doesn't exist,
// and case-insensitive filesystems all survive untouched — we never
// re-spell what the user typed, we only re-anchor it.
//
// Targets that point INSIDE the thing being moved are left alone: their
// relationship to the note didn't change. That set includes the per-file
// `<stem>.assets/` folder, which travels along with the note.
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn fs_move(
    watcher: tauri::State<'_, super::watcher::WatcherState>,
    from: String,
    to: String,
    workspace_root: Option<String>,
    update_links: Option<bool>,
) -> Result<Vec<String>, String> {
    super::watcher::unwatch_under_path(&watcher, Path::new(&from));
    tauri::async_runtime::spawn_blocking(move || {
        fs_move_with_workspace(from, to, workspace_root, update_links.unwrap_or(true))
    })
    .await
    .map_err(|e| format!("join: {e}"))?
}

#[allow(dead_code)]
pub fn fs_move_inner(from: String, to: String) -> Result<(), String> {
    fs_move_with_workspace(from, to, None, true).map(|_| ())
}

pub fn fs_move_with_workspace(
    from: String,
    to: String,
    workspace_root: Option<String>,
    update_links: bool,
) -> Result<Vec<String>, String> {
    let from_p = Path::new(&from);
    let to_p = Path::new(&to);
    if !from_p.exists() {
        return Err(format!("source missing: {from}"));
    }
    let to_parent = to_p
        .parent()
        .ok_or_else(|| "destination has no parent folder".to_string())?;
    if !to_parent.is_dir() {
        return Err(format!("destination folder missing: {}", to_parent.display()));
    }
    if to_p.exists() {
        return Err(format!("target already exists: {to}"));
    }
    // Dropping a folder onto itself or onto one of its own descendants would
    // move a directory inside its own subtree. The OS refuses that with a
    // localized errno; catching it here lets the UI say something useful,
    // and lets the tree reject the drop before it ever starts.
    if from_p.is_dir() && is_self_or_descendant(from_p, to_parent) {
        return Err("a folder cannot be moved inside itself".to_string());
    }

    // Same per-file `.assets/` follow-along as `fs_rename`. On a move the
    // stem doesn't change, so the folder just travels to the new parent and
    // the `<stem>.assets/…` links inside the body keep resolving.
    let from_assets = sibling_assets_dir(from_p);
    let to_assets = sibling_assets_dir(to_p);

    move_tree(from_p, to_p)?;

    let mut moved_roots: Vec<Vec<String>> = vec![abs_segments(from_p)];
    let mut extra_pairs: Vec<(Vec<String>, Vec<String>)> = Vec::new();
    if let (Some(fa), Some(ta)) = (from_assets, to_assets) {
        if fa.is_dir() && !ta.exists() {
            match move_tree(&fa, &ta) {
                // The assets folder moved too, so links into it must NOT be
                // rewritten — record it as part of the moved set.
                Ok(()) => {
                    moved_roots.push(abs_segments(&fa));
                    extra_pairs.push((abs_segments(&fa), abs_segments(&ta)));
                }
                Err(e) => eprintln!("[fs_move] assets folder move failed: {e}"),
            }
        }
    }

    let mut updated = Vec::new();
    if update_links {
        relink_moved_tree(to_p, from_p, &moved_roots);
        if let Some(ws) = workspace_root.as_deref().filter(|s| !s.is_empty()) {
            updated = relink_inbound_workspace_links(Path::new(ws), from_p, to_p, &extra_pairs);
        }
    }
    Ok(updated)
}

/// True when `inner` is `outer` itself or sits underneath it. `inner` is the
/// destination's *parent* (the destination itself doesn't exist yet), so it
/// canonicalises cleanly; symlinked vault subfolders compare by their real
/// location, which is what the OS will actually do.
fn is_self_or_descendant(outer: &Path, inner: &Path) -> bool {
    let c_outer = fs::canonicalize(outer).unwrap_or_else(|_| outer.to_path_buf());
    let c_inner = fs::canonicalize(inner).unwrap_or_else(|_| inner.to_path_buf());
    c_inner.starts_with(&c_outer)
}

/// `fs::rename`, falling back to copy-then-remove when source and destination
/// live on different filesystems (EXDEV = 18 on unix, ERROR_NOT_SAME_DEVICE =
/// 17 on Windows). Any other error is reported as-is rather than silently
/// retried as a copy — a permission failure should stay a permission failure.
fn move_tree(from: &Path, to: &Path) -> Result<(), String> {
    match fs::rename(from, to) {
        Ok(()) => Ok(()),
        Err(e) => {
            if !matches!(e.raw_os_error(), Some(18) | Some(17)) {
                return Err(format!("move failed: {e}"));
            }
            copy_tree(from, to).map_err(|e| format!("cross-device copy failed: {e}"))?;
            let removed = if from.is_dir() {
                fs::remove_dir_all(from)
            } else {
                fs::remove_file(from)
            };
            removed.map_err(|e| {
                format!("copied to the new location, but the original could not be removed: {e}")
            })
        }
    }
}

fn copy_tree(from: &Path, to: &Path) -> std::io::Result<()> {
    if from.is_dir() {
        fs::create_dir_all(to)?;
        for entry in fs::read_dir(from)? {
            let entry = entry?;
            copy_tree(&entry.path(), &to.join(entry.file_name()))?;
        }
    } else {
        if let Some(parent) = to.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::copy(from, to)?;
    }
    Ok(())
}

/// An absolute path reduced to its `Normal` components. Prefix and root
/// components are dropped: every comparison here is between two paths under
/// the same vault, so the shared root contributes nothing, and dropping it
/// makes Windows `C:\a\b` and unix `/a/b` behave identically.
pub fn abs_segments(p: &Path) -> Vec<String> {
    p.components()
        .filter_map(|c| match c {
            std::path::Component::Normal(s) => Some(s.to_string_lossy().to_string()),
            _ => None,
        })
        .collect()
}

/// Resolve a relative link target against a directory, purely lexically.
/// `None` when the target climbs above the filesystem root — we leave those
/// alone rather than guess.
pub fn lexical_resolve(base: &[String], target: &str) -> Option<Vec<String>> {
    let mut out = base.to_vec();
    for seg in target.split('/') {
        match seg {
            "" | "." => {}
            ".." => {
                out.pop()?;
            }
            s => out.push(s.to_string()),
        }
    }
    Some(out)
}

/// Express the absolute `target` relative to the absolute `base` directory.
pub fn lexical_relative(base: &[String], target: &[String]) -> String {
    let common = base
        .iter()
        .zip(target.iter())
        .take_while(|(a, b)| a == b)
        .count();
    let mut segs: Vec<String> = vec!["..".to_string(); base.len() - common];
    segs.extend(target[common..].iter().cloned());
    if segs.is_empty() {
        ".".to_string()
    } else {
        segs.join("/")
    }
}

/// A target we must not touch: an anchor, an absolute path, or anything with
/// a URL scheme. The scheme test also catches a Windows drive letter (`C:\…`).
fn is_external_target(t: &str) -> bool {
    if t.is_empty() || t.starts_with('#') || t.starts_with('/') || t.starts_with('\\') {
        return true;
    }
    match t.find(':') {
        None => false,
        Some(i) => {
            let scheme = &t[..i];
            !scheme.is_empty()
                && scheme.starts_with(|c: char| c.is_ascii_alphabetic())
                && scheme
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || c == '+' || c == '-' || c == '.')
        }
    }
}

/// Re-anchor one link target. Returns `None` when nothing should change.
fn shift_target(
    t: &str,
    old_dir: &[String],
    new_dir: &[String],
    moved_roots: &[Vec<String>],
) -> Option<String> {
    if is_external_target(t) {
        return None;
    }
    // `file.md#heading` / `file.md?x=1` — only the path part is a location.
    let cut = t.find(['#', '?']).unwrap_or(t.len());
    let (path, suffix) = t.split_at(cut);
    if path.is_empty() {
        return None;
    }
    let resolved = lexical_resolve(old_dir, path)?;
    // Pointing into something that moved along with us: the relationship is
    // unchanged, so the written target is still correct.
    if moved_roots.iter().any(|r| resolved.starts_with(r)) {
        return None;
    }
    let shifted = format!("{}{}", lexical_relative(new_dir, &resolved), suffix);
    if shifted == t {
        None
    } else {
        Some(shifted)
    }
}

fn inline_link_re() -> &'static regex_lite::Regex {
    static RE: std::sync::OnceLock<regex_lite::Regex> = std::sync::OnceLock::new();
    RE.get_or_init(|| regex_lite::Regex::new(r"\]\(([^)\n]*)\)").unwrap())
}

fn ref_def_re() -> &'static regex_lite::Regex {
    static RE: std::sync::OnceLock<regex_lite::Regex> = std::sync::OnceLock::new();
    RE.get_or_init(|| regex_lite::Regex::new(r"^[ \t]*\[[^\]\n]+\]:[ \t]*(\S+)").unwrap())
}

fn html_attr_re() -> &'static regex_lite::Regex {
    static RE: std::sync::OnceLock<regex_lite::Regex> = std::sync::OnceLock::new();
    RE.get_or_init(|| regex_lite::Regex::new(r#"(?:src|href)[ \t]*=[ \t]*"([^"\n]*)""#).unwrap())
}

/// Inside a `](…)` payload, isolate the destination from an optional title
/// (`path "title"`) and an optional `<>` wrapper. Returns its byte range.
fn destination_range(payload: &str) -> Option<(usize, usize)> {
    let lead = payload.len() - payload.trim_start().len();
    let rest = &payload[lead..];
    if let Some(stripped) = rest.strip_prefix('<') {
        let close = stripped.find('>')?;
        return Some((lead + 1, lead + 1 + close));
    }
    let end = rest
        .find(|c: char| c.is_whitespace())
        .unwrap_or(rest.len());
    if end == 0 {
        None
    } else {
        Some((lead, lead + end))
    }
}

/// Rewrite every relative link target on ONE line. Matches inside an inline
/// code span are skipped — an odd number of backticks before the match means
/// we're inside one, and rewriting sample code in prose would be a bug.
fn rewrite_line(
    line: &str,
    old_dir: &[String],
    new_dir: &[String],
    moved_roots: &[Vec<String>],
) -> Option<String> {
    let mut edits: Vec<(usize, usize, String)> = Vec::new();

    let consider = |start: usize, end: usize, edits: &mut Vec<(usize, usize, String)>| {
        if line[..start].matches('`').count() % 2 == 1 {
            return;
        }
        if let Some(next) = shift_target(&line[start..end], old_dir, new_dir, moved_roots) {
            edits.push((start, end, next));
        }
    };

    for c in inline_link_re().captures_iter(line) {
        let payload = c.get(1).unwrap();
        if let Some((s, e)) = destination_range(payload.as_str()) {
            consider(payload.start() + s, payload.start() + e, &mut edits);
        }
    }
    for re in [ref_def_re(), html_attr_re()] {
        for c in re.captures_iter(line) {
            let m = c.get(1).unwrap();
            consider(m.start(), m.end(), &mut edits);
        }
    }
    if edits.is_empty() {
        return None;
    }

    edits.sort_by_key(|(s, _, _)| *s);
    let mut out = String::with_capacity(line.len());
    let mut cursor = 0usize;
    for (s, e, replacement) in edits {
        if s < cursor {
            continue; // overlapping match (an href inside a markdown link) — first wins
        }
        out.push_str(&line[cursor..s]);
        out.push_str(&replacement);
        cursor = e;
    }
    out.push_str(&line[cursor..]);
    Some(out)
}

/// Rewrite a whole note body. Fenced code blocks are passed through verbatim.
pub fn rewrite_links_after_move(
    body: &str,
    old_dir: &[String],
    new_dir: &[String],
    moved_roots: &[Vec<String>],
) -> Option<String> {
    let mut out = String::with_capacity(body.len());
    let mut in_fence = false;
    let mut changed = false;
    for line in body.split_inclusive('\n') {
        let trimmed = line.trim_start();
        if trimmed.starts_with("```") || trimmed.starts_with("~~~") {
            in_fence = !in_fence;
            out.push_str(line);
            continue;
        }
        if in_fence {
            out.push_str(line);
            continue;
        }
        match rewrite_line(line, old_dir, new_dir, moved_roots) {
            Some(next) => {
                changed = true;
                out.push_str(&next);
            }
            None => out.push_str(line),
        }
    }
    if changed {
        Some(out)
    } else {
        None
    }
}

/// Walk everything that just moved and re-anchor the relative links in each
/// markdown file. Non-UTF-8 bodies are skipped rather than transcoded: a
/// GBK-encoded note round-trips through the editor, not through here.
fn relink_moved_tree(new_root: &Path, old_root: &Path, moved_roots: &[Vec<String>]) {
    let files: Vec<std::path::PathBuf> = if new_root.is_dir() {
        walkdir::WalkDir::new(new_root)
            .into_iter()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_type().is_file() && is_markdown_path(e.path()))
            .map(|e| e.path().to_path_buf())
            .collect()
    } else if is_markdown_path(new_root) {
        vec![new_root.to_path_buf()]
    } else {
        Vec::new()
    };

    for file in files {
        // Where this exact file used to live. For a single-file move the
        // relative part is empty and the old path is just `old_root`.
        let old_file = match file.strip_prefix(new_root) {
            Ok(rel) if !rel.as_os_str().is_empty() => old_root.join(rel),
            _ => old_root.to_path_buf(),
        };
        let (Some(od), Some(nd)) = (old_file.parent(), file.parent()) else {
            continue;
        };
        let old_dir = abs_segments(od);
        let new_dir = abs_segments(nd);
        if old_dir == new_dir {
            continue;
        }
        let Ok(bytes) = fs::read(&file) else { continue };
        // Every Markdown link `[...](...)`, reference def `[id]: ...`, or wikilink
        // `[[...]]` contains `]` — skip files with no `]` before UTF-8 + line regexes.
        if !bytes.contains(&b']') {
            continue;
        }
        let Ok(body) = std::str::from_utf8(&bytes) else {
            continue;
        };
        if let Some(next) = rewrite_links_after_move(body, &old_dir, &new_dir, moved_roots) {
            if let Err(e) = fs::write(&file, next) {
                eprintln!("[fs_move] link rewrite write-back failed for {}: {e}", file.display());
            }
        }
    }
}

fn wikilink_re() -> &'static regex_lite::Regex {
    static RE: std::sync::OnceLock<regex_lite::Regex> = std::sync::OnceLock::new();
    RE.get_or_init(|| regex_lite::Regex::new(r"\[\[([^\[\]\n]+)\]\]").unwrap())
}

fn strip_markdown_ext(s: &str) -> &str {
    for ext in [".md", ".markdown", ".mdown", ".mkd"] {
        if s.len() > ext.len() {
            let start = s.len() - ext.len();
            if s.is_char_boundary(start) && s[start..].eq_ignore_ascii_case(ext) {
                return &s[..start];
            }
        }
    }
    s
}

struct InboundRewriteCtx {
    old_segs: Vec<String>,
    new_segs: Vec<String>,
    old_rel_segs: Vec<String>,
    new_rel_segs: Vec<String>,
    is_dir: bool,
    is_md_file: bool,
    old_stem: String,
    new_stem: String,
    old_name: String,
    new_name: String,
    allow_stem_wikilink: bool,
    extra_dir_pairs: Vec<(Vec<String>, Vec<String>)>,
}

fn shift_inbound_relative_target(
    t: &str,
    in_angle: bool,
    doc_dir_segs: &[String],
    ctx: &InboundRewriteCtx,
) -> Option<String> {
    if is_external_target(t) {
        return None;
    }
    let cut = t.find(['#', '?']).unwrap_or(t.len());
    let (raw_path, suffix) = t.split_at(cut);
    if raw_path.is_empty() {
        return None;
    }
    let decoded_path = raw_path.replace("%20", " ");
    let resolved = lexical_resolve(doc_dir_segs, &decoded_path)?;

    let mut mapped_target: Option<Vec<String>> = None;
    if ctx.is_dir {
        if resolved.len() > ctx.old_segs.len() && resolved.starts_with(&ctx.old_segs) {
            let mut next = ctx.new_segs.clone();
            next.extend_from_slice(&resolved[ctx.old_segs.len()..]);
            mapped_target = Some(next);
        }
    } else if resolved == ctx.old_segs {
        mapped_target = Some(ctx.new_segs.clone());
    }
    if mapped_target.is_none() {
        for (old_dir, new_dir) in &ctx.extra_dir_pairs {
            if resolved.len() > old_dir.len() && resolved.starts_with(old_dir) {
                let mut next = new_dir.clone();
                next.extend_from_slice(&resolved[old_dir.len()..]);
                mapped_target = Some(next);
                break;
            }
        }
    }

    let new_target = mapped_target?;
    let mut rel = lexical_relative(doc_dir_segs, &new_target);
    if raw_path.starts_with("./") && !rel.starts_with('.') {
        rel = format!("./{rel}");
    }
    if !in_angle && (rel.contains(' ') || raw_path.contains("%20")) {
        rel = rel.replace(' ', "%20");
    }
    let out = format!("{rel}{suffix}");
    if out == t {
        None
    } else {
        Some(out)
    }
}

fn shift_inbound_wikilink_inner(inner: &str, ctx: &InboundRewriteCtx) -> Option<String> {
    let (before_pipe, pipe_suffix) = match inner.find('|') {
        Some(i) => (&inner[..i], &inner[i..]),
        None => (inner, ""),
    };
    let (raw_target, hash_suffix) = match before_pipe.find('#') {
        Some(i) => (&before_pipe[..i], &before_pipe[i..]),
        None => (before_pipe, ""),
    };
    let lead_len = raw_target.len() - raw_target.trim_start().len();
    let trail_len = raw_target.len() - raw_target.trim_end().len();
    let trimmed = raw_target.trim();
    if trimmed.is_empty() {
        return None;
    }
    let lead_ws = &raw_target[..lead_len];
    let trail_ws = &raw_target[raw_target.len() - trail_len..];

    let new_target: Option<String> = if trimmed.contains('/') || trimmed.contains('\\') {
        let segs: Vec<&str> = trimmed.split(['/', '\\']).filter(|s| !s.is_empty()).collect();
        if ctx.is_dir {
            if segs.len() > ctx.old_rel_segs.len()
                && segs[..ctx.old_rel_segs.len()]
                    .iter()
                    .zip(&ctx.old_rel_segs)
                    .all(|(a, b)| a.to_lowercase() == b.to_lowercase())
            {
                let mut out_segs = ctx.new_rel_segs.clone();
                out_segs.extend(segs[ctx.old_rel_segs.len()..].iter().map(|s| (*s).to_string()));
                Some(out_segs.join("/"))
            } else {
                None
            }
        } else if segs.len() == ctx.old_rel_segs.len() {
            let dir_matches = segs[..segs.len() - 1]
                .iter()
                .zip(&ctx.old_rel_segs[..ctx.old_rel_segs.len() - 1])
                .all(|(a, b)| a.to_lowercase() == b.to_lowercase());
            if !dir_matches {
                None
            } else {
                let last = segs[segs.len() - 1];
                let last_lc = last.to_lowercase();
                if ctx.is_md_file {
                    if last_lc == ctx.old_stem.to_lowercase() {
                        let mut out_segs = ctx.new_rel_segs[..ctx.new_rel_segs.len() - 1].to_vec();
                        out_segs.push(ctx.new_stem.clone());
                        Some(out_segs.join("/"))
                    } else if last_lc == ctx.old_name.to_lowercase() {
                        Some(ctx.new_rel_segs.join("/"))
                    } else {
                        None
                    }
                } else if last_lc == ctx.old_name.to_lowercase() {
                    Some(ctx.new_rel_segs.join("/"))
                } else {
                    None
                }
            }
        } else {
            None
        }
    } else if !ctx.is_dir && ctx.allow_stem_wikilink && ctx.old_name != ctx.new_name {
        let trimmed_lc = trimmed.to_lowercase();
        if ctx.is_md_file {
            if trimmed_lc == ctx.old_stem.to_lowercase() {
                Some(ctx.new_stem.clone())
            } else if trimmed_lc == ctx.old_name.to_lowercase() {
                Some(ctx.new_name.clone())
            } else {
                None
            }
        } else if trimmed_lc == ctx.old_name.to_lowercase() {
            Some(ctx.new_name.clone())
        } else {
            None
        }
    } else {
        None
    };

    let replaced = new_target?;
    let rebuilt = format!("{lead_ws}{replaced}{trail_ws}{hash_suffix}{pipe_suffix}");
    if rebuilt == inner {
        None
    } else {
        Some(rebuilt)
    }
}

fn rewrite_inbound_line(
    line: &str,
    doc_dir_segs: &[String],
    rewrite_relative: bool,
    ctx: &InboundRewriteCtx,
) -> Option<String> {
    let mut edits: Vec<(usize, usize, String)> = Vec::new();
    let in_inline_code = |pos: usize| line[..pos].matches('`').count() % 2 == 1;

    for c in wikilink_re().captures_iter(line) {
        let full = c.get(0).unwrap();
        if in_inline_code(full.start()) {
            continue;
        }
        let inner = c.get(1).unwrap();
        if let Some(next_inner) = shift_inbound_wikilink_inner(inner.as_str(), ctx) {
            edits.push((inner.start(), inner.end(), next_inner));
        }
    }

    if rewrite_relative {
        for c in inline_link_re().captures_iter(line) {
            let payload = c.get(1).unwrap();
            if let Some((s, e)) = destination_range(payload.as_str()) {
                let abs_s = payload.start() + s;
                let abs_e = payload.start() + e;
                if in_inline_code(abs_s) {
                    continue;
                }
                let in_angle = abs_s > payload.start() && line.as_bytes().get(abs_s - 1) == Some(&b'<');
                if let Some(next) = shift_inbound_relative_target(&line[abs_s..abs_e], in_angle, doc_dir_segs, ctx) {
                    edits.push((abs_s, abs_e, next));
                }
            }
        }
        for re in [ref_def_re(), html_attr_re()] {
            for c in re.captures_iter(line) {
                let m = c.get(1).unwrap();
                if in_inline_code(m.start()) {
                    continue;
                }
                if let Some(next) = shift_inbound_relative_target(m.as_str(), false, doc_dir_segs, ctx) {
                    edits.push((m.start(), m.end(), next));
                }
            }
        }
    }

    if edits.is_empty() {
        return None;
    }
    edits.sort_by_key(|(s, _, _)| *s);
    let mut out = String::with_capacity(line.len());
    let mut cursor = 0usize;
    for (s, e, replacement) in edits {
        if s < cursor {
            continue;
        }
        out.push_str(&line[cursor..s]);
        out.push_str(&replacement);
        cursor = e;
    }
    out.push_str(&line[cursor..]);
    Some(out)
}

fn rewrite_inbound_body(
    body: &str,
    doc_dir_segs: &[String],
    rewrite_relative: bool,
    ctx: &InboundRewriteCtx,
) -> Option<String> {
    let mut out = String::with_capacity(body.len());
    let mut in_fence = false;
    let mut changed = false;
    for line in body.split_inclusive('\n') {
        let trimmed = line.trim_start();
        if trimmed.starts_with("```") || trimmed.starts_with("~~~") {
            in_fence = !in_fence;
            out.push_str(line);
            continue;
        }
        if in_fence {
            out.push_str(line);
            continue;
        }
        match rewrite_inbound_line(line, doc_dir_segs, rewrite_relative, ctx) {
            Some(next) => {
                changed = true;
                out.push_str(&next);
            }
            None => out.push_str(line),
        }
    }
    if changed {
        Some(out)
    } else {
        None
    }
}

/// #571 — Walk all Markdown files in `ws_root` and update inbound wikilinks
/// (`[[Note]]`, `[[folder/Note#Heading|Alias]]`, `![[img.png|300]]`) and
/// relative Markdown / HTML / reference links pointing at `old_root` so they
/// point at `new_root`. Returns the list of modified `.md` file paths on disk.
fn relink_inbound_workspace_links(
    ws_root: &Path,
    old_root: &Path,
    new_root: &Path,
    extra_dir_pairs: &[(Vec<String>, Vec<String>)],
) -> Vec<String> {
    if !ws_root.is_dir() {
        return Vec::new();
    }
    let ws_segs = abs_segments(ws_root);
    let old_segs = abs_segments(old_root);
    let new_segs = abs_segments(new_root);
    if ws_segs.is_empty()
        || !old_segs.starts_with(&ws_segs)
        || !new_segs.starts_with(&ws_segs)
        || old_segs == new_segs
    {
        return Vec::new();
    }
    let old_rel_segs = old_segs[ws_segs.len()..].to_vec();
    let new_rel_segs = new_segs[ws_segs.len()..].to_vec();
    if old_rel_segs.is_empty() || new_rel_segs.is_empty() {
        return Vec::new();
    }

    let is_dir = new_root.is_dir();
    let is_md_file = !is_dir && is_markdown_path(new_root);
    let old_name = old_root
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_default();
    let new_name = new_root
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_default();
    let old_stem = strip_markdown_ext(&old_name).to_string();
    let new_stem = strip_markdown_ext(&new_name).to_string();

    const SKIP_DIRS: &[&str] = &[".git", "node_modules", "target", "dist"];
    let old_name_lc = old_name.to_lowercase();
    let mut md_files: Vec<std::path::PathBuf> = Vec::new();
    let mut has_duplicate_non_md_name = false;
    for entry in walkdir::WalkDir::new(ws_root)
        .into_iter()
        .filter_entry(|e| {
            if e.depth() == 0 {
                return true;
            }
            if e.file_type().is_dir() {
                let name = e.file_name().to_string_lossy();
                return !SKIP_DIRS.iter().any(|s| *s == name);
            }
            true
        })
        .filter_map(|e| e.ok())
    {
        if !entry.file_type().is_file() {
            continue;
        }
        let path = entry.path();
        if is_markdown_path(path) {
            md_files.push(path.to_path_buf());
        } else if !is_dir
            && !is_md_file
            && !has_duplicate_non_md_name
            && path != new_root
            && entry.file_name().to_string_lossy().to_lowercase() == old_name_lc
        {
            has_duplicate_non_md_name = true;
        }
    }

    // Only rewrite stem-only `[[OldStem]]` when no OTHER file in the workspace
    // still carries that stem/filename (avoids clobbering ambiguous stems like
    // multiple `README.md` notes in different folders).
    let allow_stem_wikilink = !is_dir && old_name != new_name && {
        if is_md_file {
            let old_stem_lc = old_stem.to_lowercase();
            !md_files.iter().any(|p| {
                p != new_root
                    && p.file_stem()
                        .map(|s| s.to_string_lossy().to_lowercase() == old_stem_lc)
                        .unwrap_or(false)
            })
        } else {
            !has_duplicate_non_md_name
        }
    };

    let ctx = InboundRewriteCtx {
        old_segs: old_segs.clone(),
        new_segs: new_segs.clone(),
        old_rel_segs,
        new_rel_segs,
        is_dir,
        is_md_file,
        old_stem,
        new_stem,
        old_name,
        new_name,
        allow_stem_wikilink,
        extra_dir_pairs: extra_dir_pairs.to_vec(),
    };

    let old_parent_segs = &old_segs[..old_segs.len().saturating_sub(1)];
    let new_parent_segs = &new_segs[..new_segs.len().saturating_sub(1)];

    let mut updated_paths: Vec<String> = Vec::new();
    for file in md_files {
        let Some(doc_parent) = file.parent() else {
            continue;
        };
        let doc_segs = abs_segments(&file);
        let doc_dir_segs = abs_segments(doc_parent);
        // Inside a moved directory, relative links to sibling notes in the same
        // moved subtree did not change, and outbound links were already shifted
        // by `relink_moved_tree`. Same for a single note moved to a new parent.
        let moved_across_dirs = (is_dir && doc_segs.starts_with(&new_segs))
            || (!is_dir && doc_segs == new_segs && old_parent_segs != new_parent_segs);
        let rewrite_relative = !moved_across_dirs;

        let Ok(bytes) = fs::read(&file) else { continue };
        // Every Markdown link `[...](...)`, reference def `[id]: ...`, or wikilink
        // `[[...]]` contains `]` — skip files with no `]` before UTF-8 + line regexes.
        if !bytes.contains(&b']') {
            continue;
        }
        let Ok(body) = std::str::from_utf8(&bytes) else {
            continue;
        };
        if let Some(next) = rewrite_inbound_body(body, &doc_dir_segs, rewrite_relative, &ctx) {
            if let Err(e) = fs::write(&file, next) {
                eprintln!("[relink_inbound] write-back failed for {}: {e}", file.display());
            } else {
                updated_paths.push(file.to_string_lossy().to_string());
            }
        }
    }
    updated_paths
}

/// Every folder under `root`, as vault-relative slash-separated paths, for the
/// "Move to…" picker.
///
/// The tree itself only knows about folders the user has expanded, and a
/// picker limited to those is useless for the case it exists to serve: filing
/// a note into a folder you haven't visited today. Build junk and attachment
/// folders are pruned along with their subtrees — nobody files a note into
/// `_assets`. Hidden folders follow the Explorer's own "show hidden files"
/// setting, except `.git`, which is always pruned: walking an entire object
/// store to fill a picker is pure cost, and a note filed in there would be
/// invisible to the app anyway.
#[tauri::command]
pub async fn fs_list_dirs(root: String, show_hidden: Option<bool>) -> Result<Vec<String>, String> {
    let show_hidden = show_hidden.unwrap_or(false);
    tauri::async_runtime::spawn_blocking(move || fs_list_dirs_inner(root, show_hidden))
        .await
        .map_err(|e| format!("join: {e}"))?
}

pub fn fs_list_dirs_inner(root: String, show_hidden: bool) -> Result<Vec<String>, String> {
    const CAP: usize = 20_000;
    const SKIP: &[&str] = &["node_modules", "target", "dist", "_assets", ".git"];
    let root_p = Path::new(&root);
    if !root_p.is_dir() {
        return Err(format!("not a folder: {root}"));
    }
    let mut out: Vec<String> = Vec::new();
    for entry in walkdir::WalkDir::new(root_p)
        .into_iter()
        .filter_entry(|e| {
            if e.depth() == 0 {
                return true;
            }
            let name = e.file_name().to_string_lossy().to_string();
            (show_hidden || !name.starts_with('.'))
                && !SKIP.contains(&name.as_str())
                && !name.ends_with(".assets")
        })
        .filter_map(|e| e.ok())
    {
        if entry.depth() == 0 || !entry.file_type().is_dir() {
            continue;
        }
        if let Ok(rel) = entry.path().strip_prefix(root_p) {
            out.push(rel.to_string_lossy().replace('\\', "/"));
        }
        if out.len() >= CAP {
            break;
        }
    }
    out.sort();
    Ok(out)
}

/// One extension present in the vault, with how many files carry it.
#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct ExtensionCount {
    /// Lower-cased, no leading dot. Empty string = files with no extension.
    pub ext: String,
    pub count: usize,
}

/// Every file extension in the vault, most common first (#282 — "只想显示该
/// 文件夹下面的 txt 或者是 md 文档").
///
/// The picker offers what the vault actually contains rather than a canned
/// list: a vault of `.md` + `.canvas` and one of `.txt` + `.org` should not
/// both be shown the same twenty checkboxes.
#[tauri::command]
pub async fn fs_list_extensions(
    root: String,
    show_hidden: Option<bool>,
) -> Result<Vec<ExtensionCount>, String> {
    let show_hidden = show_hidden.unwrap_or(false);
    tauri::async_runtime::spawn_blocking(move || fs_list_extensions_inner(root, show_hidden))
        .await
        .map_err(|e| format!("join: {e}"))?
}

pub fn fs_list_extensions_inner(
    root: String,
    show_hidden: bool,
) -> Result<Vec<ExtensionCount>, String> {
    let root_p = Path::new(&root);
    if !root_p.is_dir() {
        return Err(format!("not a folder: {root}"));
    }
    let mut counts: std::collections::HashMap<String, usize> = std::collections::HashMap::new();
    for entry in filtered_walk(root_p, show_hidden) {
        if !entry.file_type().is_file() {
            continue;
        }
        *counts.entry(entry_extension(entry.path())).or_insert(0) += 1;
    }
    let mut out: Vec<ExtensionCount> = counts
        .into_iter()
        .map(|(ext, count)| ExtensionCount { ext, count })
        .collect();
    // Most common first, alphabetical within a tie — a stable order matters
    // more than the exact one, because the list is a checkbox column.
    out.sort_by(|a, b| b.count.cmp(&a.count).then_with(|| a.ext.cmp(&b.ext)));
    Ok(out)
}

/// Vault-relative paths of every directory whose SUBTREE holds at least one
/// file with one of `exts`.
///
/// This exists because the tree is lazy: a folder the user hasn't expanded has
/// no loaded children, so the frontend cannot tell whether hiding it would
/// hide a match. Filtering to `.txt` and still being shown every folder until
/// you open it is the difference between a filter and a suggestion. One walk
/// per filter change answers it for the whole vault.
#[tauri::command]
pub async fn fs_dirs_with_extensions(
    root: String,
    exts: Vec<String>,
    show_hidden: Option<bool>,
) -> Result<Vec<String>, String> {
    let show_hidden = show_hidden.unwrap_or(false);
    tauri::async_runtime::spawn_blocking(move || {
        fs_dirs_with_extensions_inner(root, exts, show_hidden)
    })
    .await
    .map_err(|e| format!("join: {e}"))?
}

pub fn fs_dirs_with_extensions_inner(
    root: String,
    exts: Vec<String>,
    show_hidden: bool,
) -> Result<Vec<String>, String> {
    let root_p = Path::new(&root);
    if !root_p.is_dir() {
        return Err(format!("not a folder: {root}"));
    }
    let wanted: std::collections::HashSet<String> =
        exts.into_iter().map(|e| e.trim_start_matches('.').to_ascii_lowercase()).collect();
    let mut hits: std::collections::HashSet<String> = std::collections::HashSet::new();
    for entry in filtered_walk(root_p, show_hidden) {
        if !entry.file_type().is_file() || !wanted.contains(&entry_extension(entry.path())) {
            continue;
        }
        // Every ancestor up to (but not including) the root now has a match.
        let mut dir = entry.path().parent();
        while let Some(d) = dir {
            if d == root_p {
                break;
            }
            match d.strip_prefix(root_p) {
                Ok(rel) => {
                    let key = rel.to_string_lossy().replace('\\', "/");
                    // Already recorded: so are all of its ancestors.
                    if !hits.insert(key) {
                        break;
                    }
                }
                Err(_) => break,
            }
            dir = d.parent();
        }
    }
    let mut out: Vec<String> = hits.into_iter().collect();
    out.sort();
    Ok(out)
}

/// Shared walk for the two commands above: skips build junk, attachment
/// folders and `.git`, and honours the Explorer's hidden-files setting.
fn filtered_walk(root: &Path, show_hidden: bool) -> impl Iterator<Item = walkdir::DirEntry> {
    const SKIP: &[&str] = &["node_modules", "target", "dist", ".git"];
    walkdir::WalkDir::new(root)
        .into_iter()
        .filter_entry(move |e| {
            if e.depth() == 0 {
                return true;
            }
            let name = e.file_name().to_string_lossy().to_string();
            (show_hidden || !name.starts_with('.')) && !SKIP.contains(&name.as_str())
        })
        .filter_map(|e| e.ok())
        .take(200_000)
}

/// A path's extension, lower-cased and without the dot. Files with no
/// extension collapse to the empty string, which the picker shows as its own
/// bucket — `Makefile` and `LICENSE` are real vault contents.
fn entry_extension(p: &Path) -> String {
    p.extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .unwrap_or_default()
}

fn sniff_bom(bytes: &[u8]) -> Option<(&'static Encoding, usize)> {
    if bytes.starts_with(&[0xEF, 0xBB, 0xBF]) {
        Some((encoding_rs::UTF_8, 3))
    } else if bytes.starts_with(&[0xFF, 0xFE]) {
        Some((encoding_rs::UTF_16LE, 2))
    } else if bytes.starts_with(&[0xFE, 0xFF]) {
        Some((encoding_rs::UTF_16BE, 2))
    } else {
        None
    }
}

fn detect_language(path: &str) -> String {
    let ext = Path::new(path)
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    match ext.as_str() {
        "md" | "markdown" | "mdown" | "mkd" => "markdown".to_string(),
        _ => "plaintext".to_string(),
    }
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct DirEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    /// Milliseconds since the Unix epoch. Only filled when the caller asks for
    /// times (the file tree sorted by date, #342); omitted otherwise so the
    /// default listing stays the stat-free scan described below.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub modified: Option<u64>,
    /// Creation (birth) time in ms since the epoch, where the platform and
    /// filesystem record one; otherwise the modification time, so "newest
    /// first" still orders sensibly on filesystems without birth times.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub created: Option<u64>,
}

fn epoch_ms(t: std::io::Result<std::time::SystemTime>) -> Option<u64> {
    t.ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
}

/// (modified, created) for one entry. `created` falls back to `modified`
/// when the platform has no birth time (older Linux kernels / filesystems).
pub fn entry_times(meta: &fs::Metadata) -> (Option<u64>, Option<u64>) {
    let modified = epoch_ms(meta.modified());
    let created = epoch_ms(meta.created()).or(modified);
    (modified, created)
}

/// List immediate children of a directory. Sorted: dirs first, then files,
/// both alphabetical.
///
/// Entries starting with `.` are filtered out unless `show_hidden` is set.
/// They were unconditionally skipped until a user pointed out that a vault
/// full of `.config`-style notes (or anyone wanting to see `.gitignore`) had
/// no way to reach them from inside the app at all.
///
/// Whether each child is a directory comes from `e.file_type()`, NOT
/// `e.metadata()`. On Windows the difference is enormous: `file_type()`
/// uses the cached info from the directory scan (one bulk
/// `FindFirstFile`/`FindNextFile` traversal), while `metadata()` triggers
/// a separate `GetFileInformationByHandle` syscall **per entry**. On a
/// folder with a few thousand notes that's the difference between
/// "instant" and "10 seconds with the antivirus also doing on-access
/// scanning". Reported by user 2026-04-26 as "Win 下打开一个文件比较多
/// 的目录还是有些卡顿".
#[allow(dead_code)]
pub fn list_dir_inner(path: String, show_hidden: bool) -> Result<Vec<DirEntry>, String> {
    list_dir_with(path, show_hidden, false)
}

/// `with_times` stats every entry for its modified/created time. It is off
/// for the normal listing (see above for why metadata() is avoided) and on
/// only when the tree is sorted by date (#342).
pub fn list_dir_with(path: String, show_hidden: bool, with_times: bool) -> Result<Vec<DirEntry>, String> {
    let read = fs::read_dir(&path).map_err(|e| format!("read_dir failed: {e}"))?;
    const HARD_CAP: usize = 10_000;
    let mut entries: Vec<DirEntry> = Vec::new();
    let mut truncated = false;
    for e in read.flatten() {
        if entries.len() >= HARD_CAP {
            truncated = true;
            break;
        }
        let name = e.file_name().to_string_lossy().to_string();
        if !show_hidden && name.starts_with('.') {
            continue;
        }
        // file_type() uses the dir-scan's cached entry type — no extra
        // syscall. metadata() on Windows would re-stat each entry. Falls
        // back gracefully for symlinks/reparse points whose type can't
        // be determined cheaply: skip them rather than block.
        let is_dir = match e.file_type() {
            Ok(t) => t.is_dir(),
            Err(_) => continue,
        };
        let (modified, created) = if with_times {
            match e.metadata() {
                Ok(m) => entry_times(&m),
                Err(_) => (None, None),
            }
        } else {
            (None, None)
        };
        entries.push(DirEntry {
            name,
            path: e.path().to_string_lossy().to_string(),
            is_dir,
            modified,
            created,
        });
    }
    entries.sort_by(|a, b| match (a.is_dir, b.is_dir) {
        (true, false) => std::cmp::Ordering::Less,
        (false, true) => std::cmp::Ordering::Greater,
        _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
    });
    if truncated {
        // Surface truncation as a sentinel last entry so the UI can show
        // a "+N more, refine your folder layout" hint without needing a
        // second IPC call. The frontend filters this entry by its
        // distinctive name + is_dir=false signature.
        entries.push(DirEntry {
            name: "__solomd_truncated__".into(),
            path: String::new(),
            is_dir: false,
            modified: None,
            created: None,
        });
    }
    Ok(entries)
}

/// Async wrapper. `fs::read_dir` + per-entry `metadata()` can take seconds on
/// Windows (network drives, OneDrive placeholders, antivirus scanning) and
/// the previous *synchronous* `#[tauri::command]` blocked the main thread —
/// long enough for Win11 to flag the app as unresponsive and kill it
/// (reproduced as "toggle file tree → app crashes" on Win11). Same fix as
/// git_history: hand off to the blocking pool.
#[tauri::command]
pub async fn list_dir(
    path: String,
    show_hidden: Option<bool>,
    with_times: Option<bool>,
) -> Result<Vec<DirEntry>, String> {
    let show_hidden = show_hidden.unwrap_or(false);
    let with_times = with_times.unwrap_or(false);
    tauri::async_runtime::spawn_blocking(move || list_dir_with(path, show_hidden, with_times))
        .await
        .map_err(|e| format!("join: {e}"))?
}

// ---------------------------------------------------------------------------
// Frontmatter property editing (v4.6 F1 — Properties inspector).
//
// The YAML frontmatter block at the top of a note is the ONLY source of truth
// for the Properties inspector. These two commands perform a *line-surgical*
// edit: instead of re-serializing the whole `---`…`---` block (which would
// reflow inline arrays into block style, drop comments, and renormalize quote
// styles on UNTOUCHED keys), we map the block into logical entries — each one
// owning the exact source lines of a top-level key, including any indented /
// sequence continuation lines — then mutate ONLY the lines of the single key
// being changed/added/removed. Every other line in the block is preserved
// byte-for-byte, as is the note BODY (everything after the closing `---`). Only
// the value we actually write is rendered through `serde_yaml`, so quoting /
// typing of that one scalar is correct while neighbors keep their original
// spelling (inline arrays, comments, quote style) and git diffs stay to a
// single key.
//
// A note with NO prior frontmatter that gains its first key gets a block
// synthesized at the very top, ahead of any leading `# H1`, with no spurious
// blank line. Deleting the last key drops the block entirely.
// ---------------------------------------------------------------------------

/// The line layout of a parsed frontmatter block, split so we can do
/// line-surgical edits while preserving every untouched byte.
struct BlockLayout {
    /// `\r\n` if the file used CRLF in the block, else `\n`.
    nl: &'static str,
    /// `true` when the source actually had a `---`…`---` block.
    had_block: bool,
    /// The exact bytes of the open fence line incl. its newline (e.g. "---\n").
    open: String,
    /// The exact bytes of the close fence line incl. its newline.
    close: String,
    /// The inner YAML lines (between the fences), each WITHOUT its trailing
    /// newline. Reassembled with `nl`.
    inner_lines: Vec<String>,
    /// Everything after the closing fence line, byte-for-byte. When there was
    /// no block this holds the entire original file.
    body: String,
}

/// One logical top-level key's footprint inside the block: the inclusive line
/// range it occupies (the `key:` line plus indented/sequence continuations).
struct KeySpan {
    key: String,
    /// First inner-line index (the `key:` line).
    start: usize,
    /// One-past-last inner-line index (covers continuation lines).
    end: usize,
}

/// A top-level YAML key line looks like `key:` or `key: value` at column 0
/// (no leading whitespace, not a comment, not a sequence item). Quoted keys
/// (`"a: b": x`) are handled by scanning for the first unquoted `:` followed by
/// space/EOL. Returns the raw key token (still quoted if quoted in source) or
/// None for non-key lines (comments, blanks, indented continuations, sequence
/// items).
fn top_level_key_of(line: &str) -> Option<String> {
    if line.is_empty() || line.starts_with([' ', '\t', '#', '-']) {
        return None;
    }
    let bytes = line.as_bytes();
    let mut in_single = false;
    let mut in_double = false;
    for (i, &b) in bytes.iter().enumerate() {
        match b {
            b'\'' if !in_double => in_single = !in_single,
            b'"' if !in_single => in_double = !in_double,
            b':' if !in_single && !in_double => {
                let next = bytes.get(i + 1);
                if next.is_none() || next == Some(&b' ') || next == Some(&b'\t') {
                    return Some(line[..i].to_string());
                }
            }
            _ => {}
        }
    }
    None
}

/// Unquote a raw YAML key token into its logical string (so `"a: b"` → `a: b`).
/// Falls back to the trimmed raw token for plain scalars.
fn unquote_key(raw: &str) -> String {
    let t = raw.trim();
    if t.len() >= 2
        && ((t.starts_with('"') && t.ends_with('"'))
            || (t.starts_with('\'') && t.ends_with('\'')))
    {
        if let Ok(serde_yaml::Value::Mapping(m)) =
            serde_yaml::from_str::<serde_yaml::Value>(&format!("{t}: 0"))
        {
            if let Some((serde_yaml::Value::String(k), _)) = m.into_iter().next() {
                return k;
            }
        }
    }
    t.to_string()
}

/// Split the raw file into a line-preserving block layout.
fn split_block(raw: &str) -> Result<BlockLayout, String> {
    let starts_lf = raw.starts_with("---\n");
    let starts_crlf = raw.starts_with("---\r\n");
    if !starts_lf && !starts_crlf {
        return Ok(BlockLayout {
            nl: if raw.contains("\r\n") { "\r\n" } else { "\n" },
            had_block: false,
            open: String::new(),
            close: String::new(),
            inner_lines: Vec::new(),
            body: raw.to_string(),
        });
    }
    let nl: &'static str = if starts_crlf { "\r\n" } else { "\n" };
    let open_len = if starts_crlf { 5 } else { 4 };
    let rest = &raw[open_len..];

    // Locate the closing fence line (`---` or `...`).
    let mut offset = 0usize;
    let mut close_start: Option<usize> = None;
    let mut close_len = 0usize;
    for line in rest.split_inclusive('\n') {
        let trimmed = line.trim_end_matches(['\n', '\r']);
        if trimmed == "---" || trimmed == "..." {
            close_start = Some(offset);
            close_len = line.len();
            break;
        }
        offset += line.len();
    }
    let Some(close_start) = close_start else {
        // Unterminated — don't risk destroying content we can't bound.
        return Ok(BlockLayout {
            nl,
            had_block: false,
            open: String::new(),
            close: String::new(),
            inner_lines: Vec::new(),
            body: raw.to_string(),
        });
    };
    let yaml_src = &rest[..close_start];
    let close = rest[close_start..close_start + close_len].to_string();
    let body = rest[close_start + close_len..].to_string();

    // Validate the YAML up front so we reject malformed blocks rather than
    // silently corrupting them (matches the old surface-the-error behavior).
    if !yaml_src.trim().is_empty() {
        match serde_yaml::from_str::<serde_yaml::Value>(yaml_src) {
            Ok(_) => {}
            Err(e) => return Err(format!("invalid frontmatter YAML: {e}")),
        }
    }

    // Split the inner region into lines without their trailing newline. We
    // split on '\n' and strip a trailing '\r' so CRLF survives via `nl`.
    let inner_lines: Vec<String> = if yaml_src.is_empty() {
        Vec::new()
    } else {
        yaml_src
            .strip_suffix('\n')
            .unwrap_or(yaml_src)
            .split('\n')
            .map(|l| l.trim_end_matches('\r').to_string())
            .collect()
    };

    Ok(BlockLayout {
        nl,
        had_block: true,
        open: raw[..open_len].to_string(),
        close,
        inner_lines,
        body,
    })
}

/// Compute the line spans of each top-level key in the inner lines. A key's
/// span runs from its `key:` line up to (but excluding) the next top-level key
/// line; indented lines and `- ` sequence items in between are continuations.
fn key_spans(inner: &[String]) -> Vec<KeySpan> {
    let mut spans: Vec<KeySpan> = Vec::new();
    let mut i = 0;
    while i < inner.len() {
        if let Some(raw_key) = top_level_key_of(&inner[i]) {
            let start = i;
            let mut end = i + 1;
            while end < inner.len() {
                let l = &inner[end];
                let is_continuation = l.is_empty()
                    || l.starts_with([' ', '\t'])
                    || l.starts_with('-'); // top-level sequence item
                // A blank line is only a continuation if a real continuation
                // follows it; otherwise it's a separator and the key ends here.
                if l.is_empty() {
                    let next_real = inner[end + 1..]
                        .iter()
                        .find(|x| !x.is_empty());
                    let follows = next_real
                        .map(|x| x.starts_with([' ', '\t', '-']))
                        .unwrap_or(false);
                    if !follows {
                        break;
                    }
                    end += 1;
                } else if is_continuation {
                    end += 1;
                } else {
                    break;
                }
            }
            spans.push(KeySpan {
                key: unquote_key(&raw_key),
                start,
                end,
            });
            i = end;
        } else {
            i += 1;
        }
    }
    spans
}

/// Render a single `key: value` (or multi-line) entry through serde_yaml,
/// returning the lines WITHOUT trailing newlines. Only used for the one key
/// being written, so neighbor formatting is never disturbed.
fn render_entry(key: &str, value: &serde_json::Value) -> Result<Vec<String>, String> {
    let mut m = serde_yaml::Mapping::new();
    m.insert(
        serde_yaml::Value::String(key.to_string()),
        json_to_yaml(value),
    );
    let yaml = serde_yaml::to_string(&serde_yaml::Value::Mapping(m))
        .map_err(|e| format!("serialize frontmatter: {e}"))?;
    Ok(yaml
        .trim_end_matches('\n')
        .split('\n')
        .map(|l| l.to_string())
        .collect())
}

/// Reassemble a block layout into a full file.
fn rebuild_block(layout: &BlockLayout) -> String {
    // Empty block (no keys/lines left) → drop the frontmatter, keep body.
    if layout.had_block && layout.inner_lines.is_empty() {
        return layout.body.clone();
    }
    let mut out = String::new();
    if layout.had_block {
        out.push_str(&layout.open);
        out.push_str(&layout.inner_lines.join(layout.nl));
        out.push_str(layout.nl);
        out.push_str(&layout.close);
        out.push_str(&layout.body);
        return out;
    }
    // Synthesizing a brand-new block at the very top. No spurious blank line
    // ahead of a leading `# H1`: the closing fence's newline already separates
    // the block from the body. Trim leading newlines the body carried.
    out.push_str("---");
    out.push_str(layout.nl);
    out.push_str(&layout.inner_lines.join(layout.nl));
    out.push_str(layout.nl);
    out.push_str("---");
    out.push_str(layout.nl);
    if !layout.body.is_empty() {
        out.push_str(layout.body.trim_start_matches(['\n', '\r']));
    }
    out
}

/// Convert an incoming JSON value (from the JS side, where typing survives) to
/// a YAML value so quoting/typing is decided by serde_yaml's emitter:
/// numbers stay bare, booleans stay bare, strings get quoted only if needed,
/// arrays become sequences per serde_yaml defaults.
fn json_to_yaml(v: &serde_json::Value) -> serde_yaml::Value {
    match v {
        serde_json::Value::Null => serde_yaml::Value::Null,
        serde_json::Value::Bool(b) => serde_yaml::Value::Bool(*b),
        serde_json::Value::Number(n) => {
            if let Some(i) = n.as_i64() {
                serde_yaml::Value::Number(i.into())
            } else if let Some(u) = n.as_u64() {
                serde_yaml::Value::Number(u.into())
            } else if let Some(f) = n.as_f64() {
                serde_yaml::Value::Number(f.into())
            } else {
                serde_yaml::Value::String(n.to_string())
            }
        }
        serde_json::Value::String(s) => serde_yaml::Value::String(s.clone()),
        serde_json::Value::Array(a) => {
            serde_yaml::Value::Sequence(a.iter().map(json_to_yaml).collect())
        }
        serde_json::Value::Object(o) => {
            let mut m = serde_yaml::Mapping::new();
            for (k, val) in o {
                m.insert(serde_yaml::Value::String(k.clone()), json_to_yaml(val));
            }
            serde_yaml::Value::Mapping(m)
        }
    }
}

/// Set (insert or update) a single frontmatter key with a *line-surgical* edit:
/// only the target key's lines are rewritten (in place on update, appended on
/// insert). Every other line — comments, inline arrays, quote styles of other
/// keys — and the note body are preserved byte-for-byte. Returns the full
/// rewritten file content. Pure function over strings so it's unit-testable
/// without Tauri/IO — see `tests/frontmatter_edit_test.rs`.
pub fn set_frontmatter_property_str(
    raw: &str,
    key: &str,
    value: &serde_json::Value,
) -> Result<String, String> {
    if key.trim().is_empty() {
        return Err("frontmatter key must not be empty".into());
    }
    let mut layout = split_block(raw)?;
    let entry = render_entry(key, value)?;
    let spans = key_spans(&layout.inner_lines);

    if let Some(span) = spans.iter().find(|s| s.key == key) {
        // Update in place: replace exactly the lines this key occupied with the
        // freshly rendered single-key entry. Neighboring keys and their inline
        // formatting / comments are untouched.
        layout
            .inner_lines
            .splice(span.start..span.end, entry.into_iter());
    } else {
        // Append at the end of the block (after the last existing line).
        layout.inner_lines.extend(entry);
    }
    Ok(rebuild_block(&layout))
}

/// Delete a single frontmatter key with a line-surgical edit: only that key's
/// lines are removed; all other lines and the note body are preserved
/// byte-for-byte. A missing key is a no-op. Deleting the last key drops the
/// whole frontmatter block. Returns the full rewritten file content.
pub fn delete_frontmatter_property_str(raw: &str, key: &str) -> Result<String, String> {
    let mut layout = split_block(raw)?;
    let spans = key_spans(&layout.inner_lines);
    if let Some(span) = spans.iter().find(|s| s.key == key) {
        layout.inner_lines.drain(span.start..span.end);
        // If only blank lines / comments remain (no real keys left), treat the
        // block as empty so `rebuild_block` drops the frontmatter entirely.
        if key_spans(&layout.inner_lines).is_empty() {
            layout.inner_lines.clear();
        }
    }
    Ok(rebuild_block(&layout))
}

/// Tauri command: surgically set a frontmatter property on `path` and persist
/// it to disk, returning the rewritten file content so the caller can reflow
/// the open editor without a re-read. Body bytes + key order are preserved.
#[tauri::command]
pub async fn update_frontmatter_property(
    app: tauri::AppHandle,
    path: String,
    key: String,
    value: serde_json::Value,
) -> Result<String, String> {
    let path_for_index = path.clone();
    let next = tauri::async_runtime::spawn_blocking(move || {
        let raw = fs::read_to_string(&path).map_err(|e| e.to_string())?;
        let next = set_frontmatter_property_str(&raw, &key, &value)?;
        super::watcher::mark_self_write(&path);
        fs::write(&path, &next).map_err(|e| e.to_string())?;
        Ok::<String, String>(next)
    })
    .await
    .map_err(|e| format!("join: {e}"))??;
    #[cfg(not(target_os = "android"))]
    super::workspace_index::reindex_path(&app, Path::new(&path_for_index));
    #[cfg(target_os = "android")]
    let _ = (&app, &path_for_index);
    Ok(next)
}

/// Tauri command: surgically delete a frontmatter property on `path` and
/// persist it, returning the rewritten file content. Body bytes + key order
/// of the remaining keys are preserved.
#[tauri::command]
pub async fn delete_frontmatter_property(
    app: tauri::AppHandle,
    path: String,
    key: String,
) -> Result<String, String> {
    let path_for_index = path.clone();
    let next = tauri::async_runtime::spawn_blocking(move || {
        let raw = fs::read_to_string(&path).map_err(|e| e.to_string())?;
        let next = delete_frontmatter_property_str(&raw, &key)?;
        super::watcher::mark_self_write(&path);
        fs::write(&path, &next).map_err(|e| e.to_string())?;
        Ok::<String, String>(next)
    })
    .await
    .map_err(|e| format!("join: {e}"))??;
    #[cfg(not(target_os = "android"))]
    super::workspace_index::reindex_path(&app, Path::new(&path_for_index));
    #[cfg(target_os = "android")]
    let _ = (&app, &path_for_index);
    Ok(next)
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct UpdateProgressPayload {
    pub version: String,
    pub downloaded: u64,
    pub total: Option<u64>,
    pub percent: Option<u8>,
    pub source: String,
}

fn installer_asset_name(clean_ver: &str) -> Option<String> {
    #[cfg(all(target_os = "windows", target_arch = "aarch64"))]
    {
        return Some(format!("SoloMD_{clean_ver}_arm64_en-US.msi"));
    }
    #[cfg(all(target_os = "windows", not(target_arch = "aarch64")))]
    {
        return Some(format!("SoloMD_{clean_ver}_x64_en-US.msi"));
    }
    #[cfg(target_os = "macos")]
    {
        return Some(format!("SoloMD_{clean_ver}_universal.dmg"));
    }
    #[cfg(all(target_os = "linux", target_arch = "aarch64"))]
    {
        return Some(format!("SoloMD_{clean_ver}_aarch64.AppImage"));
    }
    #[cfg(all(target_os = "linux", not(target_arch = "aarch64")))]
    {
        return Some(format!("SoloMD_{clean_ver}_amd64.AppImage"));
    }
    #[cfg(target_os = "android")]
    {
        return Some(format!("SoloMD_{clean_ver}_arm64-v8a.apk"));
    }
    #[allow(unreachable_code)]
    None
}

async fn probe_is_china_network(client: &reqwest::Client) -> bool {
    for trace_url in [
        "https://solomd.app/cdn-cgi/trace",
        "https://www.cloudflare.com/cdn-cgi/trace",
    ] {
        if let Ok(resp) = client
            .get(trace_url)
            .timeout(std::time::Duration::from_millis(2500))
            .send()
            .await
        {
            if let Ok(text) = resp.text().await {
                if text.lines().any(|line| line.trim() == "loc=CN") {
                    return true;
                }
                if text.lines().any(|line| line.starts_with("loc=")) {
                    return false;
                }
            }
        }
    }
    false
}

async fn resolve_gitee_asset_url(
    client: &reqwest::Client,
    tag: &str,
    asset_name: &str,
) -> Option<String> {
    let api_url = format!("https://gitee.com/api/v5/repos/zhitong45/solomd/releases/tags/{tag}");
    let resp = client
        .get(&api_url)
        .timeout(std::time::Duration::from_secs(6))
        .send()
        .await
        .ok()?;
    if !resp.status().is_success() {
        return None;
    }
    let json: serde_json::Value = resp.json().await.ok()?;
    let assets = json.get("assets")?.as_array()?;
    for asset in assets {
        let name = asset.get("name").and_then(|v| v.as_str()).unwrap_or("");
        if name == asset_name {
            if let Some(url) = asset.get("browser_download_url").and_then(|v| v.as_str()) {
                if !url.is_empty() {
                    return Some(url.to_string());
                }
            }
        }
    }
    None
}

/// Set by `cancel_update_download` while a download is in flight. Reset at the
/// start of every download, so a cancelled run never poisons the next one.
static UPDATE_CANCELLED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// Stop the in-flight installer download. The partial file is discarded and
/// `download_and_install_update` resolves with an `Err("cancelled")` the
/// frontend recognises instead of falling back to the release page.
#[tauri::command]
pub fn cancel_update_download() {
    UPDATE_CANCELLED.store(true, std::sync::atomic::Ordering::SeqCst);
}

/// Download the platform installer for `version` (switching to Gitee automatically
/// when the visitor is in China, with cross-mirror fallback between Gitee and GitHub)
/// and launch the installer directly.
#[tauri::command]
pub async fn download_and_install_update(
    version: String,
    prefer_cn: bool,
    app: tauri::AppHandle,
) -> Result<String, String> {
    use futures_util::StreamExt;
    use std::io::Write;
    use std::sync::atomic::Ordering;
    use tauri::Emitter;

    UPDATE_CANCELLED.store(false, Ordering::SeqCst);

    let clean_ver = version.trim().trim_start_matches('v').to_string();
    if clean_ver.is_empty() {
        return Err("empty version".to_string());
    }
    let tag = format!("v{clean_ver}");
    let asset_name = installer_asset_name(&clean_ver)
        .ok_or_else(|| "direct update installer not supported on this platform".to_string())?;

    let client = reqwest::Client::builder()
        .user_agent(format!("SoloMD-Updater/{clean_ver}"))
        .connect_timeout(std::time::Duration::from_secs(10))
        .build()
        .map_err(|e| format!("http client build failed: {e}"))?;

    let is_cn = if prefer_cn {
        true
    } else {
        probe_is_china_network(&client).await
    };

    let mut candidates: Vec<(&'static str, String)> = Vec::new();
    let github_url = format!(
        "https://github.com/zhitongblog/solomd/releases/download/{tag}/{asset_name}"
    );
    let gitee_direct_url = format!(
        "https://gitee.com/zhitong45/solomd/releases/download/{tag}/{asset_name}"
    );

    if is_cn {
        if let Some(api_dl) = resolve_gitee_asset_url(&client, &tag, &asset_name).await {
            candidates.push(("Gitee", api_dl));
        }
        candidates.push(("Gitee", gitee_direct_url));
        candidates.push(("GitHub", github_url));
    } else {
        candidates.push(("GitHub", github_url));
        if let Some(api_dl) = resolve_gitee_asset_url(&client, &tag, &asset_name).await {
            candidates.push(("Gitee", api_dl));
        }
        candidates.push(("Gitee", gitee_direct_url));
    }
    candidates.dedup_by(|a, b| a.1 == b.1);

    let dest_dir = std::env::temp_dir();
    let part_path = dest_dir.join(format!("{asset_name}.part"));
    let dest_path = dest_dir.join(&asset_name);

    let mut last_err = String::from("no download candidates succeeded");
    let mut downloaded_ok = false;

    for (source, url) in candidates {
        if UPDATE_CANCELLED.load(Ordering::SeqCst) {
            return Err("cancelled".to_string());
        }
        let resp = match client.get(&url).send().await {
            Ok(r) => r,
            Err(e) => {
                last_err = format!("{source} request failed: {e}");
                continue;
            }
        };
        if !resp.status().is_success() {
            last_err = format!("{source} returned HTTP {}", resp.status());
            continue;
        }
        let content_type = resp
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .unwrap_or("")
            .to_ascii_lowercase();
        if content_type.contains("text/html") {
            last_err = format!("{source} returned HTML instead of binary installer");
            continue;
        }

        let total = resp.content_length();
        let mut file = match fs::File::create(&part_path) {
            Ok(f) => f,
            Err(e) => return Err(format!("create temp installer failed: {e}")),
        };

        let mut downloaded: u64 = 0;
        let mut last_emit = std::time::Instant::now()
            .checked_sub(std::time::Duration::from_secs(1))
            .unwrap_or_else(std::time::Instant::now);
        let mut stream = resp.bytes_stream();
        let mut stream_err: Option<String> = None;
        let mut cancelled_here = false;

        while let Some(chunk_res) = stream.next().await {
            if UPDATE_CANCELLED.load(Ordering::SeqCst) {
                cancelled_here = true;
                break;
            }
            match chunk_res {
                Ok(chunk) => {
                    if let Err(e) = file.write_all(&chunk) {
                        stream_err = Some(format!("write temp installer failed: {e}"));
                        break;
                    }
                    downloaded += chunk.len() as u64;
                    if last_emit.elapsed() >= std::time::Duration::from_millis(150) {
                        last_emit = std::time::Instant::now();
                        let percent = total.and_then(|t| {
                            if t > 0 {
                                Some(((downloaded.saturating_mul(100)) / t).min(100) as u8)
                            } else {
                                None
                            }
                        });
                        let _ = app.emit(
                            "solomd://update-progress",
                            UpdateProgressPayload {
                                version: clean_ver.clone(),
                                downloaded,
                                total,
                                percent,
                                source: source.to_string(),
                            },
                        );
                    }
                }
                Err(e) => {
                    stream_err = Some(format!("{source} stream interrupted: {e}"));
                    break;
                }
            }
        }

        if cancelled_here {
            let _ = fs::remove_file(&part_path);
            return Err("cancelled".to_string());
        }

        if let Some(err) = stream_err {
            let _ = fs::remove_file(&part_path);
            last_err = err;
            continue;
        }

        if downloaded < 100_000 {
            let _ = fs::remove_file(&part_path);
            last_err = format!("{source} file too small ({downloaded} bytes)");
            continue;
        }

        let _ = file.flush();
        drop(file);
        if dest_path.exists() {
            let _ = fs::remove_file(&dest_path);
        }
        fs::rename(&part_path, &dest_path)
            .map_err(|e| format!("finalize installer file failed: {e}"))?;

        let _ = app.emit(
            "solomd://update-progress",
            UpdateProgressPayload {
                version: clean_ver.clone(),
                downloaded,
                total: Some(downloaded),
                percent: Some(100),
                source: source.to_string(),
            },
        );
        downloaded_ok = true;
        break;
    }

    if !downloaded_ok {
        return Err(last_err);
    }

    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("msiexec")
            .arg("/i")
            .arg(&dest_path)
            .spawn()
            .map_err(|e| format!("failed to launch MSI installer: {e}"))?;
        let app_for_exit = app.clone();
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(600));
            app_for_exit.exit(0);
        });
    }

    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(&dest_path)
            .spawn()
            .map_err(|e| format!("failed to open DMG installer: {e}"))?;
    }

    #[cfg(target_os = "linux")]
    {
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = fs::set_permissions(&dest_path, fs::Permissions::from_mode(0o755));
        }
        let parent = dest_path.parent().unwrap_or(std::path::Path::new("/tmp"));
        let _ = std::process::Command::new("xdg-open").arg(parent).spawn();
    }

    #[cfg(target_os = "android")]
    {
        return Err("android_use_browser_fallback".to_string());
    }

    Ok(dest_path.to_string_lossy().to_string())
}

/// #606 — Convert pasted image bytes between PNG, WebP, and JPEG (with white
/// background compositing for RGBA -> JPEG). Used as a reliable cross-platform
/// fallback when WKWebView's `<canvas>.toBlob('image/webp')` silently emits PNG.
#[tauri::command]
pub async fn convert_image_format(
    data: Vec<u8>,
    format: String,
    quality: Option<u8>,
) -> Result<Vec<u8>, String> {
    tauri::async_runtime::spawn_blocking(move || convert_image_format_inner(&data, &format, quality))
        .await
        .map_err(|e| format!("join: {e}"))?
}

pub fn convert_image_format_inner(
    data: &[u8],
    format: &str,
    quality: Option<u8>,
) -> Result<Vec<u8>, String> {
    let decoded = image::load_from_memory(data)
        .map_err(|e| format!("failed to decode pasted image: {e}"))?;
    let mut out = Vec::new();
    match format.trim().to_ascii_lowercase().as_str() {
        "webp" => {
            decoded
                .write_to(&mut std::io::Cursor::new(&mut out), image::ImageFormat::WebP)
                .map_err(|e| format!("failed to encode WebP: {e}"))?;
        }
        "jpg" | "jpeg" => {
            let rgba = decoded.to_rgba8();
            let (w, h) = rgba.dimensions();
            let mut rgb = image::RgbImage::new(w, h);
            for (x, y, px) in rgba.enumerate_pixels() {
                let a = px[3] as u16;
                let inv = 255 - a;
                let r = ((px[0] as u16 * a + 255 * inv + 127) / 255) as u8;
                let g = ((px[1] as u16 * a + 255 * inv + 127) / 255) as u8;
                let b = ((px[2] as u16 * a + 255 * inv + 127) / 255) as u8;
                rgb.put_pixel(x, y, image::Rgb([r, g, b]));
            }
            let q = quality.unwrap_or(86).clamp(1, 100);
            let mut enc = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, q);
            enc.encode_image(&rgb)
                .map_err(|e| format!("failed to encode JPEG: {e}"))?;
        }
        "png" => {
            decoded
                .write_to(&mut std::io::Cursor::new(&mut out), image::ImageFormat::Png)
                .map_err(|e| format!("failed to encode PNG: {e}"))?;
        }
        other => return Err(format!("unsupported target image format: {other}")),
    }
    Ok(out)
}

#[cfg(test)]
mod list_dir_times_tests {
    use super::*;
    use std::time::{Duration, SystemTime, UNIX_EPOCH};

    fn now_ms() -> u64 {
        SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_millis() as u64
    }

    #[test]
    fn times_only_when_asked() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("a.md"), "a").unwrap();
        let p = dir.path().to_string_lossy().to_string();

        let plain = list_dir_with(p.clone(), false, false).unwrap();
        assert_eq!(plain.len(), 1);
        assert!(plain[0].modified.is_none() && plain[0].created.is_none());

        let timed = list_dir_with(p, false, true).unwrap();
        let m = timed[0].modified.expect("modified");
        let c = timed[0].created.expect("created (or modified fallback)");
        let now = now_ms();
        assert!(m <= now + 1_000 && now - m < 60_000, "modified {m} vs now {now}");
        assert!(c <= now + 1_000 && now - c < 60_000, "created {c} vs now {now}");
    }

    #[test]
    fn modified_tracks_later_writes() {
        let dir = tempfile::tempdir().unwrap();
        let old = dir.path().join("old.md");
        let new = dir.path().join("new.md");
        fs::write(&old, "o").unwrap();
        fs::write(&new, "n").unwrap();
        // Push old.md's mtime back an hour so the order can't be a tie.
        let hour_ago = SystemTime::now() - Duration::from_secs(3600);
        fs::File::options().write(true).open(&old).unwrap().set_modified(hour_ago).unwrap();
        let entries = list_dir_with(dir.path().to_string_lossy().to_string(), false, true).unwrap();
        let get = |n: &str| entries.iter().find(|e| e.name == n).unwrap().modified.unwrap();
        assert!(get("new.md") > get("old.md") + 3_000_000);
    }

    #[test]
    fn serialization_omits_absent_times() {
        let e = DirEntry { name: "x".into(), path: "/x".into(), is_dir: false, modified: None, created: None };
        let json = serde_json::to_string(&e).unwrap();
        assert!(!json.contains("modified") && !json.contains("created"), "{json}");
    }
}

#[cfg(test)]
mod encoding_round_trip_tests {
    use super::*;

    /// Write `original`, open it, save it back unchanged, and return the
    /// first read plus the bytes left on disk.
    fn round_trip(encoding: &str, original: &[u8]) -> (FileReadResult, Vec<u8>) {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("f.txt");
        fs::write(&p, original).unwrap();
        let path = p.to_string_lossy().to_string();
        let read = read_file_inner(path.clone()).unwrap();
        assert_eq!(read.encoding, encoding);
        write_file_inner(path.clone(), read.content.clone(), read.encoding.clone()).unwrap();
        let reread = read_file_inner(path).unwrap();
        assert_eq!(reread.encoding, encoding);
        assert_eq!(reread.content, read.content);
        (read, fs::read(&p).unwrap())
    }

    fn utf16(text: &str, le: bool) -> Vec<u8> {
        let mut bytes = if le { vec![0xFF, 0xFE] } else { vec![0xFE, 0xFF] };
        for u in text.encode_utf16() {
            bytes.extend_from_slice(&if le { u.to_le_bytes() } else { u.to_be_bytes() });
        }
        bytes
    }

    #[test]
    fn utf16le_with_bom_round_trips() {
        let text = "UTF-16 文件\nline 2 😀";
        let bytes = utf16(text, true);
        let (read, disk) = round_trip("UTF-16LE", &bytes);
        assert!(read.had_bom);
        assert_eq!(read.content, text);
        assert_eq!(disk, bytes);
    }

    #[test]
    fn utf16be_with_bom_round_trips() {
        let text = "UTF-16 文件\nline 2 😀";
        let bytes = utf16(text, false);
        let (read, disk) = round_trip("UTF-16BE", &bytes);
        assert!(read.had_bom);
        assert_eq!(read.content, text);
        assert_eq!(disk, bytes);
    }

    #[test]
    fn gbk_round_trips() {
        let text = "这是一个中文文件，用来测试 GBK 编码的读取和保存。\n第二行内容也是中文。";
        let (bytes, _, _) = encoding_rs::GBK.encode(text);
        let (read, disk) = round_trip("GBK", &bytes);
        assert_eq!(read.content, text);
        assert_eq!(disk, bytes.as_ref());
    }

    #[test]
    fn big5_round_trips() {
        let text = "這是一個繁體中文檔案，用來測試大五碼的讀取與儲存。\n第二行內容也是繁體中文。";
        let (bytes, _, _) = encoding_rs::BIG5.encode(text);
        let (read, disk) = round_trip("Big5", &bytes);
        assert_eq!(read.content, text);
        assert_eq!(disk, bytes.as_ref());
    }
}

#[cfg(test)]
mod v523_regression_tests {
    use super::*;

    #[test]
    fn convert_image_format_encodes_webp_jpeg_and_png_with_alpha_compositing() {
        let mut rgba = image::RgbaImage::new(16, 16);
        // Top-left 8x8 block is fully transparent -> JPEG composites over white;
        // bottom-right 8x8 block is opaque red (aligned to 8x8 DCT blocks).
        for y in 8..16 {
            for x in 8..16 {
                rgba.put_pixel(x, y, image::Rgba([255, 0, 0, 255]));
            }
        }
        let mut png_src = Vec::new();
        image::DynamicImage::ImageRgba8(rgba)
            .write_to(&mut std::io::Cursor::new(&mut png_src), image::ImageFormat::Png)
            .unwrap();

        let webp = convert_image_format_inner(&png_src, "webp", None).unwrap();
        assert_eq!(&webp[0..4], b"RIFF");
        assert_eq!(&webp[8..12], b"WEBP");

        let jpg = convert_image_format_inner(&png_src, "jpg", Some(95)).unwrap();
        assert_eq!(&jpg[0..2], &[0xFF, 0xD8]);
        let decoded_jpg = image::load_from_memory(&jpg).unwrap().to_rgb8();
        let top_left = decoded_jpg.get_pixel(0, 0);
        assert!(top_left[0] > 245 && top_left[1] > 245 && top_left[2] > 245);
        let bottom_right = decoded_jpg.get_pixel(12, 12);
        assert!(bottom_right[0] > 240 && bottom_right[1] < 20 && bottom_right[2] < 20);

        let png_out = convert_image_format_inner(&png_src, "png", None).unwrap();
        assert_eq!(&png_out[0..8], &[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A]);
    }

    #[test]
    fn inject_pdf_outlines_lopdf_builds_hierarchical_utf16be_bookmarks() {
        use lopdf::{dictionary, Document, Object};
        let dir = tempfile::tempdir().unwrap();
        let pdf_path = dir.path().join("book.pdf");

        let mut doc = Document::with_version("1.5");
        let pages_id = doc.new_object_id();
        let page1_id = doc.add_object(dictionary! {
            "Type" => "Page",
            "Parent" => pages_id,
            "MediaBox" => vec![0.into(), 0.into(), 595.into(), 842.into()],
        });
        let page2_id = doc.add_object(dictionary! {
            "Type" => "Page",
            "Parent" => pages_id,
            "MediaBox" => vec![0.into(), 0.into(), 595.into(), 842.into()],
        });
        doc.objects.insert(
            pages_id,
            Object::Dictionary(dictionary! {
                "Type" => "Pages",
                "Kids" => vec![page1_id.into(), page2_id.into()],
                "Count" => 2,
            }),
        );
        let catalog_id = doc.add_object(dictionary! {
            "Type" => "Catalog",
            "Pages" => pages_id,
        });
        doc.trailer.set("Root", catalog_id);
        doc.save(&pdf_path).unwrap();

        let items = vec![
            (1u8, "1 第一章 概览".to_string(), 1usize, 0.0f64),
            (2u8, "1.1 子节 Architecture".to_string(), 2usize, 0.5f64),
            (1u8, "2 第二章 总结".to_string(), 2usize, 0.8f64),
        ];
        let path_str = pdf_path.to_string_lossy().to_string();
        inject_pdf_outlines_lopdf(&path_str, &items, Some((42.52, 42.52, 42.52, 42.52))).unwrap();

        let reloaded = Document::load(&pdf_path).unwrap();
        let catalog = reloaded.catalog().unwrap();
        let outlines_id = catalog.get(b"Outlines").unwrap().as_reference().unwrap();
        let outlines_dict = reloaded.get_dictionary(outlines_id).unwrap();
        assert_eq!(outlines_dict.get(b"Count").unwrap().as_i64().unwrap(), 3);
        let first_id = outlines_dict.get(b"First").unwrap().as_reference().unwrap();
        let first_dict = reloaded.get_dictionary(first_id).unwrap();
        // First chapter has 1 child ("1.1 子节 Architecture")
        assert_eq!(first_dict.get(b"Count").unwrap().as_i64().unwrap(), 1);
        assert!(first_dict.get(b"First").is_ok());
        assert!(first_dict.get(b"Next").is_ok());
        // #625 — Dest must carry an explicit numeric Y coordinate (not Null)
        let dest = first_dict.get(b"Dest").unwrap().as_array().unwrap();
        let top_y = dest[3].as_float().expect("bookmark /XYZ top Y must be numeric");
        assert!(top_y > 700.0 && top_y <= 842.0);
        let child_id = first_dict.get(b"First").unwrap().as_reference().unwrap();
        let child_dest = reloaded.get_dictionary(child_id).unwrap().get(b"Dest").unwrap().as_array().unwrap();
        let child_y = child_dest[3].as_float().expect("child bookmark /XYZ top Y must be numeric");
        assert!(child_y < top_y, "mid-page heading must have lower PDF Y than top-of-page heading");
    }

    #[test]
    fn issue_628_rename_cjk_folder_does_not_panic_on_utf8_boundary() {
        // Exact folder name from issue #628 where s.len() - ".md".len() landed
        // inside the 3-byte UTF-8 character '部' (bytes 28..31).
        assert_eq!(strip_markdown_ext("第8篇：打包、安全与部署"), "第8篇：打包、安全与部署");
        assert_eq!(strip_markdown_ext("笔记.MD"), "笔记");

        let dir = tempfile::tempdir().unwrap();
        let old_folder = dir.path().join("第8篇：打包、安全与部署");
        let new_folder = dir.path().join("第9篇：打包、安全与部署");
        fs::create_dir_all(&old_folder).unwrap();
        fs::write(old_folder.join("note.md"), "# Hello\n").unwrap();
        fs::write(dir.path().join("index.md"), "[link](./第8篇：打包、安全与部署/note.md)\n").unwrap();

        let updated = fs_rename_with_workspace(
            old_folder.to_string_lossy().to_string(),
            new_folder.to_string_lossy().to_string(),
            Some(dir.path().to_string_lossy().to_string()),
            true,
        )
        .expect("renaming CJK folder must succeed without panicking");

        assert!(!old_folder.exists());
        assert!(new_folder.is_dir());
        assert_eq!(updated.len(), 1);
        let index = fs::read_to_string(dir.path().join("index.md")).unwrap();
        assert!(index.contains("第9篇：打包、安全与部署/note.md"));
    }
}
