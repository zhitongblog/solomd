/**
 * Diagrams for the file exports that leave the app: standalone HTML (#332)
 * and Word (#256).
 *
 * `renderMarkdown()` leaves a ```mermaid fence as a plain
 * `<pre><code class="language-mermaid">` — the Preview pane, the image export
 * and both PDF paths each swap that for an SVG afterwards, but the HTML export
 * wrote the fence out untouched, so the exported page showed diagram source.
 * The file has to stand on its own (offline, no CDN), so the SVG is rendered
 * here, at export time, and written into the page — not a `<script>` that
 * renders on open.
 *
 * PlantUML is opt-in and server-rendered (see `lib/plantuml.ts`). Its SVG is
 * fetched once at export time and inlined; if the server cannot be reached or
 * refuses the cross-origin read, the diagram falls back to the same `<img>`
 * the Preview pane uses, so the page still shows it wherever that server is
 * reachable.
 */
import { renderMermaidCached } from './mermaid-lazy';
import { isPlantumlLang, plantumlSvgUrl } from './plantuml';

export interface DiagramExportOptions {
  /** PlantUML server, only when the user has turned PlantUML on. */
  plantumlServer?: string | null;
}

/**
 * Replace every mermaid (and, if enabled, PlantUML) fence in rendered HTML
 * with the diagram as inline SVG. Documents without diagrams are returned
 * unchanged and never load the mermaid bundle.
 */
export async function inlineDiagramsInHtml(
  html: string,
  opts: DiagramExportOptions = {},
): Promise<string> {
  const hasMermaid = html.includes('language-mermaid');
  const hasPuml = !!opts.plantumlServer && /language-(plantuml|puml)/.test(html);
  if (!hasMermaid && !hasPuml) return html;

  const tpl = document.createElement('template');
  tpl.innerHTML = html;
  const root = tpl.content;

  if (hasMermaid) {
    const blocks = Array.from(root.querySelectorAll('pre > code.language-mermaid'));
    if (blocks.length) {
      // The exported page is always the light paper palette. #522 — the
      // shared queue serialises these with anything the preview is doing.
      for (const code of blocks) {
        const pre = code.parentElement;
        if (!pre) continue;
        const source = (code.textContent || '').trim();
        try {
          const result = await renderMermaidCached('default', source);
          if (!result.svg) throw new Error(result.error || 'unknown error');
          const wrap = document.createElement('div');
          wrap.className = 'mermaid-block';
          wrap.innerHTML = result.svg;
          pre.replaceWith(wrap);
        } catch (e) {
          // A broken diagram must not abort the export: keep the source and
          // say why, the way the Preview pane does.
          const err = document.createElement('pre');
          err.className = 'mermaid-error';
          err.textContent = `Mermaid error: ${(e as Error).message}\n\n${source}`;
          pre.replaceWith(err);
        }
      }
    }
  }

  if (hasPuml && opts.plantumlServer) {
    const blocks = Array.from(root.querySelectorAll('pre > code')).filter((c) =>
      Array.from(c.classList).some((cls) => cls.startsWith('language-') && isPlantumlLang(cls.slice(9))),
    );
    for (const code of blocks) {
      const pre = code.parentElement;
      if (!pre) continue;
      const url = plantumlSvgUrl(opts.plantumlServer, (code.textContent || '').trim());
      const wrap = document.createElement('div');
      wrap.className = 'plantuml-block';
      try {
        const res = await fetch(url);
        const text = res.ok ? await res.text() : '';
        if (!/<svg[\s>]/i.test(text)) throw new Error('not svg');
        wrap.innerHTML = text.slice(text.search(/<svg[\s>]/i));
      } catch {
        const img = document.createElement('img');
        img.alt = 'PlantUML diagram';
        img.src = url;
        wrap.appendChild(img);
      }
      pre.replaceWith(wrap);
    }
  }

  const out = document.createElement('div');
  out.appendChild(root);
  return out.innerHTML;
}

export interface DiagramPng {
  data: Uint8Array;
  /** CSS-pixel size of the diagram (the PNG itself is rendered at 2×). */
  width: number;
  height: number;
}

/**
 * Render one mermaid source to PNG bytes for formats that cannot embed SVG
 * (Word). Returns null for a diagram that fails to render or rasterize; the
 * caller keeps the source as a code block then.
 */
export async function mermaidToPng(source: string): Promise<DiagramPng | null> {
  try {
    const result = await renderMermaidCached('default', source.trim());
    if (!result.svg) return null;
    return await svgToPng(result.svg);
  } catch (e) {
    console.warn('[export] mermaid → png failed', e);
    return null;
  }
}

