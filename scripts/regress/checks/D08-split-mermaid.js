// id: D1
// title: two split panes previewing the same note both render the mermaid diagram
// timeout: 30000
const R = checks();
await open('notes/Math Note.md');
settings.setViewMode('preview');
act('tile.splitRight'); await sleep(800);
const ok = await waitFor(() => {
  const svgs = $$('.preview-host svg').filter((s) => /Start|Finish/.test(s.textContent) && vis(s));
  return svgs.length >= 2 ? svgs : null;
}, 8000);
R.t(!!ok, 'mermaid svg rendered in both panes (' + $$('.preview-host svg').filter((s) => /Start|Finish/.test(s.textContent)).length + ')');
R.t(!$$('.preview-host').some((h) => /Mermaid error|Syntax error/i.test(h.textContent)), 'no mermaid error box');
act('tile.closePane'); settings.setViewMode('liveEdit');
return R.done();
