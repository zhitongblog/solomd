import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPinia, setActivePinia } from 'pinia';
import { useWorkspaceStore } from './workspace.ts';

test('#205: Virtual Workspace adds scattered files, auto-disambiguates duplicate basenames, and updates aliases/notes', () => {
  setActivePinia(createPinia());
  const ws = useWorkspaceStore();
  ws.clearVirtualItems();

  ws.addVirtualItem('/code/project-alpha/AGENTS.md');
  assert.equal(ws.virtualItems.length, 1);
  assert.equal(ws.virtualItems[0].path, '/code/project-alpha/AGENTS.md');
  assert.equal(ws.virtualItems[0].alias, undefined);

  // Adding a second AGENTS.md from another project auto-fills `<parent> / AGENTS.md`
  ws.addVirtualItem('/code/project-beta/AGENTS.md');
  assert.equal(ws.virtualItems.length, 2);
  assert.equal(ws.virtualItems[1].alias, 'project-beta / AGENTS.md');

  // Custom alias and note
  ws.updateVirtualItem('/code/project-alpha/AGENTS.md', {
    alias: 'Alpha 主控 Agent',
    note: '负责前端与网关编排',
  });
  assert.equal(ws.virtualItems[0].alias, 'Alpha 主控 Agent');
  assert.equal(ws.virtualItems[0].note, '负责前端与网关编排');

  ws.removeVirtualItem('/code/project-beta/AGENTS.md');
  assert.equal(ws.virtualItems.length, 1);
});
