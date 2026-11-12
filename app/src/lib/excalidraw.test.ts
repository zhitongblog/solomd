import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isExcalidrawPath, parseExcalidrawScene, renderExcalidrawSvg } from './excalidraw.ts';

test('Gitee #IK9BC3: isExcalidrawPath detects .excalidraw, .excalidraw.svg, and .excalidraw.png', () => {
  assert.equal(isExcalidrawPath('diagram.excalidraw'), true);
  assert.equal(isExcalidrawPath('_assets/arch.excalidraw.png'), true);
  assert.equal(isExcalidrawPath('_assets/arch.excalidraw.svg'), true);
  assert.equal(isExcalidrawPath('notes.md'), false);
});

test('Gitee #IK9BC3: parseExcalidrawScene and renderExcalidrawSvg render shapes, arrows, and text', () => {
  const raw = JSON.stringify({
    type: 'excalidraw',
    version: 2,
    elements: [
      { id: 'r1', type: 'rectangle', x: 10, y: 20, width: 120, height: 60, strokeColor: '#1e1e1e', backgroundColor: '#a5d8ff' },
      { id: 't1', type: 'text', x: 30, y: 40, text: '架构模块 A', fontSize: 16 },
      { id: 'a1', type: 'arrow', x: 130, y: 50, points: [[0, 0], [80, 0]] },
    ],
  });
  const scene = parseExcalidrawScene(raw);
  assert.ok(scene);
  assert.equal(scene.elements.length, 3);

  const svg = renderExcalidrawSvg(raw);
  assert.ok(svg.startsWith('<svg class="solomd-excalidraw"'));
  assert.ok(svg.includes('<rect x="10" y="20"'));
  assert.ok(svg.includes('架构模块 A'));
  assert.ok(svg.includes('marker-end="url(#excalidraw-arrow)"'));
});
