/**
 * image-overlay.ts — Fullscreen overlay viewer for images and diagrams.
 *
 * Opens when users click an `<img>` or Mermaid SVG in the preview pane.
 * Supports zoom (buttons, wheel, keyboard), pan (pointer drag), and
 * close (button, backdrop click, Escape).
 */

// ── Public interface ────────────────────────────────────────────────

export interface OverlayStrings {
  close: string;
  zoomIn: string;
  zoomOut: string;
  resetZoom: string;
  image: string;
  diagram: string;
}

export interface OverlayOptions {
  /** An <img> or SVG element to display in the overlay. */
  source: HTMLImageElement | SVGElement;
  /** Optional title (alt text, file name, etc.). */
  title?: string;
  /** Localised UI strings. */
  strings: OverlayStrings;
}

// ── Constants ───────────────────────────────────────────────────────

const ZOOM_STEP = 0.25;
const MIN_SCALE = 0.1;
const MAX_SCALE = 10;
const FIT_PADDING = 80;

// ── Singleton state ─────────────────────────────────────────────────

interface ActiveOverlay {
  backdrop: HTMLDivElement;
  viewport: HTMLDivElement;
  contentEl: HTMLDivElement;
  zoomPct: HTMLSpanElement;
  listeners: Array<{ el: EventTarget; type: string; fn: EventListener }>;
  triggerEl: HTMLElement | null;
  didPan: boolean;
}

let active: ActiveOverlay | null = null;
let scale = 1;
let panX = 0;
let panY = 0;
let styleInjected = false;

// ── Style injection ─────────────────────────────────────────────────

const CSS = `
.io-backdrop {
  position: fixed;
  inset: 0;
  z-index: 3000;
  background: rgba(0, 0, 0, 0.85);
  display: flex;
  flex-direction: column;
  backdrop-filter: blur(4px);
  cursor: grab;
  user-select: none;
}
.io-header {
  position: absolute;
  top: 0; left: 0; right: 0;
  height: 44px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 16px;
  background: linear-gradient(to bottom, rgba(0,0,0,0.6), transparent);
  z-index: 1;
  pointer-events: auto;
}
.io-header-title {
  font-family: var(--font-ui, sans-serif);
  font-size: 13px;
  color: rgba(255, 255, 255, 0.85);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: calc(100% - 60px);
}
.io-close {
  font-size: 22px;
  line-height: 1;
  color: rgba(255, 255, 255, 0.7);
  background: transparent;
  border: none;
  cursor: pointer;
  width: 36px;
  height: 36px;
  border-radius: 6px;
  display: flex;
  align-items: center;
  justify-content: center;
}
.io-close:hover {
  background: rgba(255, 255, 255, 0.15);
  color: #fff;
}
.io-content {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
  position: relative;
  /* Disable native pan/zoom so our pointer handlers can do pinch + pan. */
  touch-action: none;
  -webkit-touch-callout: none;
}
.io-viewport {
  pointer-events: none;
  user-select: none;
  -webkit-user-select: none;
  transform-origin: center center;
}
.io-viewport img,
.io-viewport svg {
  display: block;
  user-select: none;
  -webkit-user-select: none;
  -webkit-user-drag: none;
}
.io-footer {
  position: absolute;
  bottom: 16px;
  left: 50%;
  transform: translateX(-50%);
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 12px;
  background: rgba(0, 0, 0, 0.6);
  border-radius: 8px;
  z-index: 1;
  pointer-events: auto;
}
.io-footer button {
  font-family: var(--font-ui, sans-serif);
  font-size: 13px;
  color: rgba(255, 255, 255, 0.85);
  background: transparent;
  border: 1px solid rgba(255, 255, 255, 0.2);
  border-radius: 4px;
  padding: 2px 10px;
  cursor: pointer;
}
.io-footer button:hover {
  background: rgba(255, 255, 255, 0.15);
}
.io-zoom-pct {
  font-family: var(--font-mono, monospace);
  font-size: 12px;
  color: rgba(255, 255, 255, 0.7);
  min-width: 48px;
  text-align: center;
}
`;

