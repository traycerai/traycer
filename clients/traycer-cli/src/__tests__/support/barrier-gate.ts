import { expect } from "vitest";

/**
 * A promise a test resolves by hand, for holding an installer barrier open.
 *
 * Lives outside a `*.test.ts` name on purpose: the workspace's vitest
 * `include` is `src/**‍/__tests__/**‍/*.test.ts`, so this file is importable
 * from tests without being collected as one.
 */
export interface BarrierGate {
  readonly promise: Promise<void>;
  readonly release: () => void;
}

export function makeBarrierGate(): BarrierGate {
  const state: { resolve: (() => void) | null } = { resolve: null };
  const promise = new Promise<void>((resolve) => {
    state.resolve = resolve;
  });
  return { promise, release: () => state.resolve?.() };
}

/**
 * How long `expectStillGated` gives the forbidden event to appear.
 *
 * An UNAWAITED hook lets the work it gates start on the very next microtask,
 * and the sandboxed fixtures these suites use finish their I/O well inside
 * this window, so a dropped `await` is caught. A correctly awaited hook
 * cannot fire the signal at all, whatever the machine's load, so the wait
 * has no false-failure mode - only a false PASS on an absurdly slow box,
 * which is the safe direction for a pin to be wrong in.
 */
export const STAYS_QUIET_MS = 250;

/**
 * Assert `signal` has NOT fired while the caller is holding a barrier open.
 *
 * This is what separates "the hook was awaited" from "the hook was called
 * and its promise dropped on the floor, and the next step merely happened to
 * be slower": both leave an identical ordering array, so an order assertion
 * alone cannot tell them apart. Pass the gate a later step releases, call
 * this while the earlier step is still pending, and only a real `await`
 * survives it.
 */
export async function expectStillGated(
  signal: Promise<void>,
  what: string,
): Promise<void> {
  const raced = await Promise.race([
    signal.then(() => "fired" as const),
    new Promise<"quiet">((resolve) =>
      setTimeout(() => resolve("quiet"), STAYS_QUIET_MS),
    ),
  ]);
  expect(raced, `${what} while the barrier was still pending`).toBe("quiet");
}

/**
 * How long `expectReached` waits for a barrier that SHOULD open. Well above
 * the sandboxed I/O these suites do, and well below vitest's own timeout, so
 * a hook that is never called fails with this function's message instead of
 * an anonymous suite timeout.
 */
export const MUST_REACH_MS = 2_000;

/**
 * Await `signal`, but fail with a named message if it never fires.
 *
 * The mirror of `expectStillGated`, and the reason both exist: a mutation
 * that DELETES a forwarding (rather than dropping its await) leaves the test
 * blocked on a promise nobody will resolve, which surfaces as a bare
 * "test timed out" with no indication of which barrier went missing.
 */
export async function expectReached(
  signal: Promise<void>,
  what: string,
): Promise<void> {
  const raced = await Promise.race([
    signal.then(() => "reached" as const),
    new Promise<"never">((resolve) =>
      setTimeout(() => resolve("never"), MUST_REACH_MS),
    ),
  ]);
  expect(raced, `${what} was never reached`).toBe("reached");
}
