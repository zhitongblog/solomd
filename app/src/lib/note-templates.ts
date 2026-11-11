/**
 * #322 — Built-in note templates and `{{variable}}` expansion for
 * "New Note from Template…".
 */

export interface NoteTemplateItem {
  id: string;
  nameZh: string;
  nameEn: string;
  descZh: string;
  descEn: string;
  contentZh: string;
  contentEn: string;
  customPath?: string;
}

export const BUILTIN_NOTE_TEMPLATES: NoteTemplateItem[] = [
  {
    id: 'builtin:meeting',
    nameZh: '会议纪要',
    nameEn: 'Meeting Notes',
    descZh: '包含参会人、议题、讨论记录与待办事项',
    descEn: 'Attendees, agenda, discussion notes, and action items',
    contentZh: `# {{title}}

- **日期**：{{date}} {{time}}
- **参会人**：

## 议题

1. 

## 讨论记录

- 

## 待办事项

- [ ] 
`,
    contentEn: `# {{title}}

- **Date**: {{date}} {{time}}
- **Attendees**:

## Agenda

1. 

## Discussion Notes

- 

## Action Items

- [ ] 
`,
  },
  {
    id: 'builtin:daily',
    nameZh: '每日日志',
    nameEn: 'Daily Journal',
    descZh: '今日计划、记录与每日复盘',
    descEn: 'Daily plan, log, and reflection',
    contentZh: `# {{date}} {{title}}

## 今日计划

- [ ] 

## 今日记录

- 

## 今日复盘

- 
`,
    contentEn: `# {{date}} {{title}}

## Today's Plan

- [ ] 

## Notes

- 

## Reflection

- 
`,
  },
  {
    id: 'builtin:spec',
    nameZh: '项目方案 / 技术设计',
    nameEn: 'Project Spec',
    descZh: '背景目标、核心方案与里程碑表格',
    descEn: 'Background, solution design, and milestones table',
    contentZh: `# {{title}}

> 创建时间：{{datetime}}

## 背景与目标

## 核心方案

## 里程碑与排期

| 阶段 | 内容 | 状态 |
| --- | --- | --- |
| P1 | 方案设计 | 进行中 |
`,
    contentEn: `# {{title}}

> Created: {{datetime}}

## Background & Goals

## Proposed Solution

## Milestones

| Phase | Deliverable | Status |
| --- | --- | --- |
| P1 | Design | In Progress |
`,
  },
  {
    id: 'builtin:reading',
    nameZh: '读书与文献笔记',
    nameEn: 'Reading Notes',
    descZh: '核心观点、精彩摘录与个人思考',
    descEn: 'Key takeaways, quotes, and personal thoughts',
    contentZh: `# 《{{title}}》读书笔记

- **日期**：{{date}}
- **作者/来源**：

## 核心观点

- 

## 精彩摘录

> 

## 个人思考

`,
    contentEn: `# Reading Notes: {{title}}

- **Date**: {{date}}
- **Author / Source**:

## Key Takeaways

- 

## Quotes

> 

## Reflections

`,
  },
];

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/**
 * Expand `{{date}}`, `{{time}}`, `{{datetime}}`, `{{year}}`, `{{month}}`,
 * `{{day}}`, and `{{title}}` placeholders inside a template string.
 */
export function expandNoteTemplate(
  raw: string,
  opts: { title?: string; fallbackTitle?: string; now?: Date } = {},
): string {
  const d = opts.now ?? new Date();
  const year = String(d.getFullYear());
  const month = pad2(d.getMonth() + 1);
  const day = pad2(d.getDate());
  const date = `${year}-${month}-${day}`;
  const time = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  const datetime = `${date} ${time}`;
  const title = (opts.title ?? '').trim() || opts.fallbackTitle || date;

  return raw
    .replace(/\{\{\s*date\s*\}\}/gi, date)
    .replace(/\{\{\s*time\s*\}\}/gi, time)
    .replace(/\{\{\s*datetime\s*\}\}/gi, datetime)
    .replace(/\{\{\s*year\s*\}\}/gi, year)
    .replace(/\{\{\s*month\s*\}\}/gi, month)
    .replace(/\{\{\s*day\s*\}\}/gi, day)
    .replace(/\{\{\s*title\s*\}\}/gi, title);
}
