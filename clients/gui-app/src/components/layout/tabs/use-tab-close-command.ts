import { tabRequestClose } from "@/stores/tabs/registry";
import type { HeaderTab } from "@/stores/tabs/types";

/**
 * Pure dispatch: route a `HeaderTab` close to the per-kind descriptor.
 * No UI, no routing, no neighbor pick. The orchestrator
 * (`useCloseTabFlow`) wraps this with the unsynced-edits gate and
 * post-close focus restoration. The returned function is
 * module-stable, so callers can pass it to effect/callback dep arrays
 * without churn.
 */
export function useTabCloseCommand(): (tab: HeaderTab) => void {
  return tabRequestClose;
}
