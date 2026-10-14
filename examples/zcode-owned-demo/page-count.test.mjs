import test from 'node:test';
import assert from 'node:assert/strict';
import { pageCount } from './page-count.mjs';

// --- GPT 决策的 6 条验收用例 ---
test('acceptance 1: (0, 10) -> 0', () => {
  assert.equal(pageCount(0, 10), 0);
});

test('acceptance 2: (20, 10) -> 2', () => {
  assert.equal(pageCount(20, 10), 2);
});

test('acceptance 3: (21, 10) -> 3', () => {
  assert.equal(pageCount(21, 10), 3);
});

test('acceptance 4: (9007199254740991, 2) -> 4503599627370496', () => {
  assert.equal(pageCount(9007199254740991, 2), 4503599627370496);
});

test('acceptance 5: (-1, 10) throws RangeError', () => {
  assert.throws(() => pageCount(-1, 10), RangeError);
});

test('acceptance 6: (0, 0) throws RangeError without skipping validation', () => {
  assert.throws(() => pageCount(0, 0), RangeError);
});

// --- 追加边界用例 ---
test('exact multiple returns full pages', () => {
  assert.equal(pageCount(10, 10), 1);
  assert.equal(pageCount(100, 25), 4);
});

test('single item per page', () => {
  assert.equal(pageCount(1, 1), 1);
  assert.equal(pageCount(7, 1), 7);
});

test('one leftover item adds a page', () => {
  assert.equal(pageCount(1, 10), 1);
  assert.equal(pageCount(101, 100), 2);
});

test('rejects non-integer total', () => {
  assert.throws(() => pageCount(10.5, 10), RangeError);
});

test('rejects non-number input without implicit conversion', () => {
  assert.throws(() => pageCount('10', 10), RangeError);
  assert.throws(() => pageCount(10, '2'), RangeError);
  assert.throws(() => pageCount(10n, 10), RangeError);
});

test('rejects null, undefined and boolean input', () => {
  assert.throws(() => pageCount(null, 10), RangeError);
  assert.throws(() => pageCount(undefined, 10), RangeError);
  assert.throws(() => pageCount(true, 10), RangeError);
});

test('rejects NaN and Infinity', () => {
  assert.throws(() => pageCount(NaN, 10), RangeError);
  assert.throws(() => pageCount(Infinity, 10), RangeError);
  assert.throws(() => pageCount(10, Infinity), RangeError);
});

test('rejects total beyond the safe integer range', () => {
  assert.throws(() => pageCount(9007199254740992, 10), RangeError);
});

test('rejects non-positive pageSize', () => {
  assert.throws(() => pageCount(10, 0), RangeError);
  assert.throws(() => pageCount(10, -3), RangeError);
});

test('large non-trivial division stays exact', () => {
  assert.equal(pageCount(9007199254740991, 3), 3002399751580331);
  assert.equal(pageCount(9007199254740991, 7), 1286742750677285);
});
