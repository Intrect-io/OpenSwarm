import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clamp } from '../src/clamp.mjs';

test('keeps a value inside the range', () => {
  assert.equal(clamp(5, 0, 10), 5);
});

test('clamps to the bounds', () => {
  assert.equal(clamp(-3, 0, 10), 0);
  assert.equal(clamp(42, 0, 10), 10);
});
