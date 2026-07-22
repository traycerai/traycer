import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createEmptyCanvas } from "@/stores/epics/canvas/canvas-state";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { tabCommandCoordinator } from "@/stores/tabs/tab-command-coordinator";
import { useTabsStore } from "@/stores/tabs/store";
import { PhaseMigrationController } from "@/components/epic-tabs/phase-migration-controller";

const PHASE_TAB_ID = "phase-tab";
const PARTNER_TAB_ID = "partner-tab";

function resetState(): void {
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

function seedPendingSplit(): void {
  useEpicCanvasStore.setState({
    tabsById: {
      [PHASE_TAB_ID]: {
        tabId: PHASE_TAB_ID,
        epicId: "phase-1",
        name: "Legacy Phase",
        surfaceMode: { kind: "phase-migration", phaseId: "phase-1" },
      },
      [PARTNER_TAB_ID]: {
        tabId: PARTNER_TAB_ID,
        epicId: "epic-partner",
        name: "Partner",
      },
    },
    canvasByTabId: {
      [PHASE_TAB_ID]: createEmptyCanvas(),
      [PARTNER_TAB_ID]: createEmptyCanvas(),
    },
    openTabOrder: [PHASE_TAB_ID, PARTNER_TAB_ID],
    activeTabId: PARTNER_TAB_ID,
    mostRecentTabIdByEpicId: {
      "phase-1": PHASE_TAB_ID,
      "epic-partner": PARTNER_TAB_ID,
    },
  });
  useTabsStore.setState({
    version: 2,
    items: [
      {
        kind: "split",
        id: "phase-split",
        left: { kind: "tab", ref: { kind: "epic", id: PHASE_TAB_ID } },
        right: { kind: "tab", ref: { kind: "epic", id: PARTNER_TAB_ID } },
        focusedSide: "right",
        routeBackingSide: "right",
        leftRatio: 0.37,
      },
    ],
    activeItemId: "phase-split",
    stripOrder: [
      { kind: "epic", id: PHASE_TAB_ID },
      { kind: "epic", id: PARTNER_TAB_ID },
    ],
    systemTabs: { history: null, settings: null },
  });
}

describe("PhaseMigrationController", () => {
  beforeEach(() => {
    resetState();
    seedPendingSplit();
  });

  afterEach(() => {
    resetState();
  });

  it("starts one mutation per exact ref across runner detach and reattach", () => {
    const controller = new PhaseMigrationController();
    const firstStart = vi.fn();
    const secondStart = vi.fn();

    const detach = controller.attach(PHASE_TAB_ID, "phase-1", firstStart);
    detach();
    controller.attach(PHASE_TAB_ID, "phase-1", secondStart);

    expect(firstStart).toHaveBeenCalledTimes(1);
    expect(firstStart).toHaveBeenLastCalledWith(1);
    expect(secondStart).not.toHaveBeenCalled();
    expect(controller.snapshot(PHASE_TAB_ID)).toMatchObject({
      status: "pending",
      phaseId: "phase-1",
    });
  });

  it("reuses one exact migration ref for repeated Phase openers", () => {
    resetState();

    const first = tabCommandCoordinator.activateTab({
      kind: "phase-migration",
      phaseId: "phase-1",
      name: "Legacy Phase",
    });
    const second = tabCommandCoordinator.activateTab({
      kind: "phase-migration",
      phaseId: "phase-1",
      name: "Legacy Phase",
    });

    expect(first?.ref).toEqual(second?.ref);
    expect(Object.values(useEpicCanvasStore.getState().tabsById)).toEqual([
      {
        tabId: first?.ref.id,
        epicId: "phase-1",
        name: "Legacy Phase",
        surfaceMode: { kind: "phase-migration", phaseId: "phase-1" },
      },
    ]);
  });

  it("retries after an error and converts the same split member in place", () => {
    const controller = new PhaseMigrationController();
    const start = vi.fn();
    controller.attach(PHASE_TAB_ID, "phase-1", start);

    controller.fail(PHASE_TAB_ID, "phase-1", 1, "migration failed");
    expect(controller.snapshot(PHASE_TAB_ID)).toMatchObject({
      status: "error",
      errorMessage: "migration failed",
    });

    controller.retry(PHASE_TAB_ID);
    controller.succeed(PHASE_TAB_ID, "phase-1", 2, "epic-created");

    expect(start.mock.calls).toEqual([[1], [2]]);
    expect(useEpicCanvasStore.getState().tabsById[PHASE_TAB_ID]).toEqual({
      tabId: PHASE_TAB_ID,
      epicId: "epic-created",
      name: "Legacy Phase",
      surfaceMode: { kind: "epic" },
    });
    expect(useTabsStore.getState().items).toEqual([
      {
        kind: "split",
        id: "phase-split",
        left: { kind: "tab", ref: { kind: "epic", id: PHASE_TAB_ID } },
        right: { kind: "tab", ref: { kind: "epic", id: PARTNER_TAB_ID } },
        focusedSide: "right",
        routeBackingSide: "right",
        leftRatio: 0.37,
      },
    ]);
    expect(useEpicCanvasStore.getState().activeTabId).toBe(PARTNER_TAB_ID);
  });

  it("clears migration mode when the migrated Epic keeps the Phase id", () => {
    const controller = new PhaseMigrationController();
    controller.attach(PHASE_TAB_ID, "phase-1", () => undefined);

    controller.succeed(PHASE_TAB_ID, "phase-1", 1, "phase-1");

    expect(useEpicCanvasStore.getState().tabsById[PHASE_TAB_ID]).toEqual({
      tabId: PHASE_TAB_ID,
      epicId: "phase-1",
      name: "Legacy Phase",
      surfaceMode: { kind: "epic" },
    });
  });
});
