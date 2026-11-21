import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ELLIPSIS } from '../src/ellipsis.mjs';

test('is a single character', () => {
  assert.equal(ELLIPSIS.length, 1);
});
