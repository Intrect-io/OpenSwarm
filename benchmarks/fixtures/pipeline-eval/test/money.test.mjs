import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatCents } from '../src/money.mjs';

test('always shows two decimals', () => {
  assert.equal(formatCents(105), '$1.05');
  assert.equal(formatCents(250), '$2.50');
  assert.equal(formatCents(7), '$0.07');
});

test('puts the minus sign before the dollar sign', () => {
  assert.equal(formatCents(-250), '-$2.50');
});
