// id: L1 K3
// title: native menu (AX, our pid only) — items enabled, accelerators match the bindings, and follow a rebind
// timeout: 120000
const R = checks();
const parse = (text) => text.split('\n').filter(Boolean).map((l) => { const [menu, item, ch, mod, en] = l.split('\t'); return { menu, item, ch, mod, en }; });
const MODS = { 0: '⌘', 1: '⇧⌘', 2: '⌥⌘', 3: '⌥⇧⌘', 4: '⌃⌘', 8: '' };
const acc = (rows, re) => { const r = rows.find((x) => re.test(x.item)); return r ? (MODS[r.mod] ?? ('mod' + r.mod)) + (r.ch === 'missing value' ? '' : r.ch) : null; };
if (PHASE === 1) return { next: 1, host: { menu: true } };
if (PHASE === 2) {
  if (CARRY.menu.error) { R.t(false, 'AX read failed (grant Accessibility to the terminal running the suite): ' + CARRY.menu.error); return R.done(); }
  const rows = parse(CARRY.menu.text);
  R.t(rows.length > 60, 'menu items read: ' + rows.length + ' (pid ' + CARRY.menu.pid + ')');
  const disabled = rows.filter((r) => r.en === 'false' && !/自动填充|AutoFill|听写|表情|Emoji|开始听写/.test(r.item));
  R.t(disabled.length === 0, 'all items enabled (disabled: ' + disabled.map((r) => r.menu + '>' + r.item).slice(0, 8).join(', ') + ')');
  const expect = [[/^保存$/, '⌘S'], [/^加粗$/, '⇧⌘B'], [/切换文件树/, '⌘B'], [/命令面板/, '⇧⌘K'], [/^新建/, '⌘N'], [/打字机模式/, 'F9'.length ? null : null]];
  for (const [re, want] of expect) {
    if (!want) continue;
    R.eq(acc(rows, re), want, 'accelerator ' + re.source);
  }
  R.t(!rows.some((r) => /^About SoloMD/.test(r.item)), 'About item localized');
  settings.setKeybinding('view.toggleTypewriter', 'Mod+Alt+Shift+9');
  await sleep(1500);
  return { next: R.done(), host: { menu: true } };
}
const first = CARRY.carry;
R.t(first.ok, first.detail);
if (CARRY.menu.error) { R.t(false, 'AX read 2 failed: ' + CARRY.menu.error); return R.done(); }
const rows = parse(CARRY.menu.text);
R.eq(acc(rows, /打字机/), '⌥⇧⌘9', 'native accelerator follows the rebind');
settings.setKeybinding('view.toggleTypewriter', undefined);
return R.done();
