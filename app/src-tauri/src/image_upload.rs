//! Image-bed (图床) upload backend for the SoloMD editor.
//!
//! Exposes a single async Tauri command, [`upload_image`], that takes a
//! tagged [`UploaderConfig`] (chosen + filled out in Settings → Image Bed on
//! the JS side) plus an absolute path to a local image file, uploads the file
//! to the selected backend, and returns the resulting public URL.
//!
//! Five backends are supported:
//!   * **Picgo**  — POST to a running PicGo app's HTTP server.
//!   * **Command** — shell out to an arbitrary CLI uploader (PicGo-Core, uPic…)
//!     and scrape the URL from stdout.
//!   * **Smms**   — sm.ms v2 multipart upload API.
//!   * **S3**     — any S3-compatible object store (AWS / R2 / MinIO …) via a
//!     hand-rolled AWS Signature V4 PUT (no aws-sdk dependency).
//!   * **Github** — GitHub contents API PUT, served back over raw or jsDelivr.
//!
//! All network / IO / signing errors are flattened into human-readable
//! `String`s so the frontend can surface them directly to the user.

use base64::Engine;
use hmac::{Hmac, Mac};
use sha2::{Digest, Sha256};
use std::path::Path;

type HmacSha256 = Hmac<Sha256>;

/// User-Agent sent on outbound requests. sm.ms and GitHub both reject requests
/// without a sane UA, so we always set one.
const USER_AGENT: &str = "SoloMD/1.0";

/// The image-bed backend selected by the user, deserialized from the JS
/// `config` object. Internally tagged on `kind` (`picgo` / `command` /
/// `smms` / `s3` / `github`); struct fields arrive in camelCase.
#[derive(serde::Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum UploaderConfig {
    /// A running PicGo desktop app exposing its localhost upload server.
    #[serde(rename_all = "camelCase")]
    Picgo {
        /// e.g. `http://127.0.0.1:36677/upload`.
        endpoint: String,
    },
    /// An arbitrary shell command template containing a `{path}` placeholder.
    #[serde(rename_all = "camelCase")]
    Command {
        /// e.g. `picgo upload {path}`.
        command: String,
    },
    /// The sm.ms hosted image bed.
    #[serde(rename_all = "camelCase")]
    Smms {
        /// API token; empty string = anonymous upload.
        token: String,
    },
    /// Any S3-compatible object store (AWS S3, Cloudflare R2, MinIO…).
    #[serde(rename_all = "camelCase")]
    S3 {
        /// e.g. `https://s3.amazonaws.com` or `https://xxx.r2.cloudflarestorage.com`.
        endpoint: String,
        /// e.g. `us-east-1`; R2 uses `auto`.
        region: String,
        bucket: String,
        access_key_id: String,
        secret_access_key: String,
        /// Full object key (the frontend already joined prefix + filename).
        key: String,
        /// Optional CDN/custom domain for the returned URL; empty = use the
        /// upload URL itself.
        custom_domain: String,
        /// `true` = path-style (R2 / MinIO), `false` = virtual-host (AWS).
        use_path_style: bool,
    },
    /// A GitHub repository served over raw.githubusercontent.com or jsDelivr.
    #[serde(rename_all = "camelCase")]
    Github {
        /// `owner/repo`.
        repo: String,
        /// e.g. `main`.
        branch: String,
        /// GitHub personal access token.
        token: String,
        /// Full path inside the repo (frontend already built it).
        key: String,
        /// `raw` or `jsdelivr`.
        cdn: String,
    },
}

/// Upload a local image file to the configured image bed and return its public
/// URL. `path` is the absolute path of the local file to upload. See the module
/// docs for per-backend behavior.
#[tauri::command]
pub async fn upload_image(config: UploaderConfig, path: String) -> Result<String, String> {
    match config {
        UploaderConfig::Picgo { endpoint } => upload_picgo(&endpoint, &path).await,
        UploaderConfig::Command { command } => {
            // Shelling out is blocking; keep it off the async IPC thread.
            tauri::async_runtime::spawn_blocking(move || upload_command(&command, &path))
                .await
                .map_err(|e| format!("join: {e}"))?
        }
        UploaderConfig::Smms { token } => upload_smms(&token, &path).await,
        UploaderConfig::S3 {
            endpoint,
            region,
            bucket,
            access_key_id,
            secret_access_key,
            key,
            custom_domain,
            use_path_style,
        } => {
            upload_s3(S3Params {
                endpoint: &endpoint,
                region: &region,
                bucket: &bucket,
                access_key_id: &access_key_id,
                secret_access_key: &secret_access_key,
                key: &key,
                custom_domain: &custom_domain,
                use_path_style,
                path: &path,
            })
            .await
        }
        UploaderConfig::Github {
            repo,
            branch,
            token,
            key,
            cdn,
        } => upload_github(&repo, &branch, &token, &key, &cdn, &path).await,
    }
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/// Best-effort MIME type from a file extension, defaulting to
/// `application/octet-stream`.
fn guess_mime(path: &str) -> &'static str {
    let ext = Path::new(path)
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "bmp" => "image/bmp",
        "svg" => "image/svg+xml",
        _ => "application/octet-stream",
    }
}