function injectStyles() {
  if (styleInjected) return;
  const el = document.createElement('style');
  el.textContent = CSS;
  document.head.appendChild(el);
  styleInjected = true;
}

// ── Listener tracking ───────────────────────────────────────────────

function on(
  el: EventTarget,
  type: string,
  fn: EventListener,
  opts?: AddEventListenerOptions,
) {
  el.addEventListener(type, fn, opts);
  active!.listeners.push({ el, type, fn });
}

function removeAllListeners() {
  if (!active) return;
  for (const { el, type, fn } of active.listeners) {
    el.removeEventListener(type, fn);
  }
  active.listeners.length = 0;
}

// ── Transform helpers ───────────────────────────────────────────────

function applyTransform() {
  if (!active) return;
  active.viewport.style.transform =
    `translate(${panX}px, ${panY}px) scale(${scale})`;
}

function updateZoomDisplay() {
  if (!active) return;
  active.zoomPct.textContent = `${Math.round(scale * 100)}%`;
}

function clampScale(s: number) {
  return Math.max(MIN_SCALE, Math.min(MAX_SCALE, s));
}

// ── Zoom logic ──────────────────────────────────────────────────────

function zoomTo(newScale: number) {
  scale = clampScale(newScale);
  applyTransform();
  updateZoomDisplay();
}

function zoomAt(newScale: number, clientX: number, clientY: number) {
  const clamped = clampScale(newScale);
  // Keep the point under the cursor fixed during zoom
  const vp = active!.viewport.getBoundingClientRect();
  const cx = clientX - vp.left;
  const cy = clientY - vp.top;
  const ratio = clamped / scale;
  panX = cx - ratio * (cx - panX);
  panY = cy - ratio * (cy - panY);
  scale = clamped;
  applyTransform();
  updateZoomDisplay();
}

function fitToScreen() {
  if (!active) return;
  const rect = active.contentEl.getBoundingClientRect();
  const child = active.viewport.firstElementChild as HTMLElement | null;
  if (!child) return;

  // Get natural dimensions of the content
  let natW = 0;
  let natH = 0;

  if (child instanceof SVGElement) {
    const vb = child.getAttribute('viewBox');
    if (vb) {
      const parts = vb.split(/[\s,]+/).map(Number);
      if (parts.length === 4) {
        natW = parts[2];
        natH = parts[3];
      }
    }
    if (!natW) {
      const wAttr = child.getAttribute('width');
      const hAttr = child.getAttribute('height');
      if (wAttr && hAttr) {
        natW = parseFloat(wAttr);
        natH = parseFloat(hAttr);
      }
    }
    if (!natW) {
      const bbox = (child as unknown as SVGSVGElement).getBBox();
      natW = bbox.width;
      natH = bbox.height;
    }
    // SVG: remove fixed attributes, rely on viewBox + CSS sizing
    child.removeAttribute('width');
    child.removeAttribute('height');
  } else if (child instanceof HTMLImageElement) {
    natW = child.naturalWidth || child.width;
    natH = child.naturalHeight || child.height;
  } else {
    natW = child.offsetWidth;
    natH = child.offsetHeight;
  }

  const availW = rect.width - FIT_PADDING;
  const availH = rect.height - FIT_PADDING;

  let displayW: number;
  let displayH: number;

  if (natW <= 0 || natH <= 0) {
    displayW = availW;
    displayH = availH;
  } else {
    // Scale content to fill available space, allow up to 2x upscale
    const fitScale = Math.min(availW / natW, availH / natH);
    const finalScale = Math.min(fitScale, 2);
    displayW = natW * finalScale;
    displayH = natH * finalScale;
  }

  // Set CSS dimensions directly on the element — flexbox centers it
  child.style.width = `${displayW}px`;
  child.style.height = `${displayH}px`;

  // Reset user zoom/pan — content is already at the right size via CSS
  scale = 1;
  panX = 0;
  panY = 0;
  applyTransform();
  updateZoomDisplay();
}

