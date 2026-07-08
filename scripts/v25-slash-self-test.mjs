#!/usr/bin/env node
/**
 * v25-slash-self-test.mjs
 *
 * End-to-end self-test for the v2.5 slash-command extension. Drives a
 * running `pnpm tauri dev` instance via the dev-bridge `/eval` endpoint
 * and verifies user-visible behavior:
 *
 *   1. Open a markdown tab
 *   2. Type `/`  → popup appears
 *   3. Type `h1` → popup filters to Heading 1
 *   4. Press Enter → doc contains `# `, cursor right after
 *   5. Type `/code` → popup filters to Code block, Enter inserts fence
 *   6. Type `/table` → 3×3 markdown table inserted
 *   7. Inside an existing fenced code block → `/` should NOT open popup
 *
 * Output → /tmp/v25-slash-test.log
 *
 * Run after `pnpm tauri dev` is up. Reads bridge port + token from the
 * Tauri app config dir.
 */

import { readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const LOG = '/tmp/v25-slash-test.log';
writeFileSync(LOG, `# v2.5 slash-commands self-test · ${new Date().toISOString()}\n\n`);

function log(...args) {
  const msg = args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a, null, 2))).join(' ');
  console.log(msg);
  appendFileSync(LOG, msg + '\n');
}

function fatal(msg) {
  log('FATAL:', msg);
  process.exit(1);
}

// ---- Read bridge port + token ------------------------------------------
const cfgDir = join(homedir(), 'Library/Application Support/app.solomd');
let port, token;
try {
  port = parseInt(readFileSync(join(cfgDir, 'dev-bridge.port'), 'utf8').trim(), 10);
  token = readFileSync(join(cfgDir, 'dev-bridge.token'), 'utf8').trim();
} catch (e) {
  fatal(`couldn't read dev-bridge files in ${cfgDir}: ${e.message}`);
}
log(`bridge: 127.0.0.1:${port}, token=${token.slice(0, 8)}…`);

async function ev(script) {
  const res = await fetch(`http://127.0.0.1:${port}/eval`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ script }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
  const j = await res.json();
  if (!j.ok) throw new Error(`eval error: ${j.error}`);
  return j.value;
}

// Helper: get the active CM6 EditorView via its DOM element.
// CM6 stamps each rendered DOM node with a `cmTile` (or older `cmView`)
// pointer. The `tile.root.view` is the EditorView. We also fall back to
// `window.__solomdActiveView` if the host has exposed one.
const VIEW_ACCESSOR = `
  function __getView() {
    if (window.__solomdActiveView) return window.__solomdActiveView;
    const editorEl = document.querySelector('.cm-editor');
    if (!editorEl) throw new Error('no .cm-editor in DOM');
    const content = editorEl.querySelector('.cm-content');
    const candidates = [content, editorEl.querySelector('.cm-scroller'), editorEl];
    for (const el of candidates) {
      if (!el) continue;
      const tile = el.cmTile || el.cmView;
      const view = tile?.root?.view || tile?.view || tile?.editorView;
      if (view && typeof view.dispatch === 'function') return view;
    }
    // Walk every element and look for one with a tile pointing at a view.
    const all = editorEl.querySelectorAll('*');
    for (const el of all) {
      const tile = el.cmTile || el.cmView;
      const view = tile?.root?.view;
      if (view && typeof view.dispatch === 'function') return view;
    }
    throw new Error('CM6 EditorView not findable from .cm-editor (cmTile/cmView absent)');
  }
`;

const seedTabScript = (content) => `
  ${VIEW_ACCESSOR}
  const app = document.querySelector('#app')?.__vue_app__;
  if (!app) throw new Error('Vue app not mounted');
  const pinia = app.config.globalProperties.$pinia;
  const tabsStore = pinia._s.get('tabs');
  if (!tabsStore) throw new Error('tabs store not found');
  const tab = tabsStore.newTab({ language: 'markdown' });
  if (!tab || !tab.id) throw new Error('newTab returned ' + JSON.stringify(tab));
  tabsStore.setContent(tab.id, ${JSON.stringify(content)});
  // setContent only marks state; the editor reads from props.tab.content
  // when the tab id changes. The new tab is already activeId via newTab.
  await new Promise((r) => setTimeout(r, 350));
  const view = __getView();
  view.focus();
  return { tabId: tab.id, docLen: view.state.doc.length, doc: view.state.doc.toString() };
`;

const typeScript = (text, opts = {}) => `
  ${VIEW_ACCESSOR}
  const view = __getView();
  const sel = view.state.selection.main;
  const txt = ${JSON.stringify(text)};
  // Type one character at a time so the slash-trigger detector sees each
  // change individually (the listener checks "was the last insert a
  // single \`/\`?").
  for (const ch of txt) {
    const s = view.state.selection.main;
    view.dispatch({
      changes: { from: s.from, to: s.to, insert: ch },
      selection: { anchor: s.from + ch.length },
      userEvent: 'input.type',
    });
    await new Promise((r) => setTimeout(r, 25));
  }
  await new Promise((r) => setTimeout(r, ${opts.wait ?? 80}));
  return { doc: view.state.doc.toString(), head: view.state.selection.main.head };
`;

const keyScript = (key) => `
  ${VIEW_ACCESSOR}
  const view = __getView();
  const ev = new KeyboardEvent('keydown', { key: ${JSON.stringify(key)}, bubbles: true, cancelable: true });
  view.contentDOM.dispatchEvent(ev);
  await new Promise((r) => setTimeout(r, 100));
  return { doc: view.state.doc.toString(), head: view.state.selection.main.head };
`;