/// The final path component (filename) of a path string.
fn basename(path: &str) -> String {
    Path::new(path)
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("image")
        .to_string()
}

// ---------------------------------------------------------------------------
// Picgo
// ---------------------------------------------------------------------------

/// Upload via a running PicGo desktop app's HTTP server. POSTs
/// `{"list": ["<path>"]}` and reads back `result[0]` from the JSON response.
async fn upload_picgo(endpoint: &str, path: &str) -> Result<String, String> {
    let body = serde_json::json!({ "list": [path] });
    let res = reqwest::Client::new()
        .post(endpoint)
        .header("Content-Type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("PicGo request failed: {e}"))?;

    let status = res.status();
    let text = res
        .text()
        .await
        .map_err(|e| format!("PicGo read response failed: {e}"))?;
    let json: serde_json::Value = serde_json::from_str(&text)
        .map_err(|e| format!("PicGo returned non-JSON ({status}): {e}: {text}"))?;

    let success = json.get("success").and_then(|v| v.as_bool()).unwrap_or(false);
    let first = json
        .get("result")
        .and_then(|v| v.as_array())
        .and_then(|a| a.first())
        .and_then(|v| v.as_str());

    if success {
        if let Some(url) = first {
            return Ok(url.to_string());
        }
    }
    let msg = json
        .get("message")
        .and_then(|v| v.as_str())
        .unwrap_or("upload failed (no result URL)");
    Err(format!("PicGo: {msg}"))
}

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

/// Run a user-supplied shell command template and scrape the resulting URL
/// from stdout. `{path}` in the template is replaced with the quoted file path;
/// if the template has no `{path}`, the quoted path is appended.
fn upload_command(template: &str, path: &str) -> Result<String, String> {
    // Quote the path so spaces survive the shell. Strip any embedded double
    // quotes from the path defensively (filenames almost never contain them).
    let safe_path = path.replace('"', "");
    let quoted = format!("\"{safe_path}\"");
    let cmd_str = if template.contains("{path}") {
        template.replace("{path}", &quoted)
    } else {
        format!("{template} {quoted}")
    };

    let output = if cfg!(windows) {
        std::process::Command::new("cmd")
            .arg("/C")
            .arg(&cmd_str)
            .output()
    } else {
        std::process::Command::new("sh")
            .arg("-c")
            .arg(&cmd_str)
            .output()
    }
    .map_err(|e| format!("failed to spawn command: {e}"))?;

    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);

    if !output.status.success() {
        return Err(format!(
            "command exited with {}: {}",
            output.status,
            stderr.trim()
        ));
    }

    match extract_last_url(&stdout) {
        Some(url) => Ok(url),
        None => Err(format!(
            "no http(s) URL found in command output. stdout: {} stderr: {}",
            stdout.trim(),
            stderr.trim()
        )),
    }
}

/// Find every `https?://…` token in `text` and return the last one with
/// trailing punctuation trimmed. Tools like PicGo-Core / uPic print the final
/// URL on the last line.
fn extract_last_url(text: &str) -> Option<String> {
    let mut last: Option<String> = None;
    let mut i = 0;
    while i < text.len() {
        let rest = &text[i..];
        if rest.starts_with("http://") || rest.starts_with("https://") {
            // Consume until whitespace.
            let end = rest.find(char::is_whitespace).unwrap_or(rest.len());
            let url = rest[..end].trim_end_matches(|c: char| {
                matches!(c, '.' | ',' | ')' | ']' | '}' | '"' | '\'' | '>' | ';' | ':')
            });
            if !url.is_empty() {
                last = Some(url.to_string());
            }
            i += end.max(1);
        } else {
            // Advance by one char boundary.
            i += rest.chars().next().map(|c| c.len_utf8()).unwrap_or(1);
        }
    }
    last
}

// ---------------------------------------------------------------------------
// sm.ms
// ---------------------------------------------------------------------------

