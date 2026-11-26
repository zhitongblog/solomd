import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { unzipSync, strFromU8 } from 'fflate';
import { markdownToDocxBlob } from './docx-export.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const srcDir = path.resolve(__dirname, '..');

test('#715: DOCX export converts Markdown tables, indented pipe tables, and HTML <table> blocks to Word tables', async () => {
  const mdTable = [
    '| 婚姻现状 | 未婚□ | 口 | 离异□ 丧偶□ |',
    '| --- | --- | --- | --- |',
    '| 婚姻变化情况 | 无变化□ | | |',
    '| 有变化 | 以往变化情形及时间 | | |',
    '| | | | |',
  ].join('\n');

  const htmlTable =
    '<table><thead><tr><th>婚姻现状</th><th colspan="2">未婚□</th></tr></thead>' +
    '<tbody><tr><td>婚姻变化情况</td><td>无变化□</td><td></td></tr></tbody></table>';

  for (const [label, src] of [
    ['markdown table', mdTable],
    ['html table', htmlTable],
  ] as const) {
    const blob = await markdownToDocxBlob(src, 'TableTest');
    const files = unzipSync(new Uint8Array(await blob.arrayBuffer()));
    const xml = strFromU8(files['word/document.xml']);
    assert.ok(xml.includes('<w:tbl>'), `${label} must produce <w:tbl>`);
    assert.ok(xml.includes('婚姻现状'), `${label} must preserve cell text`);
  }
});

test('#716 & #719: Live Edit, Preview, and Plain Editor HTML <img> (incl. data-source-line wrapper) and multi-line KaTeX honor --media-align / --media-margin', () => {
  const liveBlocks = fs.readFileSync(path.join(srcDir, 'lib/cm-live-blocks.ts'), 'utf8');
  assert.match(
    liveBlocks,
    /'\.cm-live-block--html > img, \.cm-live-block--html > div\[data-source-line\] > img,[\s\S]*?marginLeft:\s*'var\(--media-margin-left, 0\)'/,
  );
  assert.match(
    liveBlocks,
    /'\.cm-live-block--math \.katex-display, \.cm-live-block--math \.katex-display > \.katex':\s*\{\s*textAlign:\s*'var\(--media-align, left\)'/,
  );

  const previewVue = fs.readFileSync(path.join(srcDir, 'components/Preview.vue'), 'utf8');
  assert.match(
    previewVue,
    /:where\(\.preview-content\) > img,\s*:where\(\.preview-content\) > div\[data-source-line\] > img[\s\S]*?margin-left:\s*var\(--media-margin-left, 0\)/,
  );

  const editorVue = fs.readFileSync(path.join(srcDir, 'components/Editor.vue'), 'utf8');
  assert.match(
    editorVue,
    /\.plain-block__render :deep\(> div\[data-source-line\] > img\)[\s\S]*?margin-left:\s*var\(--media-margin-left, 0\)/,
  );
});

test('#717: Settings media alignment buttons sit inline flush-right via .settings__field--seg without input chrome', () => {
  const settingsPanel = fs.readFileSync(path.join(srcDir, 'components/SettingsPanel.vue'), 'utf8');
  assert.match(
    settingsPanel,
    /Images, Diagrams & Math Alignment[\s\S]{0,200}<div class="settings__field settings__field--seg"[^>]*justify-content:flex-end/,
  );
  assert.match(
    settingsPanel,
    /\.settings__field--seg\s*\{[\s\S]*?background:\s*transparent;/,
  );
});

test('#720: FileTree reloads synced order.json/sort.json on remote pull and persists sort.json alongside order.json', () => {
  const fileTree = fs.readFileSync(path.join(srcDir, 'components/FileTree.vue'), 'utf8');
  assert.match(
    fileTree,
    /function onRemotePulled\(\)[\s\S]{0,260}loadManualOrder\(\)\.then/,
  );
  assert.match(
    fileTree,
    /async function saveManualOrder\(\)[\s\S]{0,600}sortMetaPath\(\)/,
  );
});

test('#721: StatsPill listens to solomd://sync-progress and displays single-line sync message', () => {
  const statsPill = fs.readFileSync(path.join(srcDir, 'components/StatsPill.vue'), 'utf8');
  assert.ok(statsPill.includes("'solomd://sync-progress'"));
  assert.ok(!statsPill.includes("'solomd:sync-progress'"));
  assert.ok(statsPill.includes('stats-pill__sync-text'));
});

test('#722: Image overlay clears inherited constraints and prevents shrinking below document width', () => {
  const overlay = fs.readFileSync(path.join(srcDir, 'lib/image-overlay.ts'), 'utf8');
  assert.ok(overlay.includes("clone.style.maxWidth = 'none'"));
  assert.ok(overlay.includes('active.sourceWidth'));
});

test('#723: Help > Welcome Tour is a 4-item submenu without Shortcuts.md', () => {
  const appMenu = fs.readFileSync(path.join(srcDir, 'lib/app-menu.ts'), 'utf8');
  assert.match(appMenu, /type:\s*'submenu',\s*\n\s*id:\s*'help\.welcomeTour'/);
  assert.ok(appMenu.includes("item('help.tourWelcome'"));
  assert.ok(appMenu.includes("item('help.tourSyntax'"));
  assert.ok(appMenu.includes("item('help.tourLiveEdit'"));
  assert.ok(appMenu.includes("item('help.tourSlideshow'"));

  const welcomeTour = fs.readFileSync(path.join(srcDir, 'lib/welcome-tour.ts'), 'utf8');
  assert.ok(!welcomeTour.includes('快捷键.md'));
  assert.ok(!welcomeTour.includes('Shortcuts.md'));
  assert.ok(welcomeTour.includes('export function openWelcomeTourDoc'));
});
