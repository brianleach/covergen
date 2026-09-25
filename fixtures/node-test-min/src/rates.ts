/** Covered by the fixture spec. */
export function applyRate(amount: number, rate: number): number {
  return Math.round(amount * (1 + rate));
}

/** Deliberately uncovered: the segment covergen is expected to find. */
export function refundFee(amount: number, days: number): number {
  if (days > 30) {
    return 0;
  }
  if (amount > 1000) {
    return Math.round(amount * 0.05);
  }
  return 25;
}
