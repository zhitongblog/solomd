import MarkdownIt from 'markdown-it';
import anchor from 'markdown-it-anchor';
// @ts-ignore — types are loose
import katex from '@vscode/markdown-it-katex';

const katexPlugin: any = (katex as any).default ?? katex;

export const md = new MarkdownIt({
  html: false,
  linkify: true,
  typographer: true,
  breaks: false,
})
  .use(anchor, { permalink: false, slugify: (s: string) => slugify(s) })
  .use(katexPlugin, { throwOnError: false });

function slugify(s: string): string {
  return s
    .toLowerCase()
    .trim()
    .replace(/[\s\u3000]+/g, '-')
    .replace(/[^\w\-\u4e00-\u9fff]/g, '');
}

export function renderMarkdown(source: string): string {
  return md.render(source || '');
}

export interface OutlineItem {
  level: number;
  text: string;
  slug: string;
  line: number;
}

export function extractOutline(source: string): OutlineItem[] {
  const lines = source.split('\n');
  const items: OutlineItem[] = [];
  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^```/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const m = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (m) {
      const level = m[1].length;
      const text = m[2];
      items.push({ level, text, slug: slugify(text), line: i + 1 });
    }
  }
  return items;
}
