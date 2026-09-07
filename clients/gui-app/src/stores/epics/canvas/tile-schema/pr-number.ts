/**
 * The PR-number guard both PR tile parsers apply at the persistence boundary. `typeof value ===
 * "number"` alone admits `NaN`, `±Infinity`, `0`, negatives and fractions.
 */
export function isPersistedPrNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}
