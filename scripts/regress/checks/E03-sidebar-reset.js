// id: E3
// title: view.resetSidebarPanes restores pane heights, order and width
const R = checks();
const base = window.__regressSettings;
settings.rightSidebarPaneHeights = { tags: 200, tasks: 80 };
settings.rsPaneOrder = [...base.rsPaneOrder].reverse();
settings.sideSidebarWidth = (base.sideSidebarWidth || 260) + 140;
settings.persist();
act('view.resetSidebarPanes');
await sleep(150);
R.eq(settings.rightSidebarPaneHeights, {}, 'heights reset');
R.eq(settings.rsPaneOrder, base.rsPaneOrder, 'order reset');
R.eq(settings.sideSidebarWidth, base.sideSidebarWidth, 'width reset');
return R.done();
