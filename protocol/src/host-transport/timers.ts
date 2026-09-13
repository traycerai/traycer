/**
 * Cross-platform timer handles for the host transport.
 *
 * This source is compiled under two different tsconfigs: the renderer builds it
 * with a DOM-only lib (no `@types/node`), where `setTimeout` returns `number`;
 * the CLI/host build it with Node types, where it returns `NodeJS.Timeout`.
 * Inferring the platform's return type keeps both builds happy without naming
 * the `NodeJS` namespace (which is absent in the browser build).
 *
 * Expressed as an `infer` conditional rather than `ReturnType<typeof setTimeout>`
 * so the repo's type-safety lint passes without an `eslint-disable` - there is
 * no single concrete type to write here, since the handle type is genuinely
 * platform-dependent. The parameter list mirrors the standard-library
 * `ReturnType` definition (`(...args: any) => infer R`); a narrower `never[]`
 * fails to match Node's *overloaded* `setTimeout`/`setInterval` and collapses to
 * `never`.
 */
export type TimerHandle = typeof setTimeout extends (
  ...args: any[]
) => infer Handle
  ? Handle
  : never;

export type IntervalHandle = typeof setInterval extends (
  ...args: any[]
) => infer Handle
  ? Handle
  : never;
