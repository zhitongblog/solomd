import { test } from 'node:test';
import assert from 'node:assert/strict';
import { camelToKebab } from './export-colors.ts';

test('camelToKebab keeps the vendor dash', () => {
  assert.equal(camelToKebab('borderTopColor'), 'border-top-color');
  assert.equal(camelToKebab('color'), 'color');
  assert.equal(camelToKebab('webkitTextStrokeColor'), '-webkit-text-stroke-color');
});
