import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { unzipSync, strFromU8 } from 'fflate';
import { exportMediaAlignCss } from './html-export.ts';
import { SOLOMD_EPUB_CSS } from './epub-style.ts';
import { markdownToDocxBlob } from './docx-export.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const srcRoot = path.resolve(__dirname, '..');

test('#734: exportMediaAlignCss aligns data-source-line and br+img continuation HTML/MD images in PDF/HTML/EPUB/Preview and DOCX', async () => {
  const rightCss = exportMediaAlignCss('right');
  assert.match(rightCss, /--media-align:\s*right;/);
  assert.match(rightCss, /--media-margin-left:\s*auto;/);
  assert.match(rightCss, /--media-margin-right:\s*0;/);
  assert.match(rightCss, /div\[data-source-line\] > img/);
  assert.match(rightCss, /li > img:only-child/);
  assert.match(rightCss, /p > br \+ img/);
  assert.match(rightCss, /li > br \+ img/);

  const previewVue = fs.readFileSync(path.join(srcRoot, 'components/Preview.vue'), 'utf8');
  assert.match(previewVue, /:where\(\.preview-content\) p > br \+ img/);

  // Repro from issue #734 attachment: list item caption immediately followed by image on next line
  const repro = [
    '- 这是网络图片',
    '![Markdown Logo](https://example.com/a.png "Markdown Logo")  ',
    '',
    '- 这是本地图片',
    '![|25%](_assets/local.png)',
    '',
    '- HTML表达的图片：',
    '<img src="https://example.com/b.png" alt="Logo" style="width: 100px; height: 100px;" />',
  ].join('\n');

  const leftBlob = await markdownToDocxBlob(repro, 'ReproLeft', undefined, undefined, undefined, undefined, undefined, false, false, 'left');
  const leftXml = strFromU8(unzipSync(new Uint8Array(await leftBlob.arrayBuffer()))['word/document.xml']);
  assert.equal((leftXml.match(/<w:jc w:val="center"\/>/g) || []).length, 0, 'left alignment should have no centered image paragraphs');
  assert.equal((leftXml.match(/<w:jc w:val="right"\/>/g) || []).length, 0, 'left alignment should have no right-aligned image paragraphs');

  const centerBlob = await markdownToDocxBlob(repro, 'ReproCenter', undefined, undefined, undefined, undefined, undefined, false, false, 'center');
  const centerXml = strFromU8(unzipSync(new Uint8Array(await centerBlob.arrayBuffer()))['word/document.xml']);
  const centerCount = (centerXml.match(/<w:jc w:val="center"\/>/g) || []).length;
  assert.ok(centerCount >= 3, `expected all 3 continuation images to be centered in DOCX, got ${centerCount}`);

  const rightBlob = await markdownToDocxBlob(repro, 'ReproRight', undefined, undefined, undefined, undefined, undefined, false, false, 'right');
  const rightXml = strFromU8(unzipSync(new Uint8Array(await rightBlob.arrayBuffer()))['word/document.xml']);
  const rightCount = (rightXml.match(/<w:jc w:val="right"\/>/g) || []).length;
  assert.ok(rightCount >= 3, `expected all 3 continuation images to be right-aligned in DOCX, got ${rightCount}`);
});

