/**
 * Gitee #IK9BC3 — Excalidraw (`.excalidraw` JSON & ```excalidraw fence)
 * renderer and helper utilities.
 *
 * Converts Excalidraw JSON scenes (`{ "type": "excalidraw", "elements": [...] }`)
 * into clean, theme-aware vector SVGs so existing `.excalidraw` files and
 * ````excalidraw` code blocks render natively in Preview, Live Edit, and exports.
 */

export interface ExcalidrawElement {
  id?: string;
  type: string;
  x: number;
  y: number;
  width?: number;
  height?: number;
  strokeColor?: string;
  backgroundColor?: string;
  strokeWidth?: number;
  roughness?: number;
  opacity?: number;
  text?: string;
  fontSize?: number;
  points?: Array<[number, number]>;
  isDeleted?: boolean;
}

export interface ExcalidrawScene {
  type?: string;
  version?: number;
  elements: ExcalidrawElement[];
}

export function isExcalidrawPath(path: string): boolean {
  const lower = (path || '').toLowerCase();
  return (
    lower.endsWith('.excalidraw') ||
    lower.endsWith('.excalidraw.json') ||
    lower.endsWith('.excalidraw.svg') ||
    lower.endsWith('.excalidraw.png')
  );
}

function escapeXml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function parseExcalidrawScene(raw: string): ExcalidrawScene | null {
  try {
    const parsed = JSON.parse((raw || '').trim()) as Partial<ExcalidrawScene>;
    if (!parsed || !Array.isArray(parsed.elements)) return null;
    return {
      type: parsed.type ?? 'excalidraw',
      version: parsed.version ?? 2,
      elements: parsed.elements.filter((el) => el && !el.isDeleted && typeof el.x === 'number' && typeof el.y === 'number'),
    };
  } catch {
    return null;
  }
}

export function renderExcalidrawSvg(raw: string): string {
  const scene = parseExcalidrawScene(raw);
  if (!scene || scene.elements.length === 0) {
    return `<svg class="solomd-excalidraw" viewBox="0 0 320 120" width="100%" style="max-width:320px;height:auto;display:block;margin:8px auto;" xmlns="http://www.w3.org/2000/svg"><rect x="4" y="4" width="312" height="112" rx="8" fill="none" stroke="currentColor" stroke-dasharray="4 4" opacity="0.4"/><text x="160" y="64" text-anchor="middle" fill="currentColor" opacity="0.6" font-size="13" font-family="system-ui, sans-serif">Excalidraw</text></svg>`;
  }

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  for (const el of scene.elements) {
    const x = el.x ?? 0;
    const y = el.y ?? 0;
    const w = el.width ?? (el.text ? el.text.length * ((el.fontSize ?? 16) * 0.6) : 40);
    const h = el.height ?? (el.text ? (el.fontSize ?? 16) * 1.4 : 30);
    if (Array.isArray(el.points) && el.points.length > 0) {
      for (const [px, py] of el.points) {
        minX = Math.min(minX, x + px);
        minY = Math.min(minY, y + py);
        maxX = Math.max(maxX, x + px);
        maxY = Math.max(maxY, y + py);
      }
    } else {
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x + w);
      maxY = Math.max(maxY, y + h);
    }
  }

  const pad = 24;
  const vbX = Math.floor(minX - pad);
  const vbY = Math.floor(minY - pad);
  const vbW = Math.max(120, Math.ceil(maxX - minX + pad * 2));
  const vbH = Math.max(80, Math.ceil(maxY - minY + pad * 2));

  const body: string[] = [];
  body.push(
    `<defs><marker id="excalidraw-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M 0 1 L 8 5 L 0 9 z" fill="currentColor"/></marker></defs>`,
  );

  for (const el of scene.elements) {
    const stroke = el.strokeColor && el.strokeColor !== 'transparent' ? el.strokeColor : 'currentColor';
    const fill =
      el.backgroundColor && el.backgroundColor !== 'transparent' ? el.backgroundColor : 'none';
    const sw = el.strokeWidth ?? 1.8;
    const op = typeof el.opacity === 'number' ? Math.max(0.1, Math.min(1, el.opacity / 100)) : 1;
    const x = el.x;
    const y = el.y;
    const w = el.width ?? 80;
    const h = el.height ?? 40;

    if (el.type === 'rectangle') {
      body.push(
        `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="6" fill="${escapeXml(fill)}" stroke="${escapeXml(stroke)}" stroke-width="${sw}" opacity="${op}"/>`,
      );
    } else if (el.type === 'ellipse') {
      body.push(
        `<ellipse cx="${x + w / 2}" cy="${y + h / 2}" rx="${Math.abs(w) / 2}" ry="${Math.abs(h) / 2}" fill="${escapeXml(fill)}" stroke="${escapeXml(stroke)}" stroke-width="${sw}" opacity="${op}"/>`,
      );
    } else if (el.type === 'diamond') {
      const pts = `${x + w / 2},${y} ${x + w},${y + h / 2} ${x + w / 2},${y + h} ${x},${y + h / 2}`;
      body.push(
        `<polygon points="${pts}" fill="${escapeXml(fill)}" stroke="${escapeXml(stroke)}" stroke-width="${sw}" opacity="${op}"/>`,
      );
    } else if ((el.type === 'line' || el.type === 'arrow' || el.type === 'freedraw') && Array.isArray(el.points) && el.points.length >= 2) {
      const d = el.points
        .map(([px, py], idx) => `${idx === 0 ? 'M' : 'L'} ${x + px} ${y + py}`)
        .join(' ');
      const markerEnd = el.type === 'arrow' ? ' marker-end="url(#excalidraw-arrow)"' : '';
      body.push(
        `<path d="${d}" fill="none" stroke="${escapeXml(stroke)}" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round" opacity="${op}"${markerEnd}/>`,
      );
    } else if (el.type === 'text' && el.text) {
      const fs = el.fontSize ?? 16;
      const lines = el.text.split(/\r?\n/);
      lines.forEach((line, idx) => {
        body.push(
          `<text x="${x}" y="${y + fs + idx * fs * 1.25}" fill="${escapeXml(stroke)}" font-size="${fs}" font-family="system-ui, -apple-system, sans-serif" opacity="${op}">${escapeXml(line)}</text>`,
        );
      });
    }
  }

  return `<svg class="solomd-excalidraw" viewBox="${vbX} ${vbY} ${vbW} ${vbH}" width="100%" style="max-width:${vbW}px;height:auto;display:block;margin:8px auto;" xmlns="http://www.w3.org/2000/svg">${body.join('')}</svg>`;
}
