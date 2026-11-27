import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { exportMediaAlignCss } from './html-export.ts';
import { SOLOMD_EPUB_CSS } from './epub-style.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const srcRoot = path.resolve(__dirname, '..');

test('#734: exportMediaAlignCss aligns data-source-line HTML <img> and overrides --media-margin vars in PDF/HTML/EPUB', () => {
  const rightCss = exportMediaAlignCss('right');
  assert.match(rightCss, /--media-align:\s*right;/);
  assert.match(rightCss, /--media-margin-left:\s*auto;/);
  assert.match(rightCss, /--media-margin-right:\s*0;/);
  assert.match(rightCss, /div\[data-source-line\] > img/);
  assert.match(rightCss, /li > img:only-child/);
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
