/**
 * The main side's answers to the two worker->main calls, for suites whose
 * subject is something else.
 *
 * One construction site rather than a literal per test, and that is the whole
 * point: {@link MainCallHandlers} MIRRORS `MainCallMap`, so it grows every time
 * a main call is added - and a literal in each of the sixteen places that build
 * a main endpoint would mean sixteen compile errors for one protocol change.
 * The same lesson `stubCore` already carries on the other direction: collapse
 * the mirrors into one site so the next member fails once, in a place that
 * names it.
 *
 * The defaults FAIL CLOSED, and neither is arbitrary:
 *
 *   - `network-error` for a revalidate, because it is the one outcome that
 *     changes nothing. `rotated` would tell a transport its credential is
 *     current and send it back to dial with the same dead bearer; `rejected`
 *     asserts the revalidator has already SIGNED THE USER OUT, which a stub has
 *     certainly not done. `network-error` says "ask again later", which is
 *     exactly what a stub that answered nothing has earned.
 *   - `unavailable` for a mint, because it is the designed no-credential
 *     fallback: the host stays on the connection's client lease. The tempting
 *     `pending-elsewhere` would be a lie with a consequence - it tells the
 *     transport a credential is already in flight and arms a retry timer for a
 *     claim that does not exist.
 */
import type { MainCallHandlers } from "../bridge-endpoint";

export function stubMainCallHandlers(
  overrides: Partial<MainCallHandlers>,
): MainCallHandlers {
  const base: MainCallHandlers = {
    "main/auth-revalidate": () => Promise.resolve({ outcome: "network-error" }),
    "main/mint-credential": () =>
      Promise.resolve({ outcome: { kind: "unavailable" } }),
  };
  return { ...base, ...overrides };
}
