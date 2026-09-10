/**
 * What counts as a pid decoded from an on-disk record.
 *
 * Its own module, with no imports, for one practical reason: both record
 * readers need it, and several suites replace `./pid-metadata` with a factory
 * that does not spread the original. A predicate exported from either reader
 * would be `undefined` inside the other the moment such a suite loaded it -
 * the same mocking seam that has already broken this package's install suite
 * once. A leaf nobody mocks cannot be hollowed out.
 */

/**
 * Whether a decoded `pid` field names a process this CLI may ask the OS about.
 *
 * `typeof value === "number"` is not that test, and the gap is not cosmetic:
 * `process.kill`'s first argument is a pid ONLY when it is positive. Zero
 * addresses the CALLER'S OWN process group and a negative number addresses the
 * group named by its magnitude, so a truncated or hand-edited record carrying
 * `0` or `-1` makes every liveness reader answer "alive" - about itself - and a
 * record that is malformed is then read as a running host. `NaN` and a
 * fractional pid are the same class of nonsense, and `Number.isInteger`
 * rejects both.
 *
 * Shared by `pid.json` and `holder.json` so one file's worth of corruption
 * cannot be malformed to one record reader and a live writer to the other -
 * the two carry the same field and are cleared by the same liveness rule.
 */
export function isReadablePid(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}
