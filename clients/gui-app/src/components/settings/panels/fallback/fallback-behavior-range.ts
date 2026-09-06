/**
 * The options a select offers, plus the stored value when it is not one of
 * them.
 *
 * This is the range-render rule, and it exists because the alternative is
 * worse than it looks: a control that silently clamps an out-of-range stored
 * value on LOAD writes a number the user never chose, and does it on a page
 * they only opened to read. So an unexpected value gets an option of its own
 * and stays selected until the user moves the control, at which point they
 * have chosen its replacement.
 *
 * Reachable today only from a programmatic writer or a future default, which
 * is precisely the case where quietly rewriting someone's stored policy would
 * be least defensible.
 *
 * In its own module rather than beside the group that uses it, because
 * `react(only-export-components)` is right here: this is a rule with edge cases
 * worth testing directly (already present, absent, ordering), and exporting it
 * from a `.tsx` both breaks fast refresh for that file and buries a testable
 * rule inside a component module.
 */
export function withStoredNumber(
  options: readonly number[],
  stored: number,
): readonly number[] {
  if (options.includes(stored)) return options;
  return [...options, stored].sort((a, b) => a - b);
}
