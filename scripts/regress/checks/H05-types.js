// id: H5 F-4
// title: type.create works in a vault without a Types/ folder; dialog in zh
const R = checks();
const name = 'Meeting' + Date.now().toString(36);
const types = (await import('/src/stores/types.ts')).useTypesStore();
let err = '';
try { await types.createType(name); } catch (e) { err = String(e); }
R.t(!err, 'createType succeeds ' + err);
R.t(await exists('Types/' + name + '.md'), 'Types/' + name + '.md on disk');
const findDlg = () => $$('.ds-modal, [role=dialog], .modal').filter(vis).find((e) => /类型|Type/i.test(e.textContent) && e.querySelector('input'));
// 5.0 default: the right sidebar is hidden.
R.note('rightSidebarHidden=' + settings.rightSidebarHidden);
act('type.create');
let dlg = await waitFor(findDlg, 2000);
R.t(!!dlg, 'New Type dialog opens from the command with the default (hidden) right sidebar');
if (!dlg) {
  settings.rightSidebarHidden = false; await sleep(300);
  act('type.create');
  dlg = await waitFor(findDlg, 2000);
  R.note('with the right sidebar shown: dialog ' + (dlg ? 'opens' : 'still missing'));
}
if (dlg) {
  R.t(!/\bNew Type\b|\bCreate\b|\bCancel\b/.test(dlg.innerText), 'dialog localized: ' + dlg.innerText.replace(/\s+/g, ' ').slice(0, 80));
  key(dlg.querySelector('input') || dlg, 'Escape');
}
return R.done();
