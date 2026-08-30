/**
 * The worker's answers before a composition root is installed - nothing
 * available, and a demote REFUSED - for suites whose subject is something else.
 *
 * It moved here from `bridge-endpoint.test.ts` when a second suite needed to
 * stand up a real worker endpoint. A copy in each suite is how two "identical"
 * fixtures come to disagree about what a no-core worker answers, which then
 * reads as a behavioural difference between the things under test.
 *
 * Written out per call rather than behind a widened type. The map is required
 * to be total on purpose - a call added to the protocol without a handler is
 * meant to stop the build - and a `Partial` base would turn that guarantee off
 * for every suite that reached for this helper.
 */
import type { RuntimeWorkerCallHandlers } from "../bridge-endpoint";
import { inertMutationResult } from "../bridge-protocol";
import { NO_TRANSFER } from "../transferable-bytes";

export function stubRuntimeWorkerCallHandlers(
  overrides: Partial<RuntimeWorkerCallHandlers>,
): RuntimeWorkerCallHandlers {
  const base: RuntimeWorkerCallHandlers = {
    // FAIL-CLOSED, like every other default here: nothing changed, nothing was
    // stamped, nothing retired, and no stamp is the latest. A stub that
    // answered `changed: true` would let a caller's follow-on write run
    // against a mutation that never happened.
    "mutation/apply": (request) =>
      Promise.resolve({
        value: inertMutationResult(request),
        transfer: NO_TRANSFER,
      }),
    // FAIL-CLOSED: refused, never a minted id. A stub that answered
    // `enqueued` would hand a caller an id to wait on for a command nothing
    // queued, which is the never-settles hang this call kind exists to avoid.
    "command/enqueue": () =>
      Promise.resolve({
        value: { outcome: "refused" as const },
        transfer: NO_TRANSFER,
      }),
    // Fail-closed for the same reason `command/enqueue` is: `applied: true`
    // from a stub would let a retention decision retire the only copy of a
    // document.
    "root/encode": () =>
      Promise.resolve({
        value: { update: new Uint8Array() },
        transfer: NO_TRANSFER,
      }),
    "root/apply": () =>
      Promise.resolve({ value: { applied: false }, transfer: NO_TRANSFER }),
    "attachment/read": () =>
      Promise.resolve({ value: { bytes: null }, transfer: NO_TRANSFER }),
    "body/materialize": () =>
      Promise.resolve({
        value: {
          docKey: null,
          update: null,
          docGuid: null,
          seedMode: "full",
          hostStateVector: null,
        },
        transfer: NO_TRANSFER,
      }),
    // Refused, never accepted: an unowned `true` tells the main thread to drop
    // a document whose bytes nothing stored.
    "body/demote": () =>
      Promise.resolve({
        value: { accepted: false, settledBytes: 0 },
        transfer: NO_TRANSFER,
      }),
    "body/update": () =>
      Promise.resolve({
        value: {
          outcome: { kind: "dropped", reason: "no runtime in this fixture" },
        },
        transfer: NO_TRANSFER,
      }),
  };
  return { ...base, ...overrides };
}
