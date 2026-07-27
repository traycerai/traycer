import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { phaseMigrationController } from "@/components/epic-tabs/phase-migration-controller";
import { duplicateEpicTab } from "@/lib/commands/actions/duplicate-tab";
import { createEmptyCanvas } from "@/stores/epics/canvas/canvas-state";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { tabCommandCoordinator } from "@/stores/tabs/tab-command-coordinator";
import { useTabsStore } from "@/stores/tabs/store";
import { useHeaderTabs } from "@/stores/tabs/use-header-tabs";
import type { TabRef } from "@/stores/tabs/types";

const PHASE_REF: TabRef = { kind: "epic", id: "phase-tab" };
const PARTNER_REF: TabRef = { kind: "epic", id: "partner-tab" };

function resetState(): void {
  phaseMigrationController.resetForTesting();
  useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
  useTabsStore.setState({
    version: 2,
    items: [],
    activeItemId: null,
    stripOrder: [],
    systemTabs: { history: null, settings: null },
  });
  tabCommandCoordinator.resetReconciliationForTesting();
}

function seedFlatPhase(): void {
  useEpicCanvasStore.setState({
    tabsById: {
      [PHASE_REF.id]: {
        tabId: PHASE_REF.id,
        epicId: "phase-1",
        name: "Legacy Phase",
        surfaceMode: { kind: "phase-migration", phaseId: "phase-1" },
      },
      [PARTNER_REF.id]: {
        tabId: PARTNER_REF.id,
        epicId: "epic-partner",
        name: "Partner",
      },
    },
    canvasByTabId: {
      [PHASE_REF.id]: createEmptyCanvas(),
      [PARTNER_REF.id]: createEmptyCanvas(),
    },
    openTabOrder: [PHASE_REF.id, PARTNER_REF.id],
    activeTabId: PHASE_REF.id,
    mostRecentTabIdByEpicId: {
      "phase-1": PHASE_REF.id,
      "epic-partner": PARTNER_REF.id,
    },
  });
  useTabsStore.setState({
    version: 2,
    items: [
      { kind: "tab", id: "tab:epic:phase-tab", ref: PHASE_REF },
      { kind: "tab", id: "tab:epic:partner-tab", ref: PARTNER_REF },
    ],
    activeItemId: "tab:epic:phase-tab",
    stripOrder: [PHASE_REF, PARTNER_REF],
    systemTabs: { history: null, settings: null },
  });
}

function seedSplitPhase(): void {
  seedFlatPhase();
  useTabsStore.setState({
    version: 2,
    items: [
      {
        kind: "split",
        id: "phase-split",
        left: { kind: "tab", ref: PHASE_REF },
        right: { kind: "tab", ref: PARTNER_REF },
        focusedSide: "left",
        routeBackingSide: "left",
        leftRatio: 0.5,
      },
    ],
    activeItemId: "phase-split",
    stripOrder: [PHASE_REF, PARTNER_REF],
    systemTabs: { history: null, settings: null },
  });
}

function startPending(): void {
  phaseMigrationController.attach(PHASE_REF.id, "phase-1", () => undefined);
}

function failPending(): void {
  phaseMigrationController.fail(PHASE_REF.id, "phase-1", 1, "failed");
}

function completePending(): void {
  phaseMigrationController.succeed(PHASE_REF.id, "phase-1", 1, "epic-created");
}

