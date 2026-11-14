const NBSP = " ";

/** 5000 -> "5 000 F" with non-breaking spaces, so the amount never wraps. Integers only (XOF has no minor unit). */
export function formatXof(n: number): string {
  if (!Number.isSafeInteger(n)) throw new RangeError("XOF amounts are integers");
  return `${String(n).replace(/\B(?=(\d{3})+(?!\d))/g, NBSP)}${NBSP}F`;
}
