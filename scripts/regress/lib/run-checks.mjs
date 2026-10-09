#!/usr/bin/env node
// Runs scripts/regress/checks/*.js against a live dev bridge.
//   node run-checks.mjs --data <app support dir> --vault <dir> --out <dir> --checks <dir> -- [filters…]
// Each check file is the body of an async function (prelude.js is prepended)
// that returns {ok:boolean, detail:string}. Header comments:
//   // id: C1            row id(s) shown in the table
//   // title: …          one-line description
//   // timeout: 30000    per-check budget in ms (default 20000)
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const argv = process.argv.slice(2);
const opt = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
const DATA = opt('--data');
const VAULT = opt('--vault');
const OUT = opt('--out');
const CHECKS = opt('--checks');
const PGID = opt('--pgid');
const dd = argv.indexOf('--');
const filters = dd >= 0 ? argv.slice(dd + 1) : [];
const LIB = path.dirname(new URL(import.meta.url).pathname);
const prelude = fs.readFileSync(path.join(LIB, 'prelude.js'), 'utf8');

function bridge() {
  return {
    port: fs.readFileSync(path.join(DATA, 'dev-bridge.port'), 'utf8').trim(),
    token: fs.readFileSync(path.join(DATA, 'dev-bridge.token'), 'utf8').trim(),
  };
}

async function evalRaw(script, timeoutMs) {
  const { port, token } = bridge();
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs + 5000);
  try {
    const r = await fetch(`http://127.0.0.1:${port}/eval`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ script, timeout_ms: timeoutMs }),
      signal: ctl.signal,
    });
    return await r.json();
  } catch (e) {
    return { ok: false, error: 'bridge: ' + (e.cause?.code || e.message) };
  } finally {
    clearTimeout(timer);
  }
}

/** Run `body` with the prelude; body returns any JSON value. */
async function runBody(body, id, timeoutMs, phase = 1, carry = null) {
  const script = `const VAULT = ${JSON.stringify(VAULT)}; const CHECK = ${JSON.stringify(id)};\n` +
    `const PHASE = ${phase}; const CARRY = ${JSON.stringify(carry)};\n${prelude}\n` +
    `const __res = await (async () => {\n${body}\n})();\nreturn __res;`;
  return evalRaw(script, timeoutMs);
}

async function waitBridge(ms) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const r = await evalRaw('return !!document.querySelector("#app")?.__vue_app__?._instance', 3000);
    if (r.ok && r.value === true) return true;
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}

/** pid of the app process this run started (for AX reads aimed at it alone). */
function appPid() {
  if (!PGID) return null;
  try {
    const out = execFileSync('pgrep', ['-g', PGID, '-f', 'target/debug/SoloMD'], { encoding: 'utf8' }).trim().split('\n')[0];
    return out ? Number(out) : null;
  } catch { return null; }
}

/** Native menu bar of OUR process (by unix id — never by name: a second SoloMD
 *  would be read instead). Lines: menu<TAB>item<TAB>cmdChar<TAB>modifiers<TAB>enabled. */
function dumpNativeMenu() {
  const pid = appPid();
  if (!pid) return { error: 'app pid not found (pgid ' + PGID + ')' };
  const script = `tell application "System Events"
  tell (first process whose unix id is ${pid})
    set out to ""
    repeat with m in menu bar items of menu bar 1
      set mname to name of m
      try
        repeat with mi in menu items of menu 1 of m
          try
            set nm to name of mi
            if nm is not missing value then
              set ch to ""
              set md to ""
              try
                set ch to value of attribute "AXMenuItemCmdChar" of mi
              end try
              try
                set md to value of attribute "AXMenuItemCmdModifiers" of mi
              end try
              set en to enabled of mi
              set out to out & mname & tab & nm & tab & ch & tab & md & tab & en & linefeed
            end if
          end try
        end repeat
      end try
    end repeat
    return out
  end tell
end tell`;
  try {
    return { pid, text: execFileSync('osascript', ['-e', script], { encoding: 'utf8', timeout: 60000 }) };
  } catch (e) {
    return { pid, error: String(e.stderr || e.message).slice(0, 300) };
  }
}

function header(src, k) {
  const m = src.match(new RegExp('^//\\s*' + k + ':\\s*(.+)$', 'm'));
  return m ? m[1].trim() : undefined;
}

const files = fs.readdirSync(CHECKS).filter((f) => f.endsWith('.js')).sort()
  .filter((f) => !filters.length || filters.some((x) => f.includes(x)));

const setup = fs.readFileSync(path.join(LIB, 'setup.js'), 'utf8');
const reset = fs.readFileSync(path.join(LIB, 'reset.js'), 'utf8');

