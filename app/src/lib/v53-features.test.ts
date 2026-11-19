import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  STARTER_PLUGIN_PRESETS,
  runSandboxedPluginScript,
  runUserTransform,
} from './user-plugins.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.resolve(__dirname, '../..');
const REPO_ROOT = path.resolve(APP_ROOT, '..');

test('#617: live mode ordered and unordered list markers use tighter natural spacing', () => {
  const cmLiveRender = fs.readFileSync(path.join(APP_ROOT, 'src/lib/cm-live-render.ts'), 'utf8');
  assert.ok(cmLiveRender.includes('? 0.95'), 'bullet marker width should be tightened to 0.95em');
  assert.ok(cmLiveRender.includes('markLen <= 2'), '1-digit ordered markers should use tighter column width');
  assert.ok(cmLiveRender.includes('? 1.45'), '1-digit ordered markers should be 1.45em');
  assert.ok(cmLiveRender.includes('? 1.95'), '2-digit ordered markers should be 1.95em');
});

test('#173 (v5.3): sandboxed plugin scripts enforce capability scopes, shadow globals, and run built-in presets', async () => {
  // 1. Built-in Reading Stats Frontmatter Script
  const statsPreset = STARTER_PLUGIN_PRESETS.find((p) => p.id === 'reading-stats-frontmatter');
  assert.ok(statsPreset, 'reading-stats-frontmatter preset should exist');
  const statsTf = statsPreset.transforms?.[0];
  assert.ok(statsTf && statsTf.kind === 'script');

  const statsRes = await runUserTransform(
    statsTf,
    '---\ntitle: 测试笔记\n---\n\n这是一篇包含 Hello World 的测试文章。',
    { title: '测试笔记', capabilities: statsPreset.capabilities },
  );
  assert.ok(statsRes.content.includes('words: 13'), `expected word count in frontmatter, got:\n${statsRes.content}`);
  assert.ok(statsRes.content.includes('reading_time: 1 min'));
  assert.ok(statsRes.message.includes('13 words'));

  // 2. Built-in Link Reference Collector Script
  const linksPreset = STARTER_PLUGIN_PRESETS.find((p) => p.id === 'link-reference-collector');
  assert.ok(linksPreset);
  const linksTf = linksPreset.transforms?.[0]!;
  const linksRes = await runUserTransform(
    linksTf,
    'Check [SoloMD](https://solomd.app) and https://github.com/zhitongblog/solomd and https://solomd.app again.',
    { title: 'Links', capabilities: linksPreset.capabilities },
  );
  assert.ok(linksRes.content.includes('## References'));
  assert.ok(linksRes.content.includes('1. https://solomd.app'));
  assert.ok(linksRes.content.includes('2. https://github.com/zhitongblog/solomd'));
  assert.ok(!linksRes.content.includes('3. '), 'duplicate URLs must be deduplicated');

  // 3. Capability enforcement blocks undeclared write/frontmatter/toast/webhook actions
  assert.throws(
    () =>
      runSandboxedPluginScript(
        'solomd.setContent("hacked");',
        ['doc:read'],
        'original',
      ),
    /Capability denied: plugin requires "doc:write"/,
  );
  assert.throws(
    () =>
      runSandboxedPluginScript(
        'solomd.setFrontmatter({ a: "1" });',
        ['doc:read', 'doc:write'],
        'original',
      ),
    /Capability denied: plugin requires "frontmatter:write"/,
  );

  await assert.rejects(
    () =>
      runUserTransform(
        { id: 'wh', title: 'WH', kind: 'webhook', webhookUrl: 'https://example.com' },
        'body',
        { capabilities: ['doc:read'] },
      ),
    /Capability denied: webhook requires "net:fetch"/,
  );

  // 4. Ambient dangerous globals are shadowed as undefined inside the sandbox
  const probe = runSandboxedPluginScript(
    [
      'const leaked = [typeof window, typeof document, typeof fetch, typeof localStorage, typeof globalThis, typeof process, typeof require];',
      'solomd.setContent(leaked.join(","));',
    ].join('\n'),
    ['doc:write'],
    '',
  );
  assert.equal(
    probe.content,
    'undefined,undefined,undefined,undefined,undefined,undefined,undefined',
    'all ambient globals must be shadowed as undefined inside sandboxed scripts',
  );
});

test('#311: tauri.conf.json enables cross-platform WebView CSP defence-in-depth', () => {
  const conf = JSON.parse(
    fs.readFileSync(path.join(APP_ROOT, 'src-tauri/tauri.conf.json'), 'utf8'),
  );
  const csp = conf?.app?.security?.csp;
  assert.equal(typeof csp, 'string', 'CSP must be an explicit policy string, not null');
  assert.ok(csp.includes("object-src 'none'"), 'CSP must disable <object>/<embed>');
  assert.ok(csp.includes("base-uri 'self'"), 'CSP must lock base-uri');
  assert.ok(csp.includes('ipc:') && csp.includes('http://ipc.localhost'), 'CSP must allow Tauri IPC');
  assert.ok(csp.includes('asset:') && csp.includes('http://asset.localhost'), 'CSP must allow asset protocol');
  const scriptSrc = /script-src\s+([^;]+)/.exec(csp)?.[1] ?? '';
  assert.ok(!scriptSrc.includes('https:'), 'script-src must not permit arbitrary remote https: scripts');
});

test('#618, #601, #181: Baidu sync retry/cleanup, glibc 2.28 packaging, and AUR PKGBUILD exist', () => {
  const webdavRs = fs.readFileSync(path.join(APP_ROOT, 'src-tauri/src/webdav_sync.rs'), 'utf8');
  assert.ok(webdavRs.includes('fn sanitize_sync_error_message'), 'must redact access_token from sync errors');
  assert.ok(webdavRs.includes('const MAX_ATTEMPTS: usize = 4;'), 'baidu_download_by_fsid must retry transient errors');
  assert.ok(webdavRs.includes('baidu_delete_remote_file(client, token, &stale_full).await;'), 'baidu_push_folder must remove renamed/deleted remote files');

  assert.ok(fs.existsSync(path.join(REPO_ROOT, 'packaging/linux-glibc228/Dockerfile')));
  assert.ok(fs.existsSync(path.join(REPO_ROOT, 'scripts/build-linux-glibc228.sh')));
  assert.ok(fs.existsSync(path.join(REPO_ROOT, 'packaging/aur/PKGBUILD')));
  assert.ok(fs.existsSync(path.join(REPO_ROOT, 'scripts/update-aur.sh')));
  assert.ok(fs.existsSync(path.join(APP_ROOT, 'src/components/WikiLinkHoverPreview.vue')));
});
