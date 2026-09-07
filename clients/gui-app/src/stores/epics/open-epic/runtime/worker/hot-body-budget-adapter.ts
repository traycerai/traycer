/** `HotBodyBudget` over the runtime's accounting port. ONE accountant. */
import type { EpicRuntimeAccountingPort } from "../epic-runtime-accounting-port";
import type { HotBodyBudget } from "./artifact-body-lease-bridge";

export function createHotBodyBudgetAdapter(
  accounting: EpicRuntimeAccountingPort,
): HotBodyBudget {
  return {
    chargeHot: (docKey, bytes) => {
      // `settleHotDocBytes`, NOT `chargeHotDocProvisional`, and this is not interchangeable.
      accounting.settleHotDocBytes(docKey, bytes);
    },
    settleCold: (docKey, _settledBytes) => {
      // Releases the HOT charge only.
      accounting.releaseHotDoc(docKey);
    },
  };
}
