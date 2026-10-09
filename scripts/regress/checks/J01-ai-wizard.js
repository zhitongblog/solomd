// id: J1
// title: the AI setup wizard is not shown on launch, and opens on the first reach for AI
const R = checks();
R.t(!APP.wizardOpen, 'no wizard at launch/baseline');
settings.agentWizardSeen = false;
await fresh('ai.md', 'rewrite me please\n');
V().dispatch({ selection: { anchor: 0, head: 10 } });
act('editor.aiRewrite');
const ok = await waitFor(() => APP.wizardOpen, 3000);
R.t(!!ok, 'wizard opens on the first AI reach');
APP.wizardOpen = false;
return R.done();
