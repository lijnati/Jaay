const NBSP = " ";

/** 6250000 -> "6 250 000" with non-breaking spaces, so a number never wraps. Shared with the customer simulator. */
export const groupDigits = (n: number | bigint | string): string => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, NBSP);

/** 5000 -> "5 000 F" with non-breaking spaces, so the amount never wraps. Integers only (XOF has no minor unit). */
export function formatXof(n: number): string {
  if (!Number.isSafeInteger(n)) throw new RangeError("XOF amounts are integers");
  return `${groupDigits(n)}${NBSP}F`;
}
