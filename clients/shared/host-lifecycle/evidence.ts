// Evidence algebra for the host lifecycle world probe (plan F10 / annex §1.2).
//
// Every external boundary is total over three outcomes. Callers must never
// collapse `indeterminate` into a boolean that looks like "absent" or a
// concrete value — that is the failure mode the annexes enumerate in
// today's controllers (launchctl non-zero → not-loaded, schtasks error →
// not-installed, login-item throw → not-registered).

/**
 * Three-way evidence over a value. Parameterized by the platform's
 * indeterminate cause union so macOS / Windows / Linux keep distinct cause
 * sets (annex design — do not flatten into one shared union).
 */
export type Evidence<T, Cause extends string = string> =
  | { readonly kind: "observed"; readonly value: T }
  | { readonly kind: "absent" }
  | { readonly kind: "indeterminate"; readonly cause: Cause };

/** Construct `observed`. */
export function observed<T, Cause extends string>(
  value: T,
): Evidence<T, Cause> {
  return { kind: "observed", value };
}

/** Construct `absent`. */
export function absent<T, Cause extends string>(): Evidence<T, Cause> {
  return { kind: "absent" };
}

/** Construct `indeterminate(cause)`. */
export function indeterminate<T, Cause extends string>(
  cause: Cause,
): Evidence<T, Cause> {
  return { kind: "indeterminate", cause };
}

/**
 * Compile-time exhaustiveness guard for `if`-chain narrowing.
 *
 * TypeScript checks `switch` exhaustiveness but not `if` chains, and this
 * module is almost entirely `if` chains over discriminated unions. Adding an
 * arm to `ProcessTreeScan` / `PidAttestation` / `Evidence` therefore compiled
 * clean and routed silently into whichever branch happened to be last — with
 * `planKill` and `attestRecordedPid`, into the exact branches whose comments
 * warn against it. Calling this at a terminal fallthrough makes the totality
 * claim mechanical: a new arm stops being assignable to `never` and the build
 * fails at the site that must decide what to do with it.
 *
 * The throw is unreachable by construction; it exists so a value that slipped
 * past the type system at runtime (untyped JSON, a version skew across a
 * package boundary) is loud rather than silently mis-planned.
 */
export function assertNever(value: never, context: string): never {
  throw new Error(`${context}: unhandled union arm ${JSON.stringify(value)}`);
}

/**
 * Versioned durable on-disk record decode verdict.
 * Total over raw shapes — never throws a shape that a caller could read as
 * "absent". Each arm is a distinct planner input.
 */
export type DurableRecord<T> =
  | { readonly kind: "valid"; readonly value: T; readonly version: number }
  | { readonly kind: "absent" }
  | { readonly kind: "corrupt" }
  | { readonly kind: "unreadable"; readonly cause: string }
  | { readonly kind: "unsupported-version"; readonly version: number };
