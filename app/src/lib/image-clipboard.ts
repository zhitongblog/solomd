/**
 * #362 — "Copy image": put a rendered `<img>` on the system clipboard as a
 * real bitmap (PNG), so it pastes into a browser forum, Word or WeChat — not
 * as a path or as markdown text.
 *
 * Getting the pixels. Images in the editor come from three kinds of source:
 *   - local files, shown through Tauri's asset protocol (`asset://localhost/…`
 *     on macOS/Linux, `http://asset.localhost/…` on Windows). That's another
 *     origin than the page, so drawing the displayed `<img>` taints the
 *     canvas. We read the file's bytes with `read_binary_file` instead.
 *   - remote http(s) URLs. Same taint problem, and a page `fetch()` only
 *     works when the server sends CORS headers, so we fall back to fetching
 *     from Rust (`fetch_image_bytes`).
 *   - `data:` / `blob:` URLs, which are same-origin and can be drawn as-is.
 * Whatever the bytes are (jpg, webp, gif — first frame —, svg, bmp…) they're
 * decoded by the webview and re-encoded as PNG through a canvas, since PNG is
 * the one image type every clipboard path accepts.
 *
 * Writing the clipboard. The Tauri clipboard plugin's `writeImage` goes first:
 * it writes the OS clipboard from Rust, so it doesn't care that the menu
 * click's user activation / document focus may be gone by the time the bytes
 * have been read (WKWebView rejects `navigator.clipboard.write` then, and
 * WebView2 rejects it when the window lost focus). The browser Clipboard API
 * is the fallback — it's what works on iOS, where `writeImage` isn't
 * implemented, and in a plain browser (dev harness).
 */
import { invoke } from '@tauri-apps/api/core';

/** Local file path behind an asset-protocol URL, or `null` for any other URL. */
export function localPathFromAssetUrl(src: string): string | null {
  const m = /^(?:asset:\/\/localhost\/|https?:\/\/asset\.localhost\/)([^?#]+)/i.exec(src);
  if (!m) return null;
  try {
    return decodeURIComponent(m[1]);
  } catch {
    return null;
  }
}

function mimeForPath(path: string): string {
  const ext = path.split(/[?#]/)[0].split('.').pop()?.toLowerCase() ?? '';
  switch (ext) {
    case 'jpg':
    case 'jpeg':
      return 'image/jpeg';
    case 'gif':
      return 'image/gif';
    case 'webp':
      return 'image/webp';
    case 'svg':
      return 'image/svg+xml';
    case 'bmp':
      return 'image/bmp';
    case 'avif':
      return 'image/avif';
    case 'ico':
      return 'image/x-icon';
    default:
      return 'image/png';
  }
}

function toBytes(data: unknown): Uint8Array {
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (data instanceof Uint8Array) return data;
  return new Uint8Array(data as number[]);
}

/** Bytes of the image behind `img`, as a Blob, from wherever it lives. */
async function fetchImageBlob(img: HTMLImageElement): Promise<Blob> {
  const src = img.currentSrc || img.src || '';
  return loadImageBlob(src, img.dataset.solomdLocalSrc || null);
}

/**
 * Bytes of an image from its URL: a local file (plain path or asset URL),
 * a `data:` / `blob:` URL, or a remote http(s) URL — through the page when
 * the server allows it (CORS), otherwise fetched by Rust. Shared by copy
 * image (#362) and the DOCX / raster-PDF exports, which lost remote images
 * to the same cross-origin wall.
 */
export async function loadImageBlob(src: string, localPath?: string | null): Promise<Blob> {
  const local =
    localPath ||
    localPathFromAssetUrl(src) ||
    (src && !/^[a-z][a-z0-9+.-]*:/i.test(src) ? src : null) ||
    (/^[a-z]:[\\/]/i.test(src) ? src : null);
  if (local) {
    try {
      // #735 — Prefer raw binary IPC (`ArrayBuffer`) so multi-hundred-MB DOCX
      // exports don't blow up WebView2 memory with JSON `number[]` arrays.
      const raw = await invoke<ArrayBuffer | Uint8Array | number[]>('read_binary_file_raw', { path: local });
      const bytes = raw instanceof ArrayBuffer ? new Uint8Array(raw) : toBytes(raw);
      if (bytes.length) return new Blob([bytes as BlobPart], { type: mimeForPath(local) });
    } catch {
      try {
        const bytes = toBytes(await invoke('read_binary_file', { path: local }));
        if (bytes.length) return new Blob([bytes as BlobPart], { type: mimeForPath(local) });
      } catch {
        // Fall through to fetching the displayed URL.
      }
    }
  }
  try {
    const res = await fetch(src);
    if (res.ok) return await res.blob();
  } catch {
    // Cross-origin without CORS, or no network from the page.
  }
  if (/^https?:/i.test(src) && !localPathFromAssetUrl(src)) {
    const bytes = toBytes(await invoke('fetch_image_bytes', { url: src }));
    return new Blob([bytes as BlobPart], { type: mimeForPath(src) });
  }
  throw new Error('could not read the image');
}

function decode(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const im = new Image();
    im.onload = () => resolve(im);
    im.onerror = () => reject(new Error('the image could not be decoded'));
    im.src = url;
  });
}

/** Draw `source` to a canvas and encode PNG. Throws on a tainted canvas. */
function drawToPng(source: HTMLImageElement, fallbackSize?: { w: number; h: number }): Promise<Blob> {
  let w = source.naturalWidth;
  let h = source.naturalHeight;
  if ((!w || !h) && fallbackSize) {
    w = fallbackSize.w;
    h = fallbackSize.h;
  }
  if (!w || !h) return Promise.reject(new Error('the image has no size'));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) return Promise.reject(new Error('no canvas context'));
  ctx.drawImage(source, 0, 0, w, h);
  return new Promise((resolve, reject) => {
    try {
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('PNG encoding failed'))), 'image/png');
    } catch (e) {
      reject(e); // SecurityError: tainted canvas
    }
  });
}

