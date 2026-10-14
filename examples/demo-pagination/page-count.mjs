export function pageCount(total, pageSize) {
  if (!Number.isSafeInteger(total) || total < 0 || !Number.isSafeInteger(pageSize) || pageSize <= 0) throw new RangeError('Invalid pagination input');
  return Math.ceil(total / pageSize);
}
