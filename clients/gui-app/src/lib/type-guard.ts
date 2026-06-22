/**
 * Builds a type-guard from a `Record<U, true>` membership table. The
 * record key coverage is checked by TypeScript, so adding or removing a
 * union member fails compilation until the table is updated.
 */
export function makeLiteralGuard<U extends string>(
  members: Readonly<Record<U, true>>,
): (value: unknown) => value is U {
  return (value): value is U =>
    typeof value === "string" &&
    Object.prototype.hasOwnProperty.call(members, value);
}
