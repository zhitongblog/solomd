/**
 * Convert markdown source to a DOCX Blob using the `docx` library.
 * Walks markdown-it tokens and emits Word paragraphs / runs.
 *
 * Supports: headings (h1-h6), paragraphs, bold, italic, inline code, links,
 * fenced code blocks, ordered/bullet lists, blockquotes, horizontal rules.
 */

import {
  Document,
  Packer,
  Paragraph,
  TextRun,
  HeadingLevel,
  AlignmentType,
  ExternalHyperlink,
  ShadingType,
  BorderStyle,
} from 'docx';
import { md } from './markdown';
import type Token from 'markdown-it/lib/token.mjs';

interface RunStyle {
  bold?: boolean;
  italic?: boolean;
  strike?: boolean;
  code?: boolean;
  link?: string;
}

const HEADING_LEVELS: Record<string, (typeof HeadingLevel)[keyof typeof HeadingLevel]> = {
  h1: HeadingLevel.HEADING_1,
  h2: HeadingLevel.HEADING_2,
  h3: HeadingLevel.HEADING_3,
  h4: HeadingLevel.HEADING_4,
  h5: HeadingLevel.HEADING_5,
  h6: HeadingLevel.HEADING_6,
};

function buildRuns(inlineToken: Token, style: RunStyle = {}): (TextRun | ExternalHyperlink)[] {
  const out: (TextRun | ExternalHyperlink)[] = [];
  if (!inlineToken.children) {
    if (inlineToken.content) {
      out.push(new TextRun({ text: inlineToken.content, ...toRunOpts(style) }));
    }
    return out;
  }

  const stack: RunStyle[] = [{ ...style }];
  let pendingLink: { href: string; runs: (TextRun | ExternalHyperlink)[] } | null = null;

  const push = (run: TextRun) => {
    if (pendingLink) {
      pendingLink.runs.push(run);
    } else {
      out.push(run);
    }
  };

  for (const tok of inlineToken.children) {
    const cur = { ...stack[stack.length - 1] };
    switch (tok.type) {
      case 'text':
        if (tok.content) push(new TextRun({ text: tok.content, ...toRunOpts(cur) }));
        break;
      case 'softbreak':
        push(new TextRun({ text: ' ', ...toRunOpts(cur) }));
        break;
      case 'hardbreak':
        push(new TextRun({ text: '', break: 1, ...toRunOpts(cur) }));
        break;
      case 'strong_open':
        stack.push({ ...cur, bold: true });
        break;
      case 'strong_close':
        stack.pop();
        break;
      case 'em_open':
        stack.push({ ...cur, italic: true });
        break;
      case 'em_close':
        stack.pop();
        break;
      case 's_open':
        stack.push({ ...cur, strike: true });
        break;
      case 's_close':
        stack.pop();
        break;
      case 'code_inline':
        push(new TextRun({ text: tok.content, ...toRunOpts({ ...cur, code: true }) }));
        break;
      case 'link_open': {
        const href = tok.attrGet('href') ?? '';
        pendingLink = { href, runs: [] };
        break;
      }
      case 'link_close':
        if (pendingLink) {
          out.push(
            new ExternalHyperlink({
              link: pendingLink.href,
              children: pendingLink.runs as TextRun[],
            })
          );
          pendingLink = null;
        }
        break;
      case 'image': {
        const alt = tok.content || '[image]';
        push(new TextRun({ text: `[${alt}]`, italics: true, color: '888888' }));
        break;
      }
      default:
        // Unknown inline → fall back to its raw content
        if (tok.content) push(new TextRun({ text: tok.content, ...toRunOpts(cur) }));
    }
  }
  return out;
}

function toRunOpts(s: RunStyle) {
  const opts: any = {};
  if (s.bold) opts.bold = true;
  if (s.italic) opts.italics = true;
  if (s.strike) opts.strike = true;
  if (s.code) {
    opts.font = 'JetBrains Mono';
    opts.color = 'C0392B';
  }
  return opts;
}

