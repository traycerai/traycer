/**
 * Hydration race regression guard for ticket 03.
 *
 * `WindowsBridgeProvider` registers a one-shot hydration promise with
 * the reconciler at module load. Until the promise resolves, the
 * reconciler must NOT mutate `stripOrder` in response to source-store
 * changes - otherwise the persisted strip refs get filtered out before
 * the desktop snapshot's epic / draft data lands, then re-appended in
 * snapshot order, scrambling the user's tab arrangement on restart.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  __resetTabSyncCoordinatorForTesting,
  installTabSyncCoordinator,
} from "@/lib/tab-sync/tab-sync-coordinator";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { createEmptyCanvas } from "@/stores/epics/canvas/canvas-state";
import { useLandingDraftStore } from "@/stores/home/landing-draft-store";
import { useTabsStore } from "@/stores/tabs/store";
import type { TabRef } from "@/stores/tabs/types";

const PERSISTED_REF: TabRef = { kind: "epic", id: "persisted-tab" };
const HYDRATED_REF: TabRef = { kind: "epic", id: "hydrated-tab" };

function resetStores(): void {
  useTabsStore.setState({
    stripOrder: [],
    systemTabs: { history: null, settings: null },
  });
  useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
  useLandingDraftStore.setState({ drafts: [], activeDraftId: null });
  __resetTabSyncCoordinatorForTesting();
}

describe("tabs-store reconciliation hydration gate", () => {
  beforeEach(() => {
    resetStores();
  });

  afterEach(() => {
    resetStores();
  });

  it("preserves persisted strip refs while the gate is closed even if source stores are empty", async () => {
    useTabsStore.setState({
      stripOrder: [PERSISTED_REF],
      systemTabs: { history: null, settings: null },
    });

    let resolveReady: () => void = () => undefined;
    const readyPromise = new Promise<void>((resolve) => {
      resolveReady = resolve;
    });
    installTabSyncCoordinator({ readyPromise });

    // Subscription fire that would normally trigger orphan-removal
    // before hydration completes.
    useEpicCanvasStore.setState({ openTabOrder: [] });
    expect(useTabsStore.getState().stripOrder).toEqual([PERSISTED_REF]);

    // Resolve the gate AFTER landing the projected canvas tab; the
    // post-hydration reconcile keeps the persisted ref and adds the
    // hydrated one.
    useEpicCanvasStore.setState({
      openTabOrder: [PERSISTED_REF.id, HYDRATED_REF.id],
      tabsById: {
        [PERSISTED_REF.id]: {
          tabId: PERSISTED_REF.id,
          epicId: "epic-1",
          name: "Persisted",
        },
        [HYDRATED_REF.id]: {
          tabId: HYDRATED_REF.id,
          epicId: "epic-2",
          name: "Hydrated",
        },
      },
      canvasByTabId: {
        [PERSISTED_REF.id]: createEmptyCanvas(),
        [HYDRATED_REF.id]: createEmptyCanvas(),
      },
    });

    resolveReady();
    await readyPromise;
    await Promise.resolve();

    const finalOrder = useTabsStore.getState().stripOrder;
    expect(finalOrder).toContainEqual(PERSISTED_REF);
    expect(finalOrder).toContainEqual(HYDRATED_REF);
  });

  it("resumes reconciliation after the gate opens", async () => {
    let resolveReady: () => void = () => undefined;
    const readyPromise = new Promise<void>((resolve) => {
      resolveReady = resolve;
    });
    installTabSyncCoordinator({ readyPromise });
    useTabsStore.setState({
      stripOrder: [{ kind: "epic", id: "stale" }],
      systemTabs: { history: null, settings: null },
    });

    resolveReady();
    await readyPromise;
    await Promise.resolve();

    // Post-hydration: with no canvas tabs the reconciler drops the
    // stale ref. (Reconciler runs once when the gate opens.)
    expect(useTabsStore.getState().stripOrder).toEqual([]);
  });
});
