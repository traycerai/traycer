import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { useLandingDraftStore } from "@/stores/home/landing-draft-store";
import { useTabsStore } from "@/stores/tabs/store";
import type { TabRef } from "@/stores/tabs/types";

// Module state declared first so the cycle `store.ts → reconcile.ts →
// store.ts` (auto-install at store-module load) does not access these
// bindings in their TDZ.
let installed = false;

// Hydration gate. Reconciliation may receive subscription fires from the
// canvas / landing-draft stores before the desktop bridge has finished
// applying its persisted snapshot - applying them too early scrambles the
// strip order with orphan-removal then re-append. While `isReady` is
// false, subscription handlers are dropped; one final reconcile fires
// when the gate opens to capture the post-hydration state.
let isReady = true;

export function setTabsStoreReconciliationReadyPromise(
  readyPromise: Promise<void>,
): void {
  isReady = false;
  void readyPromise.then(() => {
    isReady = true;
    if (installed) {
      reconcileWithSourceStores();
    }
  });
}

/**
 * Test-only escape hatch: reset the hydration gate so a fresh test can
 * call `setTabsStoreReconciliationReadyPromise` without inheriting an
 * already-resolved gate from a previous run.
 */
export function __resetTabsStoreReconciliationReadyForTesting(): void {
  isReady = true;
}

function currentEpicDraftRefs(): ReadonlyArray<TabRef> {
  const canvasState = useEpicCanvasStore.getState();
  const epicRefs = canvasState.openTabOrder.flatMap<TabRef>((tabId) =>
    canvasState.tabsById[tabId] === undefined
      ? []
      : [{ kind: "epic", id: tabId }],
  );
  const draftRefs = useLandingDraftStore
    .getState()
    .drafts.map<TabRef>((draft) => ({ kind: "draft", id: draft.id }));
  return [...epicRefs, ...draftRefs];
}

function refsEqual(a: TabRef, b: TabRef): boolean {
  return a.kind === b.kind && a.id === b.id;
}

function reconcileWithSourceStores(): void {
  const stripOrder = useTabsStore.getState().stripOrder;
  const sourceRefs = currentEpicDraftRefs();
  const validKeys = new Set(sourceRefs.map((ref) => `${ref.kind}:${ref.id}`));

  const filtered = stripOrder.filter((ref) => {
    if (ref.kind === "epic" || ref.kind === "draft") {
      return validKeys.has(`${ref.kind}:${ref.id}`);
    }
    return true;
  });

  const presentKeys = new Set(filtered.map((ref) => `${ref.kind}:${ref.id}`));
  const additions = sourceRefs.filter(
    (ref) => !presentKeys.has(`${ref.kind}:${ref.id}`),
  );
  const next = additions.length === 0 ? filtered : [...filtered, ...additions];
  if (
    next.length === stripOrder.length &&
    next.every((ref, index) => refsEqual(ref, stripOrder[index]))
  ) {
    return;
  }
  useTabsStore.getState().setStripOrder(next);
}

function reconcileCanvasOrderFromStrip(): void {
  const stripOrder = useTabsStore.getState().stripOrder;
  const canvasState = useEpicCanvasStore.getState();
  const openTabOrder = canvasState.openTabOrder;
  if (openTabOrder.length === 0) return;
  const tabIds = new Set(openTabOrder);
  const reordered: string[] = [];
  const consumed = new Set<string>();
  for (const ref of stripOrder) {
    if (ref.kind !== "epic") continue;
    if (!tabIds.has(ref.id)) continue;
    reordered.push(ref.id);
    consumed.add(ref.id);
  }
  for (const tabId of openTabOrder) {
    if (consumed.has(tabId)) continue;
    reordered.push(tabId);
  }
  if (
    reordered.length === openTabOrder.length &&
    reordered.every((tabId, index) => tabId === openTabOrder[index])
  ) {
    return;
  }
  useEpicCanvasStore.setState({ openTabOrder: reordered });
}

export function installTabsStoreReconciliation(): void {
  if (installed) return;
  installed = true;
  if (isReady) reconcileWithSourceStores();
  useEpicCanvasStore.subscribe((next, prev) => {
    if (next.openTabOrder === prev.openTabOrder) return;
    if (isReady) reconcileWithSourceStores();
  });
  useLandingDraftStore.subscribe((next, prev) => {
    if (next.drafts === prev.drafts) return;
    if (isReady) reconcileWithSourceStores();
  });
  useTabsStore.subscribe((next, prev) => {
    if (next.stripOrder === prev.stripOrder) return;
    if (isReady) reconcileCanvasOrderFromStrip();
  });
}
