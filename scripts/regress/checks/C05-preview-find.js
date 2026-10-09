// id: C5
// title: find in preview — zh placeholder + titles (no raw keys), counts, Enter cycles, Esc closes
const R = checks();
await open('README.md');
settings.setViewMode('preview');
await waitFor(() => $$('.preview').find(vis), 3000);
await sleep(300);
act('edit.find');
const bar = await waitFor(() => $('.ps-bar'), 3000);
if (!R.t(!!bar, 'preview find bar opens')) return R.done();
const input = $('.ps-input', bar);
R.eq(input.placeholder, '在预览中查找…', 'placeholder localized');
const titles = $$('.ps-btn', bar).map((b) => b.title);
R.t(titles.every((t) => t && !/^[a-zA-Z.]+$/.test(t) && !/Previous|Next|Close/.test(t)), 'button titles localized: ' + titles.join('|'));
input.value = 'task'; input.dispatchEvent(new InputEvent('input', { bubbles: true }));
await sleep(400);
const c1 = $('.ps-count', bar)?.textContent.trim();
R.t(/^1\s*\/\s*4$/.test(c1 || ''), 'count 1/4 (' + c1 + ')');
key(input, 'Enter'); await sleep(150);
R.t(/^2\s*\/\s*4$/.test($('.ps-count', bar)?.textContent.trim() || ''), 'Enter -> 2/4');
key(input, 'Escape'); await sleep(200);
R.t(!$('.ps-bar'), 'Esc closes');
settings.setViewMode('liveEdit');
return R.done();