// ── Close ───────────────────────────────────────────────────────────

function closeOverlay() {
  if (!active) return;
  removeAllListeners();
  active.backdrop.remove();
  if (active.triggerEl) {
    active.triggerEl.focus();
  }
  active = null;
}

// ── Open ────────────────────────────────────────────────────────────

export function openImageOverlay(opts: OverlayOptions) {
  if (active) closeOverlay();
  injectStyles();

  const { source, title, strings } = opts;

  // Determine display title
  let displayTitle = title;
  if (!displayTitle) {
    if (source instanceof HTMLImageElement) {
      displayTitle = source.alt || strings.image;
    } else {
      displayTitle = strings.diagram;
    }
  }

  // ── Build DOM ──

  const backdrop = document.createElement('div');
  backdrop.className = 'io-backdrop';
  backdrop.setAttribute('role', 'dialog');
  backdrop.setAttribute('aria-label', displayTitle);

  // Header
  const header = document.createElement('div');
  header.className = 'io-header';
  const titleEl = document.createElement('span');
  titleEl.className = 'io-header-title';
  titleEl.textContent = displayTitle;
  const closeBtn = document.createElement('button');
  closeBtn.className = 'io-close';
  closeBtn.setAttribute('aria-label', strings.close);
  closeBtn.textContent = '\u00d7'; // ×
  header.appendChild(titleEl);
  header.appendChild(closeBtn);

  // Content area
  const contentEl = document.createElement('div');
  contentEl.className = 'io-content';

  const viewport = document.createElement('div');
  viewport.className = 'io-viewport';

  // Clone source
  const clone = source.cloneNode(true) as HTMLElement;
  if (clone instanceof HTMLImageElement) {
    clone.draggable = false;
  }
  viewport.appendChild(clone);
  contentEl.appendChild(viewport);

  // Footer
  const footer = document.createElement('div');
  footer.className = 'io-footer';

  const zoomOutBtn = document.createElement('button');
  zoomOutBtn.setAttribute('aria-label', strings.zoomOut);
  zoomOutBtn.textContent = '\u2212'; // −

  const zoomPct = document.createElement('span');
  zoomPct.className = 'io-zoom-pct';
  zoomPct.textContent = '100%';

  const zoomInBtn = document.createElement('button');
  zoomInBtn.setAttribute('aria-label', strings.zoomIn);
  zoomInBtn.textContent = '+';

  const resetBtn = document.createElement('button');
  resetBtn.setAttribute('aria-label', strings.resetZoom);
  resetBtn.textContent = strings.resetZoom;

  footer.appendChild(zoomOutBtn);
  footer.appendChild(zoomPct);
  footer.appendChild(zoomInBtn);
  footer.appendChild(resetBtn);

  backdrop.appendChild(header);
  backdrop.appendChild(contentEl);
  backdrop.appendChild(footer);

  // ── State ──

  scale = 1;
  panX = 0;
  panY = 0;

  active = {
    backdrop,
    viewport,
    contentEl,
    zoomPct,
    listeners: [],
    triggerEl: document.activeElement as HTMLElement | null,
    didPan: false,
  };

  document.body.appendChild(backdrop);

  // ── Event listeners ──

  // Close button
  on(closeBtn, 'click', ((e: MouseEvent) => {
    e.stopPropagation();
    closeOverlay();
  }) as EventListener);

  // Backdrop click (close only on direct backdrop hit, ignore post-pan clicks)
  on(backdrop, 'click', ((e: MouseEvent) => {
    if (active!.didPan) {
      active!.didPan = false;
      return;
    }
    if (e.target === backdrop || e.target === contentEl) {
      closeOverlay();
    }
  }) as EventListener);

  // Zoom buttons
  on(zoomInBtn, 'click', ((e: MouseEvent) => {
    e.stopPropagation();
    zoomTo(scale + ZOOM_STEP);
  }) as EventListener);

  on(zoomOutBtn, 'click', ((e: MouseEvent) => {
    e.stopPropagation();
    zoomTo(scale - ZOOM_STEP);
  }) as EventListener);

  on(resetBtn, 'click', ((e: MouseEvent) => {
    e.stopPropagation();
    fitToScreen();
  }) as EventListener);

  // Mouse wheel zoom
  on(contentEl, 'wheel', ((e: WheelEvent) => {
    e.preventDefault();
    const delta = e.deltaY > 0 ? -ZOOM_STEP : ZOOM_STEP;
    zoomAt(scale + delta, e.clientX, e.clientY);
  }) as EventListener, { passive: false });

  // Keyboard
  on(backdrop, 'keydown', ((e: KeyboardEvent) => {
    const mod = e.metaKey || e.ctrlKey;
    if (e.key === 'Escape') {
      e.stopPropagation();
      closeOverlay();
      return;
    }
    if (mod && (e.key === '=' || e.key === '+')) {
      e.preventDefault();
      zoomTo(scale + ZOOM_STEP);
      return;
    }
    if (mod && e.key === '-') {
      e.preventDefault();
      zoomTo(scale - ZOOM_STEP);
      return;
    }
    if (mod && e.key === '0') {
      e.preventDefault();
      fitToScreen();
      return;
    }
  }) as EventListener);

  // Pointer pan + pinch-to-zoom (touch).
  // Tracks every active pointer so two simultaneous touches can drive
  // a two-finger pinch gesture in addition to single-pointer pan.
  const pointers = new Map<number, { x: number; y: number }>();
  let pinchStartDist = 0;
  let pinchStartScale = 1;

  function pinchDistance(): number {
    const pts = Array.from(pointers.values());
    if (pts.length < 2) return 0;
    const [a, b] = pts;
    const dx = a.x - b.x;
    const dy = a.y - b.y;
    return Math.hypot(dx, dy);
  }

  on(contentEl, 'pointerdown', ((e: PointerEvent) => {
    if ((e.target as HTMLElement).closest('.io-header, .io-footer')) return;
    e.preventDefault();
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    contentEl.setPointerCapture(e.pointerId);
    if (pointers.size === 2) {
      pinchStartDist = pinchDistance();
      pinchStartScale = scale;
    } else {
      contentEl.style.cursor = 'grabbing';
    }
  }) as EventListener);

  on(contentEl, 'pointermove', ((e: PointerEvent) => {
    const prev = pointers.get(e.pointerId);
    if (!prev) return;
    const curr = { x: e.clientX, y: e.clientY };
    pointers.set(e.pointerId, curr);

    if (pointers.size >= 2) {
      // Pinch zoom — anchor at the midpoint of the two active pointers.
      const dist = pinchDistance();
      if (pinchStartDist > 0 && dist > 0) {
        const pts = Array.from(pointers.values());
        const cx = (pts[0].x + pts[1].x) / 2;
        const cy = (pts[0].y + pts[1].y) / 2;
        const target = pinchStartScale * (dist / pinchStartDist);
        zoomAt(target, cx, cy);
        active!.didPan = true;
      }
      return;
    }

    // Single-finger / mouse pan
    const dx = curr.x - prev.x;
    const dy = curr.y - prev.y;
    if (Math.abs(dx) > 1 || Math.abs(dy) > 1) active!.didPan = true;
    panX += dx;
    panY += dy;
    applyTransform();
  }) as EventListener);

  function endPointer(e: PointerEvent) {
    pointers.delete(e.pointerId);
    if (pointers.size < 2) pinchStartDist = 0;
    if (pointers.size === 0) contentEl.style.cursor = 'grab';
  }
  on(contentEl, 'pointerup', ((e: PointerEvent) => endPointer(e)) as EventListener);
  on(contentEl, 'pointercancel', ((e: PointerEvent) => endPointer(e)) as EventListener);

  // Prevent native image drag
  on(viewport, 'dragstart', ((e: DragEvent) => {
    e.preventDefault();
  }) as EventListener);

  // ── Initial fit ──
  requestAnimationFrame(() => fitToScreen());
}
