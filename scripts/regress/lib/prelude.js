// Prepended to every check. Runs inside the main WebView (async function body).
// The runner defines `VAULT` (absolute fixture path) and `CHECK` (check id) before this.
const APPV = document.querySelector('#app').__vue_app__;
const P = APPV.config.globalProperties.$pinia;
const st = (n) => P._s.get(n);
/** App.vue's <script setup> state (dev build): refs + functions such as dispatchMenuAction. */
const APP = APPV._instance.setupState;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const inv = (c, a) => window.__TAURI_INTERNALS__.invoke(c, a);
/** Run a menu / bindable / palette action exactly like a native menu click. */
const act = (id) => APP.dispatchMenuAction(id);
/** The CodeMirror view of the focused pane (falls back to the first editor). */
const V = () => {
  const tiles = st('tiles');
  const pane = tiles.focusedPaneId && document.querySelector(`[data-pane-id="${tiles.focusedPaneId}"] .cm-content`);
  return (pane && pane.cmTile && pane.cmTile.view) || window.__solomdActiveView ||
    document.querySelector('.cm-content')?.cmTile?.view;
};
const allViews = () => [...document.querySelectorAll('.cm-content')].map((e) => e.cmTile?.view).filter(Boolean);
const vis = (el) => {
  if (typeof el === 'string') el = document.querySelector(el);
  if (!el) return false;
  const r = el.getBoundingClientRect();
  const cs = getComputedStyle(el);
  return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none';
};
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
async function waitFor(fn, ms = 4000, step = 50) {
  const t0 = Date.now();
  let v;
  while (Date.now() - t0 < ms) {
    try { v = await fn(); } catch (e) { v = undefined; }
    if (v) return v;
    await sleep(step);
  }
  return v;
}
const path = (rel) => VAULT + '/' + rel;
async function writeText(rel, content) { await inv('write_file', { path: path(rel), content, encoding: 'UTF-8' }); }
async function readText(rel) { return (await inv('read_file', { path: path(rel) })).content; }
async function readBytes(rel) { return new Uint8Array(await inv('read_binary_file', { path: path(rel) })); }
async function exists(rel) { try { await inv('read_binary_file', { path: path(rel) }); return true; } catch { return false; } }
if (!window.__regressFiles) {
  const m = await import('/src/composables/useFiles.ts');
  window.__regressFiles = m.useFiles();
}
const F = window.__regressFiles;
/** Open a vault file (relative path) and wait until the editor shows it. */
async function open(rel) {
  await F.openPath(path(rel), { bypassNewWindow: true });
  const tabs = st('tabs');
  const ok = await waitFor(() => tabs.activeTab?.filePath === path(rel) && V() && V().state.doc.toString() === tabs.activeTab.content, 5000);
  if (!ok) throw new Error('open(' + rel + ') did not land in the editor');
  await sleep(150);
  return tabs.activeTab;
}
/** Write a check-private file under _work/ and open it: idempotent per run. */
async function fresh(name, content) {
  const rel = '_work/' + CHECK + '-' + name;
  await writeText(rel, content);
  const tabs = st('tabs');
  const t = tabs.tabs.find((x) => x.filePath === path(rel));
  if (t) { t.savedContent = t.content; tabs.closeTab(t.id); }
  return open(rel);
}
const setDoc = (s, a, h) => { const v = V(); v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: s }, selection: { anchor: a ?? 0, head: h ?? a ?? 0 } }); };
const doc = () => V().state.doc.toString();
const sel = () => { const m = V().state.selection.main; return { from: m.from, to: m.to, text: V().state.sliceDoc(m.from, m.to) }; };
/** Synthetic keydown (keymaps fire; text insertion does not). o: {meta,shift,alt,ctrl,code}. */
function key(el, k, o = {}) {
  const codes = { Enter: 13, Escape: 27, Tab: 9, Backspace: 8, ArrowUp: 38, ArrowDown: 40, F7: 118, ' ': 32 };
  const e = new KeyboardEvent('keydown', {
    key: k, code: o.code || (k.length === 1 ? (/[0-9]/.test(k) ? 'Digit' + k : 'Key' + k.toUpperCase()) : k),
    metaKey: !!o.meta, shiftKey: !!o.shift, altKey: !!o.alt, ctrlKey: !!o.ctrl, bubbles: true, cancelable: true,
  });
  Object.defineProperty(e, 'keyCode', { get: () => codes[k] || (k.length === 1 ? k.toUpperCase().charCodeAt(0) : 0) });
  (el || document.activeElement || document.body).dispatchEvent(e);
  return e;
}
/** Assertion collector: `const R = checks(); R.eq(a,b,'msg'); return R.done();` */
function checks() {
  const notes = []; let ok = true;
  const api = {
    t(cond, msg) { if (!cond) ok = false; notes.push((cond ? '' : 'FAIL: ') + msg); return !!cond; },
    eq(a, b, msg) { const c = JSON.stringify(a) === JSON.stringify(b); return api.t(c, msg + (c ? '' : ` (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`)); },
    note(msg) { notes.push(msg); },
    done(extra) { if (extra) notes.push(extra); return { ok, detail: notes.join('; ') }; },
  };
  return api;
}
const lineOf = (pos) => V().state.doc.lineAt(pos).number;
const settings = st('settings');
const tabs = st('tabs');
const tiles = st('tiles');
const workspace = st('workspace');
const toasts = st('toasts');
const lastToasts = () => (toasts.toasts || toasts.items || []).map((x) => x.message || x.text || '').slice(-5);
