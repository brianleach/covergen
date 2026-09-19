/** Called by three of the fixture's four cases, checked by exactly one of them. */
export function applyRate(amount: number, rate: number): number {
  return Math.round(amount * (1 + rate));
}

/** Called only by the case that asserts a literal against itself. */
export function tierFor(amount: number): string {
  if (amount > 1000) {
    return "high";
  }
  return "standard";
}