function buildBody(tokens: Token[]): Paragraph[] {
  const paras: Paragraph[] = [];
  let i = 0;
  // List nesting state: depth + counters per level
  const listStack: { type: 'bullet' | 'ordered'; index: number }[] = [];

  while (i < tokens.length) {
    const tok = tokens[i];
    switch (tok.type) {
      case 'heading_open': {
        const level = tok.tag; // h1..h6
        const inline = tokens[i + 1];
        i += 3;
        paras.push(
          new Paragraph({
            heading: HEADING_LEVELS[level],
            children: buildRuns(inline),
          })
        );
        break;
      }
      case 'paragraph_open': {
        const inline = tokens[i + 1];
        i += 3;
        const isInList = listStack.length > 0;
        paras.push(
          new Paragraph({
            children: buildRuns(inline),
            ...(isInList && {
              numbering:
                listStack[listStack.length - 1].type === 'ordered'
                  ? { reference: 'ordered-list', level: Math.min(listStack.length - 1, 8) }
                  : undefined,
              bullet: listStack[listStack.length - 1].type === 'bullet'
                ? { level: Math.min(listStack.length - 1, 8) }
                : undefined,
              spacing: { before: 60, after: 60 },
            }),
          })
        );
        break;
      }
      case 'fence':
      case 'code_block': {
        const lines = (tok.content || '').replace(/\n$/, '').split('\n');
        for (const line of lines) {
          paras.push(
            new Paragraph({
              children: [
                new TextRun({
                  text: line || ' ',
                  font: 'JetBrains Mono',
                  size: 20,
                }),
              ],
              shading: { type: ShadingType.SOLID, color: 'F3EFE7', fill: 'F3EFE7' },
              spacing: { before: 0, after: 0 },
              border: {
                left: { style: BorderStyle.SINGLE, size: 12, color: 'FF9F40' },
              },
            })
          );
        }
        i += 1;
        break;
      }
      case 'hr':
        paras.push(
          new Paragraph({
            text: '',
            border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: 'CCCCCC' } },
          })
        );
        i += 1;
        break;
      case 'blockquote_open': {
        // Find matching close, recursively render inside
        let depth = 1;
        let j = i + 1;
        while (j < tokens.length && depth > 0) {
          if (tokens[j].type === 'blockquote_open') depth++;
          else if (tokens[j].type === 'blockquote_close') depth--;
          if (depth > 0) j++;
        }
        const inner = tokens.slice(i + 1, j);
        const innerParas = buildBody(inner);
        for (const p of innerParas) {
          paras.push(
            new Paragraph({
              children: (p as any).options?.children ?? [],
              alignment: AlignmentType.LEFT,
              indent: { left: 360 },
              border: {
                left: { style: BorderStyle.SINGLE, size: 12, color: 'FF9F40' },
              },
            })
          );
        }
        i = j + 1;
        break;
      }
      case 'bullet_list_open':
        listStack.push({ type: 'bullet', index: 0 });
        i += 1;
        break;
      case 'ordered_list_open':
        listStack.push({ type: 'ordered', index: 0 });
        i += 1;
        break;
      case 'bullet_list_close':
      case 'ordered_list_close':
        listStack.pop();
        i += 1;
        break;
      case 'list_item_open':
      case 'list_item_close':
        i += 1;
        break;
      default:
        i += 1;
    }
  }
  return paras;
}

export async function markdownToDocxBlob(source: string, _title = 'Document'): Promise<Blob> {
  const tokens = md.parse(source || '', {});
  const paragraphs = buildBody(tokens);
  if (paragraphs.length === 0) paragraphs.push(new Paragraph({ text: '' }));

  const doc = new Document({
    creator: 'SoloMD',
    title: _title,
    description: 'Exported from SoloMD',
    numbering: {
      config: [
        {
          reference: 'ordered-list',
          levels: [
            { level: 0, format: 'decimal', text: '%1.', alignment: AlignmentType.START },
            { level: 1, format: 'lowerLetter', text: '%2.', alignment: AlignmentType.START },
            { level: 2, format: 'lowerRoman', text: '%3.', alignment: AlignmentType.START },
          ],
        },
      ],
    },
    sections: [
      {
        properties: {},
        children: paragraphs,
      },
    ],
  });

  return Packer.toBlob(doc);
}
