import { tabRequestClose } from "@/stores/tabs/registry";
import { tabCommandCoordinator } from "@/stores/tabs/tab-command-coordinator";
import type { HeaderTab, TabRef } from "@/stores/tabs/types";

function closeTabRef(ref: TabRef): void {
  tabCommandCoordinator.closeRefAfterConfirmed(ref);
}

/**
 * The kind decides whether to close; the coordinator performs it. Handed in
 * here rather than imported by each kind, because the coordinator imports the
 * registry that imports every kind.
 */
export function requestTabClose(tab: HeaderTab): void {
  tabRequestClose(tab, closeTabRef);
}

/**
 * Pure dispatch: route a `HeaderTab` close to the per-kind descriptor.
 * No UI, no routing, no neighbor pick. The orchestrator
 * (`useCloseTabFlow`) wraps this with the unsynced-edits gate and
 * post-close focus restoration. The returned function is
 * module-stable, so callers can pass it to effect/callback dep arrays
 * without churn.
 */
export function useTabCloseCommand(): (tab: HeaderTab) => void {
  return requestTabClose;
}
