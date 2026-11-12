/**
 * #363 — Built-in zero-dependency Markmap mindmap renderer (` ```markmap `).
 *
 * Parses Markdown headings (`#`, `##`, `###`, …) and nested bullet/numbered
 * lists (`- `, `* `, `1. `) into a hierarchical tree and renders an inline,
 * self-contained horizontal SVG mindmap with color-coded cubic Bézier curves.
 */

export interface MarkmapNode {
  label: string;
  children: MarkmapNode[];
}

function stripInlineMarkdown(raw: string): string {
  return raw
    .trim()
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/~~([^~]+)~~/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .trim();
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Parse Markdown headings and/or nested lists into a single root `MarkmapNode`.
 */
export function parseMarkmapTree(source: string): MarkmapNode {
  const lines = source
    .replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '')
    .split(/\r?\n/);

  interface StackEntry {
    node: MarkmapNode;
    rank: number; // Headings: 1..6; lists: 100 + indentSpaces
  }

  const virtualRoot: MarkmapNode = { label: 'Mindmap', children: [] };
  const stack: StackEntry[] = [{ node: virtualRoot, rank: 0 }];
  let lastHeadingRank = 0;

  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    if (!trimmed) continue;

    const hMatch = trimmed.match(/^(#{1,6})\s+(.+)$/);
    if (hMatch) {
      const rank = hMatch[1].length;
      const label = stripInlineMarkdown(hMatch[2]);
      if (!label) continue;
      lastHeadingRank = rank;
      const node: MarkmapNode = { label, children: [] };
      while (stack.length > 1 && stack[stack.length - 1].rank >= rank) {
        stack.pop();
      }
      stack[stack.length - 1].node.children.push(node);
      stack.push({ node, rank });
      continue;
    }

    const listMatch = rawLine.match(/^(\s*)(?:[-*+]|\d+\.)\s+(.+)$/);
    if (listMatch) {
      const indent = listMatch[1].replace(/\t/g, '  ').length;
      const label = stripInlineMarkdown(listMatch[2]);
      if (!label) continue;
      const rank = (lastHeadingRank || 1) + 10 + indent;
      const node: MarkmapNode = { label, children: [] };
      while (stack.length > 1 && stack[stack.length - 1].rank >= rank) {
        stack.pop();
      }
      stack[stack.length - 1].node.children.push(node);
      stack.push({ node, rank });
    }
  }

  if (virtualRoot.children.length === 1) {
    return virtualRoot.children[0];
  }
  if (virtualRoot.children.length === 0) {
    const firstNonEmpty = lines.map((l) => stripInlineMarkdown(l)).find(Boolean) || 'Mindmap';
    return { label: firstNonEmpty, children: [] };
  }
  return virtualRoot;
}

const BRANCH_COLORS = [
  '#3b82f6', // blue
  '#10b981', // emerald
  '#f59e0b', // amber
  '#ec4899', // pink
  '#8b5cf6', // violet
  '#06b6d4', // cyan
];

function estimateTextWidth(text: string, fontSize: number): number {
  let units = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    units += code > 0x2e7f ? 1.05 : 0.58;
  }
  return Math.max(44, Math.ceil(units * fontSize) + 24);
}

interface LayoutNode {
  label: string;
  depth: number;
  x: number;
  y: number;
  width: number;
  height: number;
  color: string;
  children: LayoutNode[];
}

/**
 * Render a Markdown mindmap source string into a standalone SVG string.
 */
