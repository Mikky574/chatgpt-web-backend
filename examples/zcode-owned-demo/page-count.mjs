// pageCount: number of pages needed to hold `total` items at `pageSize` per page.
// Passed validation keeps both operands inside the safe-integer range, so the
// ceiling is computed with BigInt to avoid float rounding at the boundary.

export function pageCount(total, pageSize) {
  if (!Number.isSafeInteger(total) || total < 0) {
    throw new RangeError('total must be a non-negative safe integer');
  }
  if (!Number.isSafeInteger(pageSize) || pageSize <= 0) {
    throw new RangeError('pageSize must be a positive safe integer');
  }
  if (total === 0) return 0;

  const items = BigInt(total);
  const size = BigInt(pageSize);
  return Number((items + size - 1n) / size);
}

export default pageCount;
