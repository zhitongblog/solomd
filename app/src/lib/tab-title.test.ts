import assert from 'node:assert/strict';
import { test } from 'node:test';

import { displayTabTitle, displayTabTooltip, extractFirstLineTitle } from './tab-title.ts';

test('extractFirstLineTitle strips Markdown syntax from the first non-empty line', () => {
  assert.equal(extractFirstLineTitle('# 项目周报 2026-10\n正文内容'), '项目周报 2026-10');
  assert.equal(extractFirstLineTitle('\n\n- [ ] 待办事项第一条\n第二条'), '待办事项第一条');
  assert.equal(extractFirstLineTitle('1. **重点** ==高亮== [链接](https://solomd.app)'), '重点 高亮 链接');
});

test('extractFirstLineTitle skips YAML frontmatter and falls back to frontmatter title or fileName', () => {
  const withBody = '---\ntitle: FM Title\ntags: [a]\n---\n\n# 正文第一行\n内容';
  assert.equal(extractFirstLineTitle(withBody), '正文第一行');

  const onlyFm = '---\ntitle: "仅 Frontmatter 标题"\n---\n\n';
  assert.equal(extractFirstLineTitle(onlyFm), '仅 Frontmatter 标题');

  const danglingInboxFm = 'inbox: true\n---\n# 真正的标题\n正文';
  assert.equal(extractFirstLineTitle(danglingInboxFm), '真正的标题');
});

test('displayTabTitle and displayTabTooltip respect the setting flag', () => {
  const tab = {
    fileName: 'tmp_9f8a7b6c.md',
    filePath: 'C:\\Temp\\tmp_9f8a7b6c.md',
    content: '会议纪要：产品需求评审\n详细内容……',
  };
  assert.equal(displayTabTitle(tab, false), 'tmp_9f8a7b6c.md');
  assert.equal(displayTabTitle(tab, true), '会议纪要：产品需求评审');
  assert.equal(displayTabTooltip(tab, false), 'C:\\Temp\\tmp_9f8a7b6c.md');
  assert.equal(displayTabTooltip(tab, true), '会议纪要：产品需求评审 — C:\\Temp\\tmp_9f8a7b6c.md');

  const emptyTab = { fileName: 'Untitled.md', filePath: null, content: '   \n  ' };
  assert.equal(displayTabTitle(emptyTab, true), 'Untitled.md');
});
