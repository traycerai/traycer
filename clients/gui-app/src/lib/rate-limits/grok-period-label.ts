import { namedCadenceForDuration } from "@/lib/rate-limits/window-duration-cadence";

/**
 * What to call Grok's billing period, in the order the sources deserve to be
 * trusted.
 *
 * 1. **Its duration, when that duration NAMES a cadence** (`5h`, a day, a week,
 *    a calendar month). Typed data that cannot break on an upstream rename, and
 *    the same source every other provider's window is named from.
 * 2. **The known period types**, for a period whose length is absent or is a
 *    number of days with no name — a 14-day period reported as `WEEKLY` is
 *    better described by the type than by `14d`. Values nobody has seen do not
 *    reach the user.
 * 3. **The duration as a plain count**, when there is one and the type meant
 *    nothing: `14d` still tells the user more than the generic noun.
 * 4. **A neutral word.** Never the raw token: `100% USAGE_PERIOD_TYPE_WEEKLY`
 *    is what shipped before this, and it is not English.
 *
 * The cadence gate on step 1 is what keeps the table alive. A calendar month is
 * 28–31 days, so a duration trusted unconditionally would render a monthly
 * period as `31d` in January and `28d` in February — a label that changes month
 * to month for a cadence that does not, with the table entry that knows the
 * right word never consulted.
 *
 * **All three vocabularies are the caller's**, because the two surfaces asking
 * this question have different room for the answer: the strip says `wk` and
 * `mo` beside `[5h] [wk]` chips, the provider page says `Weekly` in a row of
 * sentences. Injecting only the duration formatter would put the page's prose
 * on the strip by the table's back door. What this module owns is the ORDER,
 * which is the one thing the two surfaces must not disagree about.
 */
export function grokPeriodLabel(params: {
  readonly durationMinutes: number | null;
  readonly periodType: string | null;
  readonly formatDuration: (minutes: number) => string;
  readonly periodTypeLabels: ReadonlyMap<string, string>;
  readonly fallbackLabel: string;
}): string {
  const { durationMinutes, periodType } = params;
  const measured = durationMinutes !== null && durationMinutes > 0;
  if (measured && namedCadenceForDuration(durationMinutes) !== null) {
    return params.formatDuration(durationMinutes);
  }
  const named =
    periodType === null ? undefined : params.periodTypeLabels.get(periodType);
  if (named !== undefined) return named;
  if (measured) return params.formatDuration(durationMinutes);
  return params.fallbackLabel;
}