/// Upload to sm.ms via its v2 multipart API. Handles the `image_repeated`
/// response (an already-uploaded duplicate) as a success.
async fn upload_smms(token: &str, path: &str) -> Result<String, String> {
    let bytes = std::fs::read(path).map_err(|e| format!("read file failed: {e}"))?;
    let filename = basename(path);
    let mime = guess_mime(path);

    let part = reqwest::multipart::Part::bytes(bytes)
        .file_name(filename)
        .mime_str(mime)
        .map_err(|e| format!("mime error: {e}"))?;
    let form = reqwest::multipart::Form::new().part("smfile", part);

    let mut req = reqwest::Client::new()
        .post("https://sm.ms/api/v2/upload")
        .header("User-Agent", USER_AGENT)
        .multipart(form);
    if !token.is_empty() {
        req = req.header("Authorization", token);
    }

    let res = req
        .send()
        .await
        .map_err(|e| format!("sm.ms request failed: {e}"))?;
    let status = res.status();
    let text = res
        .text()
        .await
        .map_err(|e| format!("sm.ms read response failed: {e}"))?;
    let json: serde_json::Value = serde_json::from_str(&text)
        .map_err(|e| format!("sm.ms returned non-JSON ({status}): {e}: {text}"))?;

    let success = json.get("success").and_then(|v| v.as_bool()).unwrap_or(false);
    if success {
        if let Some(url) = json
            .get("data")
            .and_then(|d| d.get("url"))
            .and_then(|v| v.as_str())
        {
            return Ok(url.to_string());
        }
        return Err("sm.ms: success but no data.url in response".into());
    }

    // Duplicate upload: sm.ms returns the existing URL in `images`.
    let code = json.get("code").and_then(|v| v.as_str()).unwrap_or("");
    if code == "image_repeated" {
        if let Some(url) = json.get("images").and_then(|v| v.as_str()) {
            if !url.is_empty() {
                return Ok(url.to_string());
            }
        }
    }

    let msg = json
        .get("message")
        .and_then(|v| v.as_str())
        .unwrap_or("upload failed");
    Err(format!("sm.ms: {msg}"))
}

// ---------------------------------------------------------------------------
// S3 (AWS Signature V4)
// ---------------------------------------------------------------------------

/// Percent-encode a path/segment for SigV4 canonicalization. Encodes every
/// byte except the RFC 3986 unreserved set (`A-Za-z0-9-._~`) and `/` (S3 keys
/// keep their slashes unencoded).
fn uri_encode(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    for &b in input.as_bytes() {
        let keep =
            b.is_ascii_alphanumeric() || matches!(b, b'-' | b'.' | b'_' | b'~' | b'/');
        if keep {
            out.push(b as char);
        } else {
            out.push('%');
            out.push_str(&format!("{b:02X}"));
        }
    }
    out
}

/// Lowercase hex SHA-256 of the given bytes.
fn sha256_hex(data: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(data);
    hex::encode(hasher.finalize())
}

/// HMAC-SHA256(key, msg) → raw bytes.
fn hmac_sha256(key: &[u8], msg: &[u8]) -> Vec<u8> {
    let mut mac = HmacSha256::new_from_slice(key).expect("HMAC accepts any key length");
    mac.update(msg);
    mac.finalize().into_bytes().to_vec()
}

/// Bundled arguments for [`upload_s3`] (clippy: too many positional args).
struct S3Params<'a> {
    endpoint: &'a str,
    region: &'a str,
    bucket: &'a str,
    access_key_id: &'a str,
    secret_access_key: &'a str,
    key: &'a str,
    custom_domain: &'a str,
    use_path_style: bool,
    /// Absolute local path of the file to upload.
    path: &'a str,
}

