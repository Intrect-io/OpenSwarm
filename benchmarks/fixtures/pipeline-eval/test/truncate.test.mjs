import { test } from 'node:test';
import assert from 'node:assert/strict';
import { truncate } from '../src/truncate.mjs';

test('leaves short text alone', () => {
  assert.equal(truncate('short', 8), 'short');
});

test('cuts long text to the limit with three dots', () => {
  assert.equal(truncate('hello world', 8), 'hello...');
  assert.equal(truncate('hello world', 8).length, 8);
});
