/**
 * Mermaid, loaded the first time a diagram actually needs rendering.
 *
 * It used to be a static import in five modules, which put its ~1 MB of
 * parser and renderer into the entry chunk — paid on every cold start, by
 * every user, including the ones whose notes contain no diagrams at all.
 * Windows felt it worst: WebView2 has to compile the whole entry chunk
 * before the first paint.
 *
 * `initialize` is still last-call-wins on a single shared instance, exactly
 * as it was when each module reached for the singleton directly.
 *
 * Rendering always goes through `safeRender` below. Left to itself, mermaid
 * draws its "Syntax error in text" bomb into a `<div id="d<id>">` appended to
 * `document.body` and, on a parse error, throws *before* removing it. That
 * stray node sat under the app shell for good: the next scroll-into-view
 * scrolled `<body>` and pushed the tab bar and toolbar off-screen until a
 * restart. Every caller already shows its own inline error, so mermaid is
 * told never to render one (`suppressErrorRendering`), it draws into a
 * throw-away off-screen host we own, and whatever it leaves behind is
 * removed whether the render succeeded or not.
 */
import type mermaidNS from 'mermaid';

type Mermaid = typeof mermaidNS;
type MermaidConfig = Parameters<Mermaid['initialize']>[0];
type RenderResult = Awaited<ReturnType<Mermaid['render']>>;

/** The only part of mermaid our callers use, made safe to fail. */
export interface SafeMermaid {
  render(id: string, code: string): Promise<RenderResult>;
}

/** The subset of mermaid that `safeRender` drives (lets tests pass a fake). */
export interface MermaidRenderer {
  render(id: string, code: string, container?: Element): Promise<RenderResult>;
}

let loading: Promise<Mermaid> | null = null;
let renderSeq = 0;

export function loadMermaid(): Promise<Mermaid> {
  if (!loading) loading = import('mermaid').then((m) => m.default);
  return loading;
}

/** Remove every temporary node mermaid may have created for `id`. */
export function removeMermaidLeftovers(id: string, doc: Document = document): void {
  for (const tmp of [`d${id}`, `i${id}`]) {
    doc.getElementById(tmp)?.remove();
  }
  // A bare `<svg id="<id>">` directly under <body> is a leftover too.
  // Rendered output lives in our own wrappers (`.mermaid-block` etc.).
  const svg = doc.getElementById(id);
  if (svg && svg.parentElement === doc.body) svg.remove();
}

/**
 * Render into a host that is in the document (mermaid measures text with
 * getBBox, which needs layout) but out of flow and invisible, then drop it.
 */
export async function safeRender(
  mermaid: MermaidRenderer,
  id: string,
  code: string,
  doc: Document = document,
): Promise<RenderResult> {
  // Callers number their ids per component, so two split panes previewing
  // the same note both asked for `mmd-1` at once: the first render's cleanup
  // then removed the second one's work-in-progress `#dmmd-1` and it failed
  // with "element.firstChild is null". A page-wide suffix keeps every render
  // (and the `#id` selectors inside its SVG) distinct.
  const renderId = `${id}-r${++renderSeq}`;
  const host = doc.createElement('div');
  host.setAttribute('aria-hidden', 'true');
  host.setAttribute('data-mermaid-scratch', '1');
  const width = Math.max(320, doc.body?.clientWidth || 1000);
  host.setAttribute(
    'style',
    `position:fixed;left:-100000px;top:0;width:${width}px;` +
      'visibility:hidden;pointer-events:none;overflow:hidden;',
  );
  doc.body.appendChild(host);
  try {
    return await mermaid.render(renderId, code, host);
  } finally {
    host.remove();
    removeMermaidLeftovers(renderId, doc);
  }
}

/** Load (once) and configure. Callers are all async already. */
export async function initMermaid(config: MermaidConfig): Promise<SafeMermaid> {
  const mermaid = await loadMermaid();
  mermaid.initialize({ ...config, suppressErrorRendering: true });
  return { render: (id, code) => safeRender(mermaid, id, code) };
}
