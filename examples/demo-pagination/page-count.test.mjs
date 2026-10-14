import test from 'node:test';
import assert from 'node:assert/strict';
import { pageCount } from './page-count.mjs';
for (const [total, size, expected] of [[0,10,0],[20,10,2],[21,10,3],[Number.MAX_SAFE_INTEGER,3,3002399751580331]]) {
  test(`pageCount(${total}, ${size})`, () => assert.equal(pageCount(total,size),expected));
}
for (const [total,size] of [[-1,10],[0,0],['20',10],[NaN,10],[1.5,10],[Number.MAX_SAFE_INTEGER+1,10]]) {
  test(`reject ${String(total)}, ${size}`, () => assert.throws(()=>pageCount(total,size),RangeError));
}
