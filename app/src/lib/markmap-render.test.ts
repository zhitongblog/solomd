import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseMarkmapTree, renderMarkmapSvg } from './markmap-render.ts';

test('#363: parseMarkmapTree parses Markdown headings and nested bullet lists into a tree', () => {
  const md = [
    '# SoloMD 路线图',
    '## 核心编辑器',
    '- 实时渲染',
    '  - 表格内联编辑',
    '  - Mermaid 折叠',
    '## 跨端同步',
    '- WebDAV 端到端加密',
    '- Git 自动快照',
  ].join('\n');

  const tree = parseMarkmapTree(md);
  assert.equal(tree.label, 'SoloMD 路线图');
  assert.equal(tree.children.length, 2);
  assert.equal(tree.children[0].label, '核心编辑器');
  assert.equal(tree.children[0].children[0].label, '实时渲染');
  assert.equal(tree.children[0].children[0].children.length, 2);
  assert.equal(tree.children[1].label, '跨端同步');
});

test('#363: renderMarkmapSvg produces valid SVG with Bézier paths and node labels', () => {
  const svg = renderMarkmapSvg('# 中心主题\n- 分支 A\n- 分支 B');
  assert.ok(svg.startsWith('<svg class="solomd-markmap"'));
  assert.ok(svg.includes('<path d="M '));
  assert.ok(svg.includes('中心主题'));
  assert.ok(svg.includes('分支 A'));
  assert.ok(svg.includes('分支 B'));
});