/// Upload a file to an S3-compatible store via a SigV4-signed PUT.
///
/// Signed headers are `host;x-amz-content-sha256;x-amz-date` — we deliberately
/// do NOT send a `Content-Type` header, keeping the signed set minimal so the
/// signature can never mismatch a header the HTTP client adds on its own.
async fn upload_s3(p: S3Params<'_>) -> Result<String, String> {
    let bytes = std::fs::read(p.path).map_err(|e| format!("read file failed: {e}"))?;

    // Derive the host from the endpoint (strip scheme + trailing slash).
    let endpoint_trimmed = p.endpoint.trim_end_matches('/');
    let scheme = if let Some(rest) = endpoint_trimmed.strip_prefix("https://") {
        let _ = rest;
        "https"
    } else if endpoint_trimmed.strip_prefix("http://").is_some() {
        "http"
    } else {
        "https"
    };
    let endpoint_host = endpoint_trimmed
        .trim_start_matches("https://")
        .trim_start_matches("http://");

    // Build host header, canonical URI, and request URL per addressing style.
    let (host, canonical_uri, url) = if p.use_path_style {
        let host = endpoint_host.to_string();
        let canonical_uri = format!("/{}/{}", uri_encode(p.bucket), uri_encode(p.key));
        let url = format!("{scheme}://{host}{canonical_uri}");
        (host, canonical_uri, url)
    } else {
        let host = format!("{}.{}", p.bucket, endpoint_host);
        let canonical_uri = format!("/{}", uri_encode(p.key));
        let url = format!("{scheme}://{host}{canonical_uri}");
        (host, canonical_uri, url)
    };

    // Timestamps.
    let now = chrono::Utc::now();
    let amz_date = now.format("%Y%m%dT%H%M%SZ").to_string();
    let date_stamp = now.format("%Y%m%d").to_string();

    let payload_hash = sha256_hex(&bytes);

    // Canonical request. Signed headers: host;x-amz-content-sha256;x-amz-date.
    let signed_headers = "host;x-amz-content-sha256;x-amz-date";
    let canonical_headers = format!(
        "host:{host}\nx-amz-content-sha256:{payload_hash}\nx-amz-date:{amz_date}\n"
    );
    let canonical_query = ""; // no query params
    let canonical_request = format!(
        "PUT\n{canonical_uri}\n{canonical_query}\n{canonical_headers}\n{signed_headers}\n{payload_hash}"
    );

    // String to sign.
    let scope = format!("{date_stamp}/{}/s3/aws4_request", p.region);
    let string_to_sign = format!(
        "AWS4-HMAC-SHA256\n{amz_date}\n{scope}\n{}",
        sha256_hex(canonical_request.as_bytes())
    );

    // Signing key chain.
    let k_date = hmac_sha256(
        format!("AWS4{}", p.secret_access_key).as_bytes(),
        date_stamp.as_bytes(),
    );
    let k_region = hmac_sha256(&k_date, p.region.as_bytes());
    let k_service = hmac_sha256(&k_region, b"s3");
    let k_signing = hmac_sha256(&k_service, b"aws4_request");
    let signature = hex::encode(hmac_sha256(&k_signing, string_to_sign.as_bytes()));

    let authorization = format!(
        "AWS4-HMAC-SHA256 Credential={}/{scope}, SignedHeaders={signed_headers}, Signature={signature}",
        p.access_key_id
    );

    let res = reqwest::Client::new()
        .put(&url)
        .header("Host", &host)
        .header("x-amz-content-sha256", &payload_hash)
        .header("x-amz-date", &amz_date)
        .header("Authorization", authorization)
        .body(bytes)
        .send()
        .await
        .map_err(|e| format!("S3 request failed: {e}"))?;

    let status = res.status();
    if !status.is_success() {
        let body = res.text().await.unwrap_or_default();
        return Err(format!("S3 upload failed ({status}): {body}"));
    }

    // Public URL.
    if !p.custom_domain.is_empty() {
        let domain = p.custom_domain.trim_end_matches('/');
        Ok(format!("{domain}/{}", p.key))
    } else {
        Ok(url)
    }
}

// ---------------------------------------------------------------------------
// GitHub
// ---------------------------------------------------------------------------

/// Upload a file into a GitHub repo via the contents API, returning the public
/// URL served over raw.githubusercontent.com or jsDelivr. A 422 (path already
/// exists) is surfaced as an error — the frontend mints unique keys so this is
/// rare.
async fn upload_github(
    repo: &str,
    branch: &str,
    token: &str,
    key: &str,
    cdn: &str,
    path: &str,
) -> Result<String, String> {
    let bytes = std::fs::read(path).map_err(|e| format!("read file failed: {e}"))?;
    let content_b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
    let filename = basename(path);

    let body = serde_json::json!({
        "message": format!("Upload {filename} via SoloMD"),
        "content": content_b64,
        "branch": branch,
    });

    let api_url = format!("https://api.github.com/repos/{repo}/contents/{key}");
    let res = reqwest::Client::new()
        .put(&api_url)
        .header("Authorization", format!("Bearer {token}"))
        .header("Accept", "application/vnd.github+json")
        .header("User-Agent", "SoloMD")
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("GitHub request failed: {e}"))?;

    let status = res.status();
    if !status.is_success() {
        let text = res.text().await.unwrap_or_default();
        let msg = serde_json::from_str::<serde_json::Value>(&text)
            .ok()
            .and_then(|j| j.get("message").and_then(|v| v.as_str()).map(String::from))
            .unwrap_or(text);
        return Err(format!("GitHub upload failed ({status}): {msg}"));
    }

    if cdn == "jsdelivr" {
        Ok(format!("https://cdn.jsdelivr.net/gh/{repo}@{branch}/{key}"))
    } else {
        Ok(format!("https://raw.githubusercontent.com/{repo}/{branch}/{key}"))
    }
}
