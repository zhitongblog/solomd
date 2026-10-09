// id: A1 F-10
// title: file.new / file.newText open a tab of the right type with the caret in the editor
const R = checks();
for (const [id, lang, name] of [['file.new', 'markdown', 'Untitled.md'], ['file.newText', 'plaintext', 'Untitled.txt']]) {
  const before = tabs.tabs.length;
  act(id);
  const focused = await waitFor(() => tabs.tabs.length === before + 1 && document.activeElement?.closest?.('.cm-content') && V()?.contentDOM === document.activeElement.closest('.cm-content') && V().state.doc.length === 0, 3000);
  const t = tabs.activeTab;
  R.t(tabs.tabs.length === before + 1, `${id}: new tab (${before}->${tabs.tabs.length})`);
  R.eq([t?.fileName, t?.language], [name, lang], `${id}: name/language`);
  R.t(!!focused, `${id}: caret in the new tab's editor (DOM focus; document.hasFocus=${document.hasFocus()}) (activeElement=${document.activeElement?.tagName}.${document.activeElement?.className})`);
  document.activeElement?.blur?.();
  await sleep(100);
}
return R.done();
