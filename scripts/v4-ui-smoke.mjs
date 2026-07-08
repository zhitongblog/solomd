#!/usr/bin/env node
/**
 * v4-ui-smoke.mjs
 *
 * v4.0 live UI self-test — drives a running `pnpm tauri dev` instance via
 * the dev-bridge `/eval` endpoint and verifies every v4 surface mounts
 * with the expected DOM shape. This is the UI half of the v4.0
 * Definition-of-Done; the Rust half is `scripts/v4-self-test.sh`.
 *
 * Coverage:
 *   · Pillar 1 — Agent Panel mount + textarea + send button
 *   · Pillar 2 — 11 cookbook recipes + Pending / Recipes / History sections
 *   · Pillar 3 — TraceView mount + step cards + footer totals
 *               (dropped a synthetic run-dir to make this deterministic)
 *   · Pillar 4 — MCP profiles section (mcpp__heading-row)
 *   · Pillar 5 — Ollama auto-detect indicator (ai-settings__ollama)
 *   · Quality bar — first-run wizard (wiz-backdrop), REST API panel (rest__),
 *                   BYOK cost meter panel (cost__)
 *
 * Output → /tmp/v4-ui-smoke.log
 *
 * Usage:
 *   1. Start `pnpm tauri dev` in another terminal.
 *   2. Open SoloMD, point the workspace at any folder.
 *   3. node scripts/v4-ui-smoke.mjs
 *
 * Exit 0 = every check green; exit 1 = at least one failed.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const LOG = '/tmp/v4-ui-smoke.log';
writeFileSync(LOG, `# v4 UI smoke · ${new Date().toISOString()}\n\n`);

function log(...a) {
  const line = a.join(' ');
  console.log(line);
  // append to log
  import('node:fs').then(({ appendFileSync }) => appendFileSync(LOG, line + '\n'));
}

const cfgDir = join(homedir(), 'Library/Application Support/app.solomd');
function cfgFile(name) {
  return readFileSync(join(cfgDir, name), 'utf8').trim();
}

let port, token;
try {
  port = cfgFile('dev-bridge.port');
  token = cfgFile('dev-bridge.token');
} catch (e) {
  console.error('error reading dev-bridge config — is `pnpm tauri dev` running?');
  console.error(e.message);
  process.exit(2);
}

const BRIDGE = `http://127.0.0.1:${port}`;

async function devEval(script, timeout = 5000) {
  const r = await fetch(`${BRIDGE}/eval`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
    },
    body: JSON.stringify({ script, timeout_ms: timeout }),
  });
  if (!r.ok) throw new Error(`bridge ${r.status}: ${await r.text()}`);
  return await r.json();
}

const RED = '\x1b[31m', GREEN = '\x1b[32m', RESET = '\x1b[0m', DIM = '\x1b[2m';
const failed = [];

async function check(name, evalScript, predicate) {
  process.stdout.write(`${name.padEnd(56)} `);
  try {
    const raw = await devEval(evalScript);
    // The dev-bridge wraps the eval result in { ok, value } — unwrap.
    const result = raw && typeof raw === 'object' && 'value' in raw ? raw.value : raw;
    const ok = predicate(result);
    if (ok) {
      console.log(`${GREEN}PASS${RESET}`);
    } else {
      console.log(`${RED}FAIL${RESET}`);
      failed.push({ name, result });
      console.log(`${DIM}    ${JSON.stringify(result).slice(0, 200)}${RESET}`);
    }
  } catch (e) {
    console.log(`${RED}ERR${RESET}  ${e.message.slice(0, 80)}`);
    failed.push({ name, err: e.message });
  }
}

// ---------------------------------------------------------------------------
// Setup — drop a synthetic run dir so Pillar 3 has data to render.
// ---------------------------------------------------------------------------

async function getWorkspace() {
  return await devEval(
    `return await window.__TAURI_INTERNALS__.invoke('workspace_get');`,
  ).catch(() => null);
}

async function ensureSyntheticRun(workspace) {
  if (!workspace) return null;
  const runId = '20260501-130000-aaa111';
  const runDir = `${workspace}/.solomd/agent-runs/${runId}`;
  if (existsSync(runDir)) return runId;
  try {
    mkdirSync(runDir, { recursive: true });
    writeFileSync(`${runDir}/meta.json`, JSON.stringify({
      run_id: runId,
      kind: 'recipe',
      started_at: 1746086400,
      ended_at: 1746086405,
      status: 'ok',
      workspace,
      provider: 'claude',
      model: 'claude-sonnet-4-6',
      recipe: { name: 'Smoke test', path: '.solomd/agents/smoke.yml', trigger: 'manual', branch: `agent/smoke/${runId}` },
      tokens: { input: 420, output: 85 },
      cost_usd_estimate: 0.0014,
      error: null,
    }, null, 2));
    const lines = [
      { ts: 1746086400000, run_id: runId, seq: 1, kind: 'run_started', run_kind: 'recipe', provider: 'claude', model: 'claude-sonnet-4-6', recipe: { name: 'Smoke test', path: '.solomd/agents/smoke.yml', trigger: 'manual', branch: `agent/smoke/${runId}` } },
      { ts: 1746086400500, run_id: runId, seq: 2, kind: 'prompt', text: 'Read welcome.md and summarize.' },
      { ts: 1746086401000, run_id: runId, seq: 3, kind: 'model_call', provider: 'claude', model: 'claude-sonnet-4-6' },
      { ts: 1746086402500, run_id: runId, seq: 4, kind: 'tool_call', tool: 'read_note', tool_call_id: 'call_1', args: { path: 'welcome.md' } },
      { ts: 1746086402800, run_id: runId, seq: 5, kind: 'tool_result', tool_call_id: 'call_1', result: 'welcome.md content here' },
      { ts: 1746086403200, run_id: runId, seq: 6, kind: 'model_call', provider: 'claude', model: 'claude-sonnet-4-6' },
      { ts: 1746086405100, run_id: runId, seq: 7, kind: 'model_done', input_tokens: 420, output_tokens: 85, text: 'A SoloMD onboarding tutorial.' },
      { ts: 1746086405200, run_id: runId, seq: 8, kind: 'run_ended', status: 'ok', input_tokens: 420, output_tokens: 85, cost_usd: 0.0014 },
    ];
    writeFileSync(`${runDir}/trace.jsonl`, lines.map(l => JSON.stringify(l)).join('\n') + '\n');
    writeFileSync(`${runDir}/run.md`, '# Smoke test\n\nSynthetic run for v4 UI smoke test.\n');
    return runId;
  } catch (e) {
    log(`note: could not seed synthetic run (${e.message}) — Pillar 3 will be skipped if no real runs exist`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Test driver
// ---------------------------------------------------------------------------

console.log();
console.log(`=== SoloMD v4.0 live UI smoke · ${new Date().toISOString()} ===`);
console.log();

// Workspace lives in localStorage (`solomd.workspace.v1`) rather than a
// Tauri command — read it directly.
const wsResultRaw = await devEval(`
  try {
    const raw = localStorage.getItem('solomd.workspace.v1');
    return { folder: raw ? (JSON.parse(raw).currentFolder || null) : null };
  } catch {
    return { folder: null };
  }
`).catch(() => ({ value: { folder: null } }));
const wsResult = wsResultRaw && typeof wsResultRaw === 'object' && 'value' in wsResultRaw ? wsResultRaw.value : wsResultRaw;
const workspace = wsResult?.folder;
if (workspace) await ensureSyntheticRun(workspace);

// Pillar 1 — Agent Panel
await check('Pillar 1 · Agent Panel mounted', `
  const p = document.querySelector('.agent-panel');
  return { hasPanel: !!p, hasInput: !!p?.querySelector('.agent-panel__input'), hasSend: !!p?.querySelector('.agent-panel__send'), hasBeta: !!p?.querySelector('.agent-panel__beta') };
`, r => r.hasPanel && r.hasInput && r.hasSend && r.hasBeta);

// Open settings (Cmd+,)
await devEval(`
  const evt = new KeyboardEvent('keydown', { key: ',', metaKey: true, bubbles: true, cancelable: true });
  if (!document.querySelector('.settings__backdrop')) window.dispatchEvent(evt);
  await new Promise(r => setTimeout(r, 400));
  // click Integrations
  const nav = Array.from(document.querySelectorAll('.settings__nav-item'));
  nav.find(b => b.innerText.includes('集成') || b.innerText.toLowerCase().includes('integration'))?.click();
  await new Promise(r => setTimeout(r, 400));
  return { open: !!document.querySelector('.settings__backdrop') };
`);

// Pillar 2 — Recipes (cookbook)
await check('Pillar 2 · Cookbook lists 11 starters', `
  const browseBtn = Array.from(document.querySelectorAll('button')).find(b => /浏览菜谱|browse cookbook/i.test(b.innerText));
  if (browseBtn && !document.querySelector('.recipes__cookbookItem')) {
    browseBtn.click();
    await new Promise(r => setTimeout(r, 400));
  }
  return { count: document.querySelectorAll('.recipes__cookbookItem').length };
`, r => r.count === 11);

await check('Pillar 2 · Pending / Recipes / History sections', `
  const text = document.body.innerText || '';
  return {
    pending: /待审核|pending/i.test(text),
    recipes: /食谱|recipes/i.test(text),
    history: /历史|history/i.test(text),
  };
`, r => r.pending && r.recipes && r.history);

// Pillar 3 — TraceView (only if workspace has at least one run)
if (workspace) {
  await check('Pillar 3 · TraceView mounts on history click', `
    // Close+reopen settings to force RecipesSettings remount, picking up the
    // freshly-dropped run dir.
    if (document.querySelector('.settings__backdrop')) {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await new Promise(r => setTimeout(r, 300));
    }
    window.dispatchEvent(new KeyboardEvent('keydown', { key: ',', metaKey: true, bubbles: true }));
    await new Promise(r => setTimeout(r, 400));
    Array.from(document.querySelectorAll('.settings__nav-item')).find(b => /集成|integration/i.test(b.innerText))?.click();
    await new Promise(r => setTimeout(r, 600));

    const item = document.querySelector('.recipes__historyItem');
    if (!item) return { err: 'no history items' };
    item.querySelector('.recipes__historyHeader')?.click();
    await new Promise(r => setTimeout(r, 700));
    const tv = document.querySelector('.trace-view');
    return {
      hasTraceView: !!tv,
      stepCards: document.querySelectorAll('.trace-card').length,
      hasFooter: !!document.querySelector('.trace-footer'),
    };
  `, r => r.hasTraceView && r.stepCards >= 1 && r.hasFooter);
}

// Pillar 4 — MCP profiles
await check('Pillar 4 · MCP profiles section', `
  return { has: !!document.querySelector('.mcpp__heading'), addBtn: !!Array.from(document.querySelectorAll('button')).find(b => /新建配置档|new profile/i.test(b.innerText)) };
`, r => r.has && r.addBtn);

// Pillar 5 — Ollama auto-detect
await check('Pillar 5 · Ollama auto-detect indicator', `
  // Switch to Writing tab + Ollama provider
  Array.from(document.querySelectorAll('.settings__nav-item')).find(b => /写作|writing/i.test(b.innerText))?.click();
  await new Promise(r => setTimeout(r, 300));
  const sel = Array.from(document.querySelectorAll('select')).find(s => s.parentElement?.innerText?.includes('提供商') || s.parentElement?.innerText?.toLowerCase().includes('provider'));
  if (sel && sel.value !== 'ollama') {
    sel.value = 'ollama';
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise(r => setTimeout(r, 600));
  }
  const panel = document.querySelector('.ai-settings__ollama');
  return {
    has: !!panel,
    text: panel?.innerText?.slice(0, 200),
    detectsState: /未检测|检测到|未运行|已运行|detected|running/i.test(panel?.innerText || ''),
  };
`, r => r.has && r.detectsState);

// Quality bar — REST API + cost meter
await check('Quality · REST API panel', `
  Array.from(document.querySelectorAll('.settings__nav-item')).find(b => /集成|integration/i.test(b.innerText))?.click();
  await new Promise(r => setTimeout(r, 300));
  return { has: !!document.querySelector('.rest__heading') };
`, r => r.has);

await check('Quality · BYOK cost meter panel', `
  return { has: !!document.querySelector('.cost__heading') };
`, r => r.has);

await check('Quality · First-run wizard reopen', `
  // Find "重新运行配置向导" button (writing tab)
  Array.from(document.querySelectorAll('.settings__nav-item')).find(b => /写作|writing/i.test(b.innerText))?.click();
  await new Promise(r => setTimeout(r, 300));
  const btn = Array.from(document.querySelectorAll('button')).find(b => /重新运行配置向导|reopen.*wizard|setup.*wizard/i.test(b.innerText));
  if (btn) btn.click();
  await new Promise(r => setTimeout(r, 500));
  const wiz = document.querySelector('.wiz-backdrop, .wiz');
  // close it before returning
  document.querySelector('.wiz__close')?.click();
  return { mounted: !!wiz };
`, r => r.mounted);

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log();
if (failed.length === 0) {
  console.log(`${GREEN}✓ all v4 UI surfaces green${RESET}`);
  console.log();
  console.log('Bookkeeping:');
  console.log('  · Workspace under test: ' + (workspace ?? '(none)'));
  console.log('  · Synthetic run id:     20260501-130000-aaa111');
  process.exit(0);
} else {
  console.log(`${RED}✗ ${failed.length} failed:${RESET}`);
  for (const f of failed) console.log(`  · ${f.name}`);
  process.exit(1);
}
