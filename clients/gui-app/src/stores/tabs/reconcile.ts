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
