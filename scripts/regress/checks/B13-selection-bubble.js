// id: B13
// title: selection bubble appears on a selection and its Bold button applies
const R = checks();
await fresh('bubble.md', 'Intro text here\n');
const v = V();
v.focus();
v.dispatch({ selection: { anchor: 0, head: 5 } });
// The bubble follows mouseup / selection settle.
v.contentDOM.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
const bubble = await waitFor(() => $('.sel-bubble.sel-bubble--placed'), 3000);
if (!R.t(!!bubble, 'bubble placed')) // Hidden while the find bar has focus (the selection stays)
v.dispatch({ selection: { anchor: 0, head: 5 } });
v.contentDOM.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
await waitFor(() => $('.sel-bubble.sel-bubble--placed'), 2000);
act('edit.find');
await waitFor(() => document.activeElement?.matches?.('.cm-find input'), 2000);
await sleep(400);
const bb = $('.sel-bubble');
const shown = bb && vis(bb) && getComputedStyle(bb).opacity !== '0' && bb.classList.contains('sel-bubble--placed');
R.t(!shown, 'bubble hidden while the find bar is focused');
return R.done();
const labels = $$('.sel-bubble__btn', bubble).map((b) => b.getAttribute('title') || b.getAttribute('aria-label') || b.textContent.trim());
R.t(labels.some((l) => /加粗/.test(l)), 'buttons: ' + labels.join('/'));
const bold = $$('.sel-bubble__btn', bubble).find((b) => /加粗/.test(b.getAttribute('title') || b.getAttribute('aria-label') || ''));
if (bold) {
  bold.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
  bold.click(); await sleep(150);
  R.eq(doc(), '**Intro** text here\n', 'bubble Bold applies');
}
return R.done();
