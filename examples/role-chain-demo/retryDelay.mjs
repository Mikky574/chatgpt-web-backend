export function retryDelay(attempt) {
  if (!Number.isInteger(attempt) || attempt < 0 || attempt > 5) throw new RangeError('attempt must be an integer in 0..5');
  return Math.min(1000 * 2 ** attempt, 10000);
}