export function renderMarkmapSvg(source: string): string {
  const root = parseMarkmapTree(source);
  const colWidths = new Map<number, number>();

  function buildLayout(node: MarkmapNode, depth: number, branchIdx: number): LayoutNode {
    const fontSize = depth === 0 ? 15 : depth === 1 ? 13.5 : 12.5;
    const width = estimateTextWidth(node.label, fontSize);
    const height = depth === 0 ? 34 : 28;
    colWidths.set(depth, Math.max(colWidths.get(depth) ?? 0, width));
    const color =
      depth === 0
        ? '#2563eb'
        : BRANCH_COLORS[branchIdx % BRANCH_COLORS.length];
    const children = node.children.map((child, idx) =>
      buildLayout(child, depth + 1, depth === 0 ? idx : branchIdx),
    );
    return {
      label: node.label,
      depth,
      x: 0,
      y: 0,
      width,
      height,
      color,
      children,
    };
  }

  const tree = buildLayout(root, 0, 0);

  // Compute X positions per depth column
  const colX = new Map<number, number>();
  let curX = 24;
  const maxDepth = Math.max(0, ...Array.from(colWidths.keys()));
  for (let d = 0; d <= maxDepth; d++) {
    colX.set(d, curX);
    curX += (colWidths.get(d) ?? 80) + 56;
  }

  // Assign Y positions bottom-up from leaves
  let nextLeafY = 24;
  const rowGap = 14;

  function assignCoords(n: LayoutNode): void {
    n.x = colX.get(n.depth) ?? 24;
    if (n.children.length === 0) {
      n.y = nextLeafY;
      nextLeafY += n.height + rowGap;
      return;
    }
    for (const c of n.children) {
      assignCoords(c);
    }
    const first = n.children[0];
    const last = n.children[n.children.length - 1];
    const midY = (first.y + first.height / 2 + (last.y + last.height / 2)) / 2;
    n.y = Math.round(midY - n.height / 2);
  }

  assignCoords(tree);

  // Ensure no node has y < 16
  let minY = Infinity;
  let maxX = 0;
  let maxY = 0;
  function measureBounds(n: LayoutNode) {
    minY = Math.min(minY, n.y);
    maxX = Math.max(maxX, n.x + n.width);
    maxY = Math.max(maxY, n.y + n.height);
    for (const c of n.children) measureBounds(c);
  }
  measureBounds(tree);
  if (minY < 16) {
    const shift = 16 - minY;
    const shiftAll = (n: LayoutNode) => {
      n.y += shift;
      for (const c of n.children) shiftAll(c);
    };
    shiftAll(tree);
    maxY += shift;
  }

  const totalWidth = Math.max(240, maxX + 28);
  const totalHeight = Math.max(80, maxY + 24);

  const paths: string[] = [];
  const nodes: string[] = [];

  function emitSvg(n: LayoutNode) {
    const x1 = n.x + n.width;
    const y1 = Math.round(n.y + n.height / 2);
    for (const c of n.children) {
      const x2 = c.x;
      const y2 = Math.round(c.y + c.height / 2);
      const cx = Math.round((x1 + x2) / 2);
      paths.push(
        `<path d="M ${x1} ${y1} C ${cx} ${y1}, ${cx} ${y2}, ${x2} ${y2}" fill="none" stroke="${c.color}" stroke-width="2" stroke-linecap="round" opacity="0.85" />`,
      );
      emitSvg(c);
    }

    const fontSize = n.depth === 0 ? 14 : n.depth === 1 ? 13 : 12;
    const fontWeight = n.depth <= 1 ? '600' : '500';
    const rx = n.depth === 0 ? 8 : 6;
    const fillOpacity = n.depth === 0 ? '0.16' : '0.10';
    const textX = Math.round(n.x + n.width / 2);
    const textY = Math.round(n.y + n.height / 2 + fontSize * 0.35);

    nodes.push(
      `<g class="solomd-markmap__node" transform="translate(0,0)">` +
        `<rect x="${n.x}" y="${n.y}" width="${n.width}" height="${n.height}" rx="${rx}" fill="${n.color}" fill-opacity="${fillOpacity}" stroke="${n.color}" stroke-width="1.5" />` +
        `<text x="${textX}" y="${textY}" text-anchor="middle" font-size="${fontSize}" font-weight="${fontWeight}" fill="currentColor" style="font-family: var(--content-font-family, system-ui, sans-serif);">${escapeXml(n.label)}</text>` +
      `</g>`,
    );
  }

  emitSvg(tree);

  return (
    `<svg class="solomd-markmap" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${totalWidth} ${totalHeight}" width="${totalWidth}" height="${totalHeight}" style="max-width: 100%; height: auto; display: block; color: var(--text, #1f2937);">` +
    paths.join('') +
    nodes.join('') +
    `</svg>`
  );
}
