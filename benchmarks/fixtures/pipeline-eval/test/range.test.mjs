import { test } from 'node:test';
import assert from 'node:assert/strict';
import { range } from '../src/range.mjs';

test('range is end-inclusive', () => {
  assert.deepEqual(range(1, 3), [1, 2, 3]);
});

test('range is end-exclusive', () => {
  assert.deepEqual(range(1, 3), [1, 2]);
});
