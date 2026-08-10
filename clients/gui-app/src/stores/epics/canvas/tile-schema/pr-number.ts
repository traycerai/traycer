/**
 * The PR-number guard both PR tile parsers apply at the persistence boundary.
 *
 * `typeof value === "number"` alone admits `NaN`, `±Infinity`, `0`, negatives
 * and fractions. Every PR tile id builder interpolates the number with
 * `String(...)`, so a corrupted persisted record restores a tile whose id
 * names a pull request that cannot exist - it renders, subscribes, and can
 * only ever report "not found". The wire schema already states the real
 * domain (`prBaseCoordinatesSchema` is `z.number().int().positive()`); this is
 * the same rule on the side that reads back from disk, which no schema guards.
 *
 * Rejecting here drops only records that were already unusable: a tile written
 * by any released build carries a number GitHub itself issued, which is a
 * positive integer by construction.
 */
export function isPersistedPrNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}
