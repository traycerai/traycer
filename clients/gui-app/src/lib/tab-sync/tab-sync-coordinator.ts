/**
 * Single facade for **hydration-gated reconciliation** of `useTabsStore.stripOrder` against `useEpicCanvasStore.openTabOrder` and `useLandingDraftStore.drafts`.
 * The gate suppresses subscription fires until the desktop bridge's per-window snapshot has been applied at least once.
 */
import {
  __resetTabsStoreReconciliationReadyForTesting,
  installTabsStoreReconciliation,
  setTabsStoreReconciliationReadyPromise,
} from "@/stores/tabs/reconcile";

// ── Reconciliation install ────────────────────────────────────────────────

export interface InstallTabSyncCoordinatorOptions {
  /**
   * Resolves after the desktop bridge's per-window snapshot has been applied.
   * While unresolved, subscription handlers no-op so the persisted strip order is not scrambled by mid-hydration source-store mutations.
   */
  readonly readyPromise: Promise<void>;
}

let installed = false;

export function installTabSyncCoordinator(
  options: InstallTabSyncCoordinatorOptions,
): void {
  if (installed) return;
  installed = true;
  setTabsStoreReconciliationReadyPromise(options.readyPromise);
  installTabsStoreReconciliation();
}

/**
 * Test-only escape hatch.
 * Resets the coordinator's install-once flag **and** the underlying hydration-gate state so tests can re-install with a fresh ready promise.
 */
export function __resetTabSyncCoordinatorForTesting(): void {
  installed = false;
  __resetTabsStoreReconciliationReadyForTesting();
}