describe("Phase migration structural lock", () => {
  beforeEach(resetState);
  afterEach(resetState);

  it("refuses close while pending and allows it after error and completion", () => {
    seedFlatPhase();
    startPending();
    expect(tabCommandCoordinator.closeRef(PHASE_REF)).toBe(false);

    act(() => failPending());
    expect(tabCommandCoordinator.closeRef(PHASE_REF)).toBe(true);
    expect(useEpicCanvasStore.getState().openTabOrder).not.toContain(
      PHASE_REF.id,
    );

    resetState();
    seedFlatPhase();
    startPending();
    completePending();
    expect(tabCommandCoordinator.closeRef(PHASE_REF)).toBe(true);
  });

  it("refuses duplicate while the surface remains in Phase mode and allows it after conversion", () => {
    seedFlatPhase();
    startPending();
    expect(duplicateEpicTab(PHASE_REF.id)).toBeNull();

    failPending();
    expect(duplicateEpicTab(PHASE_REF.id)).toBeNull();

    resetState();
    seedFlatPhase();
    startPending();
    completePending();
    expect(duplicateEpicTab(PHASE_REF.id)?.tabId).toBeTruthy();
  });

  it("refuses pair and edge split until conversion", () => {
    seedFlatPhase();
    startPending();
    useTabsStore.getState().pair({
      left: PHASE_REF,
      right: PARTNER_REF,
      splitId: "blocked-pair",
      leftRatio: 0.5,
    });
    expect(useTabsStore.getState().items).toHaveLength(2);
    expect(
      tabCommandCoordinator.createEmptySplit({
        ref: PHASE_REF,
        splitId: "blocked-edge",
        populatedSide: "left",
        focusedSide: "left",
        leftRatio: 0.5,
      }),
    ).toBe(false);

    failPending();
    useTabsStore.getState().pair({
      left: PHASE_REF,
      right: PARTNER_REF,
      splitId: "still-blocked-pair",
      leftRatio: 0.5,
    });
    expect(useTabsStore.getState().items).toHaveLength(2);
    expect(
      tabCommandCoordinator.createEmptySplit({
        ref: PHASE_REF,
        splitId: "still-blocked-edge",
        populatedSide: "left",
        focusedSide: "left",
        leftRatio: 0.5,
      }),
    ).toBe(false);

    resetState();
    seedFlatPhase();
    startPending();
    completePending();
    useTabsStore.getState().pair({
      left: PHASE_REF,
      right: PARTNER_REF,
      splitId: "allowed-pair",
      leftRatio: 0.5,
    });
    expect(useTabsStore.getState().items).toHaveLength(1);

    resetState();
    seedFlatPhase();
    startPending();
    completePending();
    expect(
      tabCommandCoordinator.createEmptySplit({
        ref: PHASE_REF,
        splitId: "allowed-edge",
        populatedSide: "left",
        focusedSide: "left",
        leftRatio: 0.5,
      }),
    ).toBe(true);
  });

  it("refuses reorder, separation, move, and drop until conversion", () => {
    seedSplitPhase();
    startPending();
    useTabsStore.getState().moveRef(PHASE_REF, 2);
    expect(useTabsStore.getState().items[0]?.kind).toBe("split");
    expect(tabCommandCoordinator.separateBeforeMove(PARTNER_REF)).toEqual({
      separated: false,
      splitId: null,
    });
    expect(tabCommandCoordinator.removeMovedRef(PHASE_REF)).toBe(false);
    useTabsStore.getState().dropRef(PHASE_REF);
    expect(useTabsStore.getState().stripOrder).toContainEqual(PHASE_REF);
    useEpicCanvasStore.getState().moveOpenTab(PHASE_REF.id, 1);
    expect(useEpicCanvasStore.getState().openTabOrder).toEqual([
      PHASE_REF.id,
      PARTNER_REF.id,
    ]);

    failPending();
    expect(tabCommandCoordinator.separateBeforeMove(PHASE_REF)).toEqual({
      separated: false,
      splitId: null,
    });
    useTabsStore.getState().moveRef(PHASE_REF, 2);
    expect(useTabsStore.getState().items[0]?.kind).toBe("split");
    expect(tabCommandCoordinator.removeMovedRef(PHASE_REF)).toBe(false);
    useTabsStore.getState().dropRef(PHASE_REF);
    expect(useTabsStore.getState().stripOrder).toContainEqual(PHASE_REF);
    useEpicCanvasStore.getState().moveOpenTab(PHASE_REF.id, 1);
    expect(useEpicCanvasStore.getState().openTabOrder).toEqual([
      PHASE_REF.id,
      PARTNER_REF.id,
    ]);

    resetState();
    seedSplitPhase();
    startPending();
    completePending();
    expect(tabCommandCoordinator.separateBeforeMove(PHASE_REF)).toEqual({
      separated: true,
      splitId: "phase-split",
    });
    expect(tabCommandCoordinator.removeMovedRef(PHASE_REF)).toBe(true);
  });

  it("leaves a non-migration ref byte-for-byte unaffected", () => {
    seedFlatPhase();
    startPending();
    const before = useTabsStore.getState().items;

    expect(
      tabCommandCoordinator.createEmptySplit({
        ref: PARTNER_REF,
        splitId: "partner-edge",
        populatedSide: "left",
        focusedSide: "left",
        leftRatio: 0.5,
      }),
    ).toBe(true);

    expect(before).toHaveLength(2);
    expect(useTabsStore.getState().items).toEqual([
      {
        kind: "tab",
        id: "tab:epic:phase-tab",
        ref: PHASE_REF,
      },
      {
        kind: "split",
        id: "partner-edge",
        left: { kind: "tab", ref: PARTNER_REF },
        right: { kind: "empty" },
        focusedSide: "left",
        routeBackingSide: "left",
        leftRatio: 0.5,
      },
    ]);
  });

  it("keeps an unlocked Epic HeaderTab cached across another ref's lock churn", () => {
    seedFlatPhase();
    startPending();
    const { result } = renderHook(() => useHeaderTabs());
    const before = result.current.find((tab) => tab.id === PARTNER_REF.id);

    act(() => failPending());

    expect(result.current.find((tab) => tab.id === PARTNER_REF.id)).toBe(
      before,
    );
  });
});
