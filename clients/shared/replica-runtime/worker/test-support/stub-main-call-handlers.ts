/**
 * The main side's answer to the one worker->main call, for suites whose subject
 * is something else.
 *
 * One construction site rather than a literal per test: `MainCallHandlers`
 * MIRRORS `MainCallMap`, so it grows every time a call is added - and this
 * bridge has already had that map go 0 -> 2 -> 0 -> 1, which would have been
 * four rounds of edits across twenty-one call sites.
 *
 * The default FAILS CLOSED as `queued`, not `dropped` and not a success.
 * `queued` is the arm that means "nothing was lost, ask again" - a stub that
 * answered `ok` would tell the command queue a command had landed on a host,
 * and one that answered `rejected` would carry an authority verdict no
 * authority gave. `boundedRetry: false` because nothing here depends on a host
 * retaining a replay key.
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
        },
      }),
  };
  return { ...base, ...overrides };
}
