/**
 * The main side's answers to the worker->main calls, for suites whose subject
 * is something else.
 *
 * One construction site rather than a literal per test: `MainCallHandlers`
 * MIRRORS `MainCallMap`, so it grows every time a call is added - and this
 * bridge has already had that map go 0 -> 2 -> 0 -> 1 -> 2, which would have
 * been five rounds of edits across twenty-one call sites.
 *
 * Both defaults FAIL CLOSED, and each in the vocabulary its own caller acts on.
 *
 * The write command answers `queued`, not `dropped` and not a success.
 * `queued` is the arm that means "nothing was lost, ask again" - a stub that
 * answered `ok` would tell the command queue a command had landed on a host,
 * and one that answered `rejected` would carry an authority verdict no
 * authority gave. `boundedRetry: false` because nothing here depends on a host
 * retaining a replay key.
 *
 * The lane unary answers a REFUSAL rather than a synthesised context, for the
 * reason the worker's own wrapper rejects instead of returning an empty one: a
 * fabricated workspace context would be PROJECTED into `snapshotMeta` as
 * authoritative, so a suite that never meant to exercise this read would
 * silently assert against invented repos and folders. A refusal is retried by
 * the policy's next trigger and asserts nothing.
 */
import type { MainCallHandlers } from "../bridge-endpoint";

export function stubMainCallHandlers(
  overrides: Partial<MainCallHandlers>,
): MainCallHandlers {
  const base: MainCallHandlers = {
    "main/write-command": () =>
      Promise.resolve({
        ok: false,
        failure: {
          kind: "queued",
          reason: "no write transport in this fixture",
          boundedRetry: false,
          retryAfterMs: null,
        },
      }),
    "main/lane-unary": () =>
      Promise.resolve({
        ok: false,
        reason: "no lane unary transport in this fixture",
      }),
  };
  return { ...base, ...overrides };
}