test('#727: SOLOMD_EPUB_CSS suppresses task-list bullets inside blockquotes and aligns task-list indent with ul/ol', () => {
  assert.match(SOLOMD_EPUB_CSS, /blockquote ul\.task-list > li/);
  assert.match(SOLOMD_EPUB_CSS, /li:has\(> input\[type="checkbox"\]\)/);
  assert.match(SOLOMD_EPUB_CSS, /ul\.task-list,\s*ul\.contains-task-list\s*\{[\s\S]*?padding-left:\s*1\.8em;/);
  assert.match(SOLOMD_EPUB_CSS, /margin-left:\s*-1\.35em;/);
});

test('#732: Pure WYSIWYG skips drag-end decoration rebuilds across live-blocks, live-render, and live-preview', () => {
  const blocks = fs.readFileSync(path.join(srcRoot, 'lib/cm-live-blocks.ts'), 'utf8');
  const render = fs.readFileSync(path.join(srcRoot, 'lib/cm-live-render.ts'), 'utf8');
  const preview = fs.readFileSync(path.join(srcRoot, 'lib/cm-live-preview.ts'), 'utf8');
  assert.match(blocks, /if \(isDragEndTransaction\(tr\)\) \{\s*if \(opts\.keepSource\?\.\(\) === true \|\| opts\.pureWysiwyg\?\.\(\) === true\)/);
  assert.match(render, /!hideActiveLineMarkers && !showMarkers && u\.transactions\.some\(isDragEndTransaction\)/);
  assert.match(preview, /!hideActiveLineMarkers && !showMarkers && update\.transactions\.some\(isDragEndTransaction\)/);
});

test('#730: Preview ul/ol honors --paragraph-spacing and tightens li > p margins', () => {
  const previewVue = fs.readFileSync(path.join(srcRoot, 'components/Preview.vue'), 'utf8');
  assert.match(previewVue, /:where\(\.preview-content\) ul,\s*:where\(\.preview-content\) ol\s*\{[\s\S]*?margin:\s*var\(--paragraph-spacing,\s*0\.9em\) 0;/);
  assert.match(previewVue, /:where\(\.preview-content\) li > p\s*\{\s*margin:\s*0\.25em 0;\s*\}/);
});

test('#724: .textpack extracts to OS temp dir, permanently cleans up on tab close, repacks natively in Rust, and never falls back to -copy.md', () => {
  const useFiles = fs.readFileSync(path.join(srcRoot, 'composables/useFiles.ts'), 'utf8');
  assert.match(useFiles, /invoke<string>\('get_temp_dir'\)/);
  assert.match(useFiles, /invoke\('repack_textpack'/);
  assert.match(useFiles, /invoke\('cleanup_temp_dir'/);
  assert.match(useFiles, /if \(tab\.textpackPath\) \{[\s\S]*?return false;/);
  assert.match(useFiles, /const workDirToClean = tab\.textpackWorkDir;/);
  const runnerRs = fs.readFileSync(path.resolve(srcRoot, '../src-tauri/src/runner.rs'), 'utf8');
  assert.match(runnerRs, /commands::get_temp_dir/);
  assert.match(runnerRs, /commands::cleanup_temp_dir/);
  assert.match(runnerRs, /commands::repack_textpack/);
  const libRs = fs.readFileSync(path.resolve(srcRoot, '../src-tauri/src/lib.rs'), 'utf8');
  assert.match(libRs, /commands::cleanup_temp_dir/);
});

test('#725 & #726: SnippetsPanel dispatches activePaneId, uses default PanelHeader slot, has toolbar New button, and isolates right-click menu', () => {
  const panel = fs.readFileSync(path.join(srcRoot, 'components/SnippetsPanel.vue'), 'utf8');
  assert.match(panel, /paneId:\s*tiles\.focusedPaneId/);
  assert.doesNotMatch(panel, /<template #actions>/);
  assert.match(panel, /snippets-panel__new-btn/);
  assert.match(panel, /@contextmenu\.prevent\.stop="openCtx\(\$event, item\)"/);
  assert.match(panel, /@contextmenu\.prevent\.stop="openBlankCtx\(\$event\)"/);
});

test('#728 & #729: Push conflict guard opens blocking confirm dialog across all 3 channels and pull conflicts auto-open SyncConflictModal', () => {
  const ghSync = fs.readFileSync(path.join(srcRoot, 'composables/useGithubSync.ts'), 'utf8');
  const wdSettings = fs.readFileSync(path.join(srcRoot, 'components/WebdavSyncSettings.vue'), 'utf8');
  assert.match(ghSync, /handlePushConflictError/);
  assert.match(ghSync, /tauriConfirm\(promptMsg/);
  assert.match(ghSync, /openConflictModalIfDetected/);
  assert.match(wdSettings, /confirmDialog\(promptMsg/);
  assert.match(wdSettings, /solomd:open-sync-conflicts/);
  // All 3 push handlers use confirmPushConflict, and none of the pull catch blocks call pull recursively.
  assert.match(wdSettings, /async function pushCloudApi[\s\S]*?confirmPushConflict\(msg\)/);
  assert.match(wdSettings, /async function pushWorkspace[\s\S]*?confirmPushConflict\(msg\)/);
  assert.match(wdSettings, /async function pushCloudVault[\s\S]*?confirmPushConflict\(msg\)/);
  const pullCloudApiBody = wdSettings.match(/async function pullCloudApi\(\)[\s\S]*?\n\}/)?.[0] ?? '';
  const pullWorkspaceBody = wdSettings.match(/async function pullWorkspace\(\)[\s\S]*?\n\}/)?.[0] ?? '';
  const pullCloudVaultBody = wdSettings.match(/async function pullCloudVault\(\)[\s\S]*?\n\}/)?.[0] ?? '';
  assert.doesNotMatch(pullCloudApiBody, /confirmPushConflict|apiPushing\.value\s*=\s*false/);
  assert.doesNotMatch(pullWorkspaceBody, /confirmPushConflict|pushing\.value\s*=\s*false/);
  assert.match(pullCloudVaultBody, /solomd:open-sync-conflicts/);
});

test('#735 & desktop parity: every non-mobile Tauri command in lib.rs is also registered in runner.rs', () => {
  const extractCommands = (filePath: string): Set<string> => {
    const src = fs.readFileSync(filePath, 'utf8');
    const startToken = 'tauri::generate_handler![';
    const startIdx = src.indexOf(startToken);
    assert.ok(startIdx >= 0, `missing ${startToken} in ${filePath}`);
    let depth = 1;
    let i = startIdx + startToken.length;
    for (; i < src.length && depth > 0; i++) {
      if (src[i] === '[') depth += 1;
      else if (src[i] === ']') depth -= 1;
    }
    assert.equal(depth, 0, `unbalanced brackets in ${filePath}`);
    const body = src
      .slice(startIdx + startToken.length, i - 1)
      .replace(/\/\/[^\n]*/g, '')
      .replace(/#\[[^\]]*\]/g, '');
    const cmds = body
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    return new Set(cmds);
  };

  const libCmds = extractCommands(path.resolve(srcRoot, '../src-tauri/src/lib.rs'));
  const runnerCmds = extractCommands(path.resolve(srcRoot, '../src-tauri/src/runner.rs'));

  // Explicit mobile-only modules (Android SAF / storage) are intentionally excluded from desktop runner.rs.
  const mobileOnlyPrefix = /^(?:saf_android::|storage_android::)/;
  const missingInDesktop = [...libCmds]
    .filter((cmd) => !mobileOnlyPrefix.test(cmd) && !runnerCmds.has(cmd))
    .sort();

  assert.deepEqual(
    missingInDesktop,
    [],
    `commands registered in lib.rs but missing from desktop runner.rs: ${missingInDesktop.join(', ')}`,
  );
  assert.ok(runnerCmds.has('commands::read_binary_file_raw'));
  assert.ok(runnerCmds.has('commands::write_binary_file_chunk_raw'));
  assert.ok(runnerCmds.has('commands::extract_textpack'));

  const useFiles = fs.readFileSync(path.join(srcRoot, 'composables/useFiles.ts'), 'utf8');
  assert.match(useFiles, /invoke<string>\('extract_textpack'/);
  const useExport = fs.readFileSync(path.join(srcRoot, 'composables/useExport.ts'), 'utf8');
  assert.match(useExport, /invoke\('repack_textpack'/);
});

test('#737: hideBlankLinesInLiveEdit setting toggles .cm-collapse-blank-lines in Live Edit', () => {
  const settingsTs = fs.readFileSync(path.join(srcRoot, 'stores/settings.ts'), 'utf8');
  const settingsPanel = fs.readFileSync(path.join(srcRoot, 'components/SettingsPanel.vue'), 'utf8');
  const editorVue = fs.readFileSync(path.join(srcRoot, 'components/Editor.vue'), 'utf8');
  assert.match(settingsTs, /hideBlankLinesInLiveEdit:\s*boolean/);
  assert.match(settingsTs, /toggleHideBlankLinesInLiveEdit\(\)/);
  assert.match(settingsPanel, /toggleHideBlankLinesInLiveEdit/);
  assert.match(editorVue, /'cm-collapse-blank-lines':\s*settings\.hideBlankLinesInLiveEdit/);
  assert.match(editorVue, /\.cm-collapse-blank-lines\s+:deep\(/);
});