if (!(await waitBridge(60000))) { console.error('[regress] bridge not answering'); process.exit(2); }
// Setup may reload the page (fresh localStorage); it returns 'reload' then.
let s = await runBody(setup, 'setup', 30000);
if (s.ok && s.value === 'reload') {
  await new Promise((r) => setTimeout(r, 3000));
  if (!(await waitBridge(60000))) { console.error('[regress] bridge lost after reload'); process.exit(2); }
  s = await runBody(setup, 'setup', 30000);
}
if (!s.ok || s.value !== 'ready') { console.error('[regress] setup failed:', JSON.stringify(s)); process.exit(2); }

const results = [];
for (const f of files) {
  const src = fs.readFileSync(path.join(CHECKS, f), 'utf8');
  const id = header(src, 'id') || f.replace(/\.js$/, '');
  const title = header(src, 'title') || '';
  const timeout = Number(header(src, 'timeout') || 20000);
  const key = f.replace(/\.js$/, '');
  const t0 = Date.now();
  let res;
  const r0 = await runBody(reset, key, 20000);
  if (!r0.ok) {
    // A crashed/hung page: give it one chance to come back before the check.
    await waitBridge(30000);
    await runBody(reset, key, 20000);
  }
  let r = await runBody(src, key, timeout);
  // Multi-phase checks: a phase returns
  //   {next: carry, reload?: true, wait?: ms,
  //    host?: {write: {rel: text}, delete: [rel], rename: {from: to}, menu: true}}.
  // host.menu: the next phase gets CARRY = {carry, menu: {pid, text | error}} (native menu via AX).
  // The runner then does what only the outside world can do — reload the page
  // (restart simulation) or write files as a foreign process (the app's own
  // write_file is a "self write" the watcher ignores) — and runs the same file
  // again with PHASE+1 and CARRY = carry.
  for (let phase = 2; phase <= 6 && r.ok && r.value && typeof r.value === 'object' && 'next' in r.value; phase++) {
    const v = r.value;
    for (const [rel, text] of Object.entries(v.host?.write || {})) {
      fs.mkdirSync(path.dirname(path.join(VAULT, rel)), { recursive: true });
      fs.writeFileSync(path.join(VAULT, rel), text);
    }
    for (const rel of v.host?.delete || []) fs.rmSync(path.join(VAULT, rel), { force: true, recursive: true });
    for (const [from, to] of Object.entries(v.host?.rename || {})) fs.renameSync(path.join(VAULT, from), path.join(VAULT, to));
    if (v.reload) {
      await new Promise((res) => setTimeout(res, 3000));
      await waitBridge(60000);
      const s2 = await runBody(setup, 'setup', 30000);
      if (!(s2.ok && s2.value === 'ready')) { r = { ok: false, error: 'setup after reload: ' + JSON.stringify(s2) }; break; }
    }
    if (v.wait) await new Promise((res) => setTimeout(res, v.wait));
    let carry = v.next;
    if (v.host?.menu) carry = { carry: v.next, menu: dumpNativeMenu() };
    r = await runBody(src, key, timeout, phase, carry);
  }
  if (r.ok && r.value && typeof r.value === 'object' && 'ok' in r.value) {
    res = { ok: !!r.value.ok, detail: String(r.value.detail ?? '') };
  } else if (r.ok) {
    res = { ok: false, detail: 'check returned ' + JSON.stringify(r.value) };
  } else {
    res = { ok: false, detail: 'ERROR ' + r.error };
    if (/timeout|bridge/.test(r.error)) await waitBridge(30000);
  }
  const row = { check: key, id, title, ok: res.ok, detail: res.detail, ms: Date.now() - t0 };
  results.push(row);
  process.stderr.write(`[regress] ${res.ok ? 'PASS' : 'FAIL'} ${key} (${row.ms} ms)\n`);
}

const pad = (s, n) => (s + ' '.repeat(n)).slice(0, n);
const w = Math.max(5, ...results.map((r) => r.check.length));
const lines = [`${pad('check', w)}  ${pad('rows', 10)}  result  detail`, '-'.repeat(w + 30)];
for (const r of results) {
  lines.push(`${pad(r.check, w)}  ${pad(r.id, 10)}  ${r.ok ? 'PASS  ' : 'FAIL  '}  ${r.ok ? r.detail.slice(0, 140) : r.detail}`);
}
const pass = results.filter((r) => r.ok).length;
lines.push('', `${pass}/${results.length} passed, ${results.length - pass} failed`);
console.log(lines.join('\n'));

fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify({
  when: new Date().toISOString(), vault: VAULT, passed: pass, failed: results.length - pass, results,
}, null, 2));
process.exit(pass === results.length ? 0 : 1);