/** Re-encode any decodable image (webp, svg, avif, …) as PNG. */
export async function blobToPng(blob: Blob): Promise<Blob> {
  if (blob.type === 'image/png') return blob;
  const url = URL.createObjectURL(blob);
  try {
    return await drawToPng(await decode(url));
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** PNG bytes for the image an `<img>` element shows. */
export async function imageElementToPngBlob(img: HTMLImageElement): Promise<Blob> {
  const rect = img.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  const shown = { w: Math.round(rect.width * dpr), h: Math.round(rect.height * dpr) };
  const src = img.currentSrc || img.src || '';
  // Same-origin sources (data:, blob:) can be drawn straight from the element.
  if (/^(data|blob):/i.test(src) && img.complete && img.naturalWidth > 0) {
    try {
      return await drawToPng(img, shown);
    } catch {
      // Fall back to decoding the bytes ourselves.
    }
  }
  const blob = await fetchImageBlob(img);
  if (blob.type === 'image/png') return blob;
  const url = URL.createObjectURL(blob);
  try {
    return await drawToPng(await decode(url), shown);
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Put a PNG on the system clipboard (plugin first, Clipboard API fallback). */
export async function writePngToClipboard(png: Blob): Promise<void> {
  let pluginError: unknown = null;
  try {
    const [{ writeImage }, { Image }] = await Promise.all([
      import('@tauri-apps/plugin-clipboard-manager'),
      import('@tauri-apps/api/image'),
    ]);
    const image = await Image.fromBytes(new Uint8Array(await png.arrayBuffer()));
    await writeImage(image);
    return;
  } catch (e) {
    pluginError = e;
  }
  if (typeof ClipboardItem === 'undefined' || !navigator.clipboard?.write) {
    throw pluginError ?? new Error('clipboard unavailable');
  }
  await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })]);
}

/** Copy the image an `<img>` element shows to the clipboard as a bitmap. */
export async function copyImageElement(img: HTMLImageElement): Promise<void> {
  await writePngToClipboard(await imageElementToPngBlob(img));
}
