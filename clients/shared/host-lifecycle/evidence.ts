// Evidence algebra for the host lifecycle world probe (plan F10 / annex §1.2).

/**
 * Three-way evidence over a value.
 * Parameterized by the platform's indeterminate cause union so macOS / Windows / Linux keep distinct cause sets (annex design - do not flatten into one shared union).
 */
export type Evidence<T, Cause extends string = string> =
  | { readonly kind: "observed"; readonly value: T }
  | { readonly kind: "absent" }
  | { readonly kind: "indeterminate"; readonly cause: Cause };

export function observed<T, Cause extends string>(
  value: T,
): Evidence<T, Cause> {
  return { kind: "observed", value };
}

export function absent<T, Cause extends string>(): Evidence<T, Cause> {
  return { kind: "absent" };
}

export function indeterminate<T, Cause extends string>(
  cause: Cause,
): Evidence<T, Cause> {
  return { kind: "indeterminate", cause };
}

/**
 * Compile-time exhaustiveness guard for `if`-chain narrowing.
 * Calling this at a terminal fallthrough makes the totality claim mechanical: a new arm stops being assignable to `never` and the build fails at the site that must decide what to do with it.
 */
export function assertNever(value: never, context: string): never {
  throw new Error(`${context}: unhandled union arm ${JSON.stringify(value)}`);
}

/**
 * Versioned durable on-disk record decode verdict.
 * Total over raw shapes - never throws a shape that a caller could read as "absent".
 */
export type DurableRecord<T> =
  | { readonly kind: "valid"; readonly value: T; readonly version: number }
  | { readonly kind: "absent" }
  | { readonly kind: "corrupt" }
  | { readonly kind: "unreadable"; readonly cause: string }
  | { readonly kind: "unsupported-version"; readonly version: number };
