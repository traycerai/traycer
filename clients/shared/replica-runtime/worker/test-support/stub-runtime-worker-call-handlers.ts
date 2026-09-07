/**
 * The worker's answers before a composition root is installed - nothing available, and a demote refused - for suites whose subject is something else.
 * Written out per call rather than behind a widened type.
 */
import type { RuntimeWorkerCallHandlers } from "../bridge-endpoint";
import { inertMutationResult } from "../bridge-protocol";
import { NO_TRANSFER } from "../transferable-bytes";

export function stubRuntimeWorkerCallHandlers(
  overrides: Partial<RuntimeWorkerCallHandlers>,
): RuntimeWorkerCallHandlers {
  const base: RuntimeWorkerCallHandlers = {
    // Fail-closed, like every other default here: nothing changed, nothing was stamped, nothing retired, and no stamp is the latest.
    // A stub that answered `changed: true` would let a caller's follow-on write run against a mutation that never happened.
    "mutation/apply": (request) =>
      Promise.resolve({
        value: inertMutationResult(request),
        transfer: NO_TRANSFER,
      }),
    // Fail-closed: refused, never a minted id.
    // A stub that answered `enqueued` would hand a caller an id to wait on for a command nothing queued, which is the never-settles hang this call kind exists to avoid.
    "command/enqueue": () =>
      Promise.resolve({
        value: { outcome: "refused" as const },
        transfer: NO_TRANSFER,
      }),
    // Fail-closed for the same reason `command/enqueue` is: `applied: true` from a stub would let a retention decision retire the only copy of a document.
    // Fail-closed: never resolves bytes, and reports nothing cancelled.
    "attachment/await": () =>
      Promise.resolve({ value: { bytes: null }, transfer: NO_TRANSFER }),
    "attachment/cancel": () =>
      Promise.resolve({ value: { cancelled: false }, transfer: NO_TRANSFER }),
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
          awarenessFrames: [],
        },
        transfer: NO_TRANSFER,
      }),
    // Refused, never accepted: an unowned `true` tells the main thread to drop a document whose bytes nothing stored.
    // Refused for the same reason as the demote below: a stub that released would tell the main thread to drop a doc no core is holding.
    "body/release": () =>
      Promise.resolve({
        value: { released: false, reason: "not-held" as const },
        transfer: NO_TRANSFER,
      }),
    "body/demote": () =>
      Promise.resolve({
        value: { accepted: false, settledBytes: 0, reason: "not-held" },
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