async function svgToPng(svg: string): Promise<DiagramPng | null> {
  // Mermaid serialises as HTML (`<br>` inside labels is not self-closed), so
  // an XML parse fails on any multi-line label; parse as HTML instead.
  const host = document.createElement('div');
  host.innerHTML = svg;
  const el = host.querySelector('svg');
  if (!el) return null;
  const vb = (el.getAttribute('viewBox') || '').split(/[\s,]+/).map(Number);
  let width = vb.length === 4 ? vb[2] : parseFloat(el.getAttribute('width') || '');
  let height = vb.length === 4 ? vb[3] : parseFloat(el.getAttribute('height') || '');
  if (!(width > 0) || !(height > 0)) return null;
  // Mermaid emits `width="100%"` + a max-width style; an <img> needs a real
  // intrinsic size to rasterize at.
  el.setAttribute('width', String(width));
  el.setAttribute('height', String(height));
  el.removeAttribute('style');
  foreignObjectsToText(el);
  const xml = new XMLSerializer().serializeToString(el);
  const url = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(xml)}`;

  const img = new Image();
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve();
    img.onerror = () => reject(new Error('svg image failed to load'));
    img.src = url;
  });
  const scale = 2;
  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(width * scale);
  canvas.height = Math.ceil(height * scale);
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
  if (!blob) return null;
  width = Math.round(width);
  height = Math.round(height);
  return { data: new Uint8Array(await blob.arrayBuffer()), width, height };
}

const SVG_NS = 'http://www.w3.org/2000/svg';

/**
 * Swap mermaid's HTML labels (`<foreignObject>`) for plain SVG `<text>`.
 *
 * WebKit — the webview on macOS, iOS and Linux — taints a canvas as soon as
 * it draws an SVG containing `<foreignObject>`, and a tainted canvas refuses
 * `toBlob`, so every flowchart would have fallen back to its source there.
 * Mermaid's `htmlLabels: false` does not reach the flowchart renderer in the
 * version we ship (checked: the labels stay HTML with it set), so the labels
 * are rewritten here: centred lines of text in the foreignObject's own box,
 * which is exactly where the HTML label was drawn.
 */
export function foreignObjectsToText(root: Element) {
  interface StyledRun {
    text: string;
    bold: boolean;
    italic: boolean;
  }
  for (const fo of Array.from(root.getElementsByTagNameNS(SVG_NS, 'foreignObject'))) {
    const w = parseFloat(fo.getAttribute('width') || '0');
    const h = parseFloat(fo.getAttribute('height') || '0');
    const x = parseFloat(fo.getAttribute('x') || '0');
    const y = parseFloat(fo.getAttribute('y') || '0');
    // `<br>` separates lines; `<b>`/`<strong>` and `<i>`/`<em>` preserve inline styles (#600).
    const rawLines: StyledRun[][] = [[]];
    const walk = (n: Node, bold: boolean, italic: boolean) => {
      if (n.nodeType === 3 /* Node.TEXT_NODE */) {
        const val = n.nodeValue || '';
        if (val) rawLines[rawLines.length - 1].push({ text: val, bold, italic });
        return;
      }
      const el = n as Element;
      const tag = (el.localName || el.tagName || '').toLowerCase();
      if (tag === 'br') {
        rawLines.push([]);
        return;
      }
      const nextBold = bold || tag === 'b' || tag === 'strong';
      const nextItalic = italic || tag === 'i' || tag === 'em';
      n.childNodes.forEach((child) => walk(child, nextBold, nextItalic));
    };
    fo.childNodes.forEach((child) => walk(child, false, false));

    const lines = rawLines
      .map((runs) => {
        const merged: StyledRun[] = [];
        for (const r of runs) {
          const norm = r.text.replace(/\s+/g, ' ');
          if (!norm) continue;
          const prev = merged[merged.length - 1];
          if (prev && prev.bold === r.bold && prev.italic === r.italic) {
            prev.text += norm;
          } else {
            merged.push({ text: norm, bold: r.bold, italic: r.italic });
          }
        }
        if (merged.length > 0) {
          merged[0].text = merged[0].text.trimStart();
          merged[merged.length - 1].text = merged[merged.length - 1].text.trimEnd();
        }
        return merged.filter((r) => r.text.length > 0);
      })
      .filter((runs) => runs.length > 0);

    const ownerDoc = root.ownerDocument || document;
    const g = ownerDoc.createElementNS(SVG_NS, 'g');
    if (lines.length && w > 0 && h > 0) {
      // Edge labels sit on a grey chip (`.labelBkg`); keep it.
      if (fo.querySelector('.labelBkg')) {
        const bg = ownerDoc.createElementNS(SVG_NS, 'rect');
        bg.setAttribute('x', String(x));
        bg.setAttribute('y', String(y));
        bg.setAttribute('width', String(w));
        bg.setAttribute('height', String(h));
        bg.setAttribute('fill', 'rgba(232,232,232,0.8)');
        g.appendChild(bg);
      }
      const t = ownerDoc.createElementNS(SVG_NS, 'text');
      t.setAttribute('text-anchor', 'middle');
      t.setAttribute('font-family', '"trebuchet ms", verdana, arial, sans-serif');
      t.setAttribute('font-size', '16');
      t.setAttribute('fill', '#333');
      const lineH = h / lines.length;
      lines.forEach((runs, i) => {
        const span = ownerDoc.createElementNS(SVG_NS, 'tspan');
        span.setAttribute('x', String(x + w / 2));
        span.setAttribute('y', String(y + lineH * (i + 0.5)));
        span.setAttribute('dominant-baseline', 'central');
        if (runs.length === 1) {
          if (runs[0].bold) span.setAttribute('font-weight', 'bold');
          if (runs[0].italic) span.setAttribute('font-style', 'italic');
          span.textContent = runs[0].text;
        } else {
          for (const run of runs) {
            const child = ownerDoc.createElementNS(SVG_NS, 'tspan');
            if (run.bold) child.setAttribute('font-weight', 'bold');
            if (run.italic) child.setAttribute('font-style', 'italic');
            child.textContent = run.text;
            span.appendChild(child);
          }
        }
        t.appendChild(span);
      });
      g.appendChild(t);
    }
    fo.replaceWith(g);
  }
}

function bytesToBase64(bytes: Uint8Array): string {
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(bytes).toString('base64');
  }
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const sub = bytes.subarray(i, Math.min(i + chunkSize, bytes.length));
    binary += String.fromCharCode(...sub);
  }
  return btoa(binary);
}

/**
 * #578 — Replace ` ```mermaid ... ``` ` / ` ~~~mermaid ... ~~~ ` fenced blocks
 * in Markdown with rendered PNG `data:image/png;base64,...` images so Pandoc
 * embeds crisp diagram images directly into EPUB / ODT / RTF outputs instead of
 * showing raw Mermaid source code.
 */
export async function renderMermaidFencesInMarkdown(
  markdown: string,
  renderer: (source: string) => Promise<DiagramPng | null> = mermaidToPng,
): Promise<string> {
  if (!markdown || !/(?:`{3,}|~{3,})[ \t]*mermaid\b/i.test(markdown)) {
    return markdown;
  }
  const lines = markdown.split(/\r?\n/);
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const rawLine = lines[i];
    const openMatch = /^([ \t]*(?:>[ \t]*)*)(`{3,}|~{3,})[ \t]*([^\s`~]*)(.*)$/.exec(rawLine);
    if (!openMatch) {
      out.push(rawLine);
      i++;
      continue;
    }
    const indentPrefix = openMatch[1] || '';
    const fenceMarker = openMatch[2];
    const fenceChar = fenceMarker[0];
    const fenceLen = fenceMarker.length;
    const lang = (openMatch[3] || '').trim().toLowerCase();
    const restInfo = openMatch[4] || '';
    if (fenceChar === '`' && restInfo.includes('`')) {
      out.push(rawLine);
      i++;
      continue;
    }
    // Find matching closing fence
    let closeIdx = -1;
    const bodyLines: string[] = [];
    for (let j = i + 1; j < lines.length; j++) {
      const candidate = lines[j];
      const stripped = indentPrefix && candidate.startsWith(indentPrefix)
        ? candidate.slice(indentPrefix.length)
        : candidate.replace(/^[ \t]*(?:>[ \t]*)*/, '');
      const closeMatch = new RegExp(`^[ \\t]*${fenceChar}{${fenceLen},}[ \\t]*$`).exec(stripped);
      if (closeMatch) {
        closeIdx = j;
        break;
      }
      bodyLines.push(
        indentPrefix && candidate.startsWith(indentPrefix)
          ? candidate.slice(indentPrefix.length)
          : candidate,
      );
    }
    if (closeIdx < 0) {
      out.push(rawLine);
      i++;
      continue;
    }
    if (lang === 'mermaid') {
      const diagramCode = bodyLines.join('\n').trim();
      const png = diagramCode ? await renderer(diagramCode) : null;
      if (png && png.data.length > 0) {
        const b64 = bytesToBase64(png.data);
        out.push(`${indentPrefix}![](data:image/png;base64,${b64})`);
        i = closeIdx + 1;
        continue;
      }
    }
    for (let k = i; k <= closeIdx; k++) {
      out.push(lines[k]);
    }
    i = closeIdx + 1;
  }
  return out.join('\n');
}
