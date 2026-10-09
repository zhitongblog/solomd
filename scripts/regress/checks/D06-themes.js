// id: D6
// title: light / dark / system (follows OS) themes and theme styles apply to body, editor, find bar, menus; custom CSS + clear
const R = checks();
await open('README.md');
// Effective background: the first non-transparent one up the ancestor chain.
const bg = (el) => { for (let e = el; e; e = e.parentElement) { const c = getComputedStyle(e).backgroundColor; if (!/rgba\(.*,\s*0\)$/.test(c) && c !== 'transparent') return c; } return 'rgb(255, 255, 255)'; };
const lum = (c) => { const m = c.match(/\d+(\.\d+)?/g).map(Number); return 0.2126 * m[0] + 0.7152 * m[1] + 0.0722 * m[2]; };
act('theme.set:dark'); await sleep(300);
R.eq(document.documentElement.dataset.theme, 'dark', 'data-theme dark');
R.t(lum(bg(document.body)) < 80, 'dark body bg ' + bg(document.body));
act('edit.find');
const fb = await waitFor(() => $('.cm-find'), 2000);
if (fb) { R.t(lum(bg(fb)) < 80, 'dark find bar ' + bg(fb)); key($('input[name=search]', fb), 'Escape'); }
act('palette.open'); const pal = await waitFor(() => $('.palette'), 2000);
if (pal) { R.t(lum(bg(pal)) < 80, 'dark palette ' + bg(pal)); APP.paletteOpen = false; }
act('theme.set:light'); await sleep(300);
R.t(lum(bg(document.body)) > 200, 'light body bg ' + bg(document.body));
// System theme: follows prefers-color-scheme
const sysDark = matchMedia('(prefers-color-scheme: dark)').matches;
act('theme.set:system'); await sleep(300);
R.t(settings.followSystemTheme === true, 'followSystemTheme set');
R.eq(settings.theme, sysDark ? 'dark' : 'light', 'system theme resolves to the OS appearance (' + (sysDark ? 'dark' : 'light') + ')');
R.t(!!$$('button, [role=menuitem], option').length, 'ui alive');
// Invalid themes are rejected
settings.setTheme('no-such-theme'); await sleep(100);
R.t(settings.theme !== 'no-such-theme', 'unknown theme ignored');
// Theme styles
const seen = new Set();
for (const th of ['nord', 'dracula', 'github-light', 'solarized-dark']) {
  act('theme.set:' + th); await sleep(250);
  seen.add(bg(document.body));
  R.eq(document.documentElement.dataset.theme, th, 'data-theme ' + th);
}
R.t(seen.size >= 3, 'theme styles change the background (' + [...seen].join(' ') + ')');
// Custom CSS
const css = '_work/' + CHECK + '-custom.css';
await writeText(css, '.cm-content { outline: 3px solid rgb(1, 2, 3) !important; }');
const { applyCustomCss, clearCustomCss } = await import('/src/lib/custom-theme.ts').catch(() => ({}));
if (applyCustomCss) {
  await applyCustomCss(path(css)); await sleep(200);
} else { settings.setCustomCssPath(path(css)); await sleep(500); }
R.eq(getComputedStyle($('.cm-content')).outlineColor, 'rgb(1, 2, 3)', 'custom CSS applied');
if (clearCustomCss) clearCustomCss(); else settings.setCustomCssPath('');
await sleep(300);
R.t(getComputedStyle($('.cm-content')).outlineColor !== 'rgb(1, 2, 3)', 'custom CSS cleared');
act('theme.set:light');
return R.done();
