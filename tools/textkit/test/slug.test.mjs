import { test } from 'node:test';
import assert from 'node:assert/strict';
import { slugify } from '../src/slug.mjs';

test('joins words with a dash', () => {
  assert.equal(slugify('Hello World'), 'hello-world');
});

test('drops leading and trailing separators', () => {
  assert.equal(slugify('  Hello, World!  '), 'hello-world');
});
