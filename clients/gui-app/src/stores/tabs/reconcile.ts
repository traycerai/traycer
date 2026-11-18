/**
 * Compatibility facade for hydration-gated source reconciliation.
 *
 * The transaction coordinator owns the subscriptions, suppression ledger,
 * source/layout sequencing, and compatibility projection. This module keeps
 * the longstanding import surface used by the Windows bridge and tests.
 */
import { tabCommandCoordinator } from "@/stores/tabs/tab-command-coordinator";

export function setTabsStoreReconciliationReadyPromise(
  readyPromise: Promise<void>,
): void {
  tabCommandCoordinator.setReconciliationReadyPromise(readyPromise);
}

export function __resetTabsStoreReconciliationReadyForTesting(): void {
  tabCommandCoordinator.resetReconciliationForTesting();
}

export function installTabsStoreReconciliation(): void {
  tabCommandCoordinator.installSourceReconciliation();
}
