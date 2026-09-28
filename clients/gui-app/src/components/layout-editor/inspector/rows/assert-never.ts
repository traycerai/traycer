/**
 * The closing case of a switch over a closed union.
 *
 * Both switches in this folder - the grammar row kind and the order group -
 * return `ReactNode`, which INCLUDES `undefined`, so falling off the end of
 * either is something TypeScript accepts in silence: a member added later
 * would render nothing and say nothing (G1-22). Shared by the two rather than
 * written twice, and kept to this folder rather than made an app-wide helper,
 * which is the same shape the three other `assertNever`s in this app take.
 */
export function assertNever(value: never): never {
  throw new Error(`unhandled layout section member: ${JSON.stringify(value)}`);
}
