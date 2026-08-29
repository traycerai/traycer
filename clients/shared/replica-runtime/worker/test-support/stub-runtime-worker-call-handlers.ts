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
import { NO_TRANSFER } from "../transferable-bytes";

export function stubRuntimeWorkerCallHandlers(
  overrides: Partial<RuntimeWorkerCallHandlers>,
): RuntimeWorkerCallHandlers {
  const base: RuntimeWorkerCallHandlers = {
    "attachment/read": () =>
      Promise.resolve({ value: { bytes: null }, transfer: NO_TRANSFER }),
    "body/materialize": () =>
      Promise.resolve({
        value: {
          docKey: null,
          update: null,
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
