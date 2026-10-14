import test from 'node:test';
import assert from 'node:assert/strict';
import { retryDelay } from './retryDelay.mjs';
for (const [attempt, expected] of [[0,1000],[1,2000],[2,4000],[3,8000],[4,10000],[5,10000]]) {
  test(`retryDelay(${attempt}) returns ${expected}`, () => assert.equal(retryDelay(attempt),expected));
}
for (const attempt of [-1,6,1.5,'0',NaN,Infinity,null,undefined]) {
  test(`retryDelay(${String(attempt)}) rejects`, () => assert.throws(()=>retryDelay(attempt),RangeError));
}