const popupScript = `
  const popup = document.querySelector('.cm-slash-popup');
  if (!popup) return { open: false };
  const rows = Array.from(popup.querySelectorAll('.cm-slash-row')).map((r) => ({
    id: r.getAttribute('data-id'),
    label: r.querySelector('.cm-slash-label')?.textContent ?? '',
    hint: r.querySelector('.cm-slash-hint')?.textContent ?? '',
    active: r.classList.contains('cm-slash-row--active'),
  }));
  const empty = popup.querySelector('.cm-slash-empty')?.textContent ?? null;
  return { open: true, rows, empty };
`;

// ---- Run the steps -----------------------------------------------------

let pass = 0;
let fail = 0;
const must = (cond, label) => {
  if (cond) {
    log(`  PASS · ${label}`);
    pass++;
  } else {
    log(`  FAIL · ${label}`);
    fail++;
  }
};

try {
  // Step 0: ping
  log('\nStep 0: ping bridge');
  await ev('1+1');
  log('  bridge OK');

  // Step 1: open empty markdown tab
  log('\nStep 1: open empty markdown tab and focus editor');
  const seed = await ev(seedTabScript(''));
  log('  seed →', seed);
  must(typeof seed?.tabId === 'string' || typeof seed?.tabId === 'number', 'tab created');

  // Step 2: type `/`, expect popup
  log('\nStep 2: type "/" → popup should open');
  await ev(typeScript('/'));
  // Need an extra tick — the update listener fires AFTER the doc change.
  await new Promise((r) => setTimeout(r, 80));
  let pop = await ev(popupScript);
  log('  popup →', { open: pop.open, rowCount: pop.rows?.length });
  must(pop.open === true, 'popup is open');
  must((pop.rows ?? []).length >= 10, 'popup has many rows');

  // Step 3: type `h1`, expect filtered to Heading 1
  log('\nStep 3: type "h1" → popup should filter to Heading 1 first');
  await ev(typeScript('h1'));
  await new Promise((r) => setTimeout(r, 80));
  pop = await ev(popupScript);
  log('  popup →', { open: pop.open, rows: pop.rows?.map((r) => r.id) });
  must(pop.open === true, 'popup still open after typing query');
  must(pop.rows?.[0]?.id === 'h1', 'first row is h1');
  must(pop.rows?.[0]?.active === true, 'h1 row is active (selectedIndex 0)');

  // Step 4: press Enter, expect "# " inserted with cursor right after
  log('\nStep 4: press Enter → insert Heading 1');
  const afterH1 = await ev(keyScript('Enter'));
  await new Promise((r) => setTimeout(r, 60));
  log('  doc after Enter →', JSON.stringify(afterH1.doc), 'head=', afterH1.head);
  must(afterH1.doc === '# ', 'doc is exactly "# "');
  must(afterH1.head === 2, 'cursor at offset 2 (right after "# ")');

  const popClosed = await ev(popupScript);
  must(popClosed.open === false, 'popup closed after Enter');

  // Step 5: clear doc, type `/code`, Enter → fenced code block
  log('\nStep 5: re-seed, type "/code" → Enter inserts code block');
  await ev(seedTabScript(''));
  await ev(typeScript('/'));
  await new Promise((r) => setTimeout(r, 80));
  await ev(typeScript('code'));
  await new Promise((r) => setTimeout(r, 80));
  pop = await ev(popupScript);
  log('  popup →', { rows: pop.rows?.map((r) => r.id) });
  must(pop.rows?.[0]?.id === 'code', 'first row is code');
  const afterCode = await ev(keyScript('Enter'));
  log('  doc →', JSON.stringify(afterCode.doc), 'head=', afterCode.head);
  // expected: ```\n<cursor>\n```  → 8 chars total, cursor at 4
  must(afterCode.doc === '```\n\n```', 'doc is the code fence');
  must(afterCode.head === 4, 'cursor inside the fence (offset 4)');

  // Step 6: re-seed, /table → 3×3 markdown table inserted
  log('\nStep 6: re-seed, type "/table" → table inserted');
  await ev(seedTabScript(''));
  await ev(typeScript('/table'));
  await new Promise((r) => setTimeout(r, 100));
  const afterTbl = await ev(keyScript('Enter'));
  log('  doc →', JSON.stringify(afterTbl.doc));
  must(afterTbl.doc.startsWith('| '), 'table starts with "| "');
  must(afterTbl.doc.includes('\n| --- |'), 'table has separator row');
  must(afterTbl.doc.split('\n').length === 4, 'table is 4 lines (header + sep + 2 rows)');

  // Step 7: inside an existing fenced code block, `/` should NOT open popup
  log('\nStep 7: inside fenced code block, "/" should NOT open popup');
  const fenced = '```\nhello\n```\n';
  await ev(seedTabScript(fenced));
  // Move cursor to inside the fence (line 2, before "h").
  await ev(`
    ${VIEW_ACCESSOR}
    const view = __getView();
    const line2 = view.state.doc.line(2);
    view.dispatch({ selection: { anchor: line2.from } });
    view.focus();
    // Wait for the lezer parser to settle.
    await new Promise((r) => setTimeout(r, 200));
    return view.state.selection.main.head;
  `);
  await ev(typeScript('/'));
  await new Promise((r) => setTimeout(r, 120));
  const inFencePopup = await ev(popupScript);
  log('  popup inside fence →', { open: inFencePopup.open });
  must(inFencePopup.open === false, 'popup does NOT open inside fenced code block');

  log('\n────────');
  log(`SUMMARY: ${pass} passed · ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
} catch (e) {
  log('\nUNCAUGHT:', e?.stack ?? String(e));
  process.exit(1);
}
