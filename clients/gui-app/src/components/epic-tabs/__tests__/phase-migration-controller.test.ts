import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  onTestFinished,
  vi,
} from "vitest";
import { createEmptyCanvas } from "@/stores/epics/canvas/canvas-state";
import {
  resolveTabEpicIdentity,
  useEpicCanvasStore,
} from "@/stores/epics/canvas/store";
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

  it("completePhaseMigration returns false and leaves surfaceMode alone when a listener races the resolution to a different epic first", () => {
    // `execute`'s listeners fire before `applySources`, so this racer wins
    // BEFORE `completePhaseMigration`'s own resolution call ever runs - the
    // pre-commit window (closed since round 1/2). See the pin below for a
    // listener that races the commit itself instead.
    const unsubscribeRace = tabCommandCoordinator.subscribe(() => {
      const current = useEpicCanvasStore.getState().tabsById[PHASE_TAB_ID];
      if (current?.surfaceMode?.kind === "phase-migration") {
        resolveTabEpicIdentity(PHASE_TAB_ID, "phase-1", "epic-racer");
      }
    });

    let completed: boolean | undefined;
    try {
      completed = tabCommandCoordinator.completePhaseMigration({
        tabId: PHASE_TAB_ID,
        phaseId: "phase-1",
        epicId: "epic-created",
      });
    } finally {
      unsubscribeRace();
    }

    expect(completed).toBe(false);
    expect(useEpicCanvasStore.getState().tabsById[PHASE_TAB_ID]).toEqual({
      tabId: PHASE_TAB_ID,
      epicId: "epic-racer",
      name: "Legacy Phase",
      surfaceMode: { kind: "phase-migration", phaseId: "phase-1" },
    });
  });

  it("completePhaseMigration returns false when a raw store subscriber supersedes the resolution DURING its own commit", () => {
    // The round-3 window: `rawPublicSetState` inside `resolveTabEpicIdentity`
    // notifies zustand subscribers SYNCHRONOUSLY, mid-commit - a listener
    // observing the just-landed epicId can call the same authorized action
    // AGAIN before the outer `resolveTabEpicIdentity` call returns to
    // `completePhaseMigration`'s own closure. The precondition passes (the
    // outer write already landed), so a claim recorded at write time would
    // be wrong; the fix reads `getState()` back after `execute()` instead.
    // The listener is self-limiting: it only fires while the tab's epicId
    // still equals the outer target, which stops holding once the racer's
    // own write lands (including on the racer's own re-entrant
    // notification), so this terminates without a manual guard.
    const unsubscribeRace = useEpicCanvasStore.subscribe((state) => {
      if (state.tabsById[PHASE_TAB_ID]?.epicId === "epic-created") {
        resolveTabEpicIdentity(PHASE_TAB_ID, "epic-created", "epic-racer");
      }
    });

    let completed: boolean | undefined;
    try {
      completed = tabCommandCoordinator.completePhaseMigration({
        tabId: PHASE_TAB_ID,
        phaseId: "phase-1",
        epicId: "epic-created",
      });
    } finally {
      unsubscribeRace();
    }

    expect(completed).toBe(false);
    expect(useEpicCanvasStore.getState().tabsById[PHASE_TAB_ID]).toEqual({
      tabId: PHASE_TAB_ID,
      epicId: "epic-racer",
      name: "Legacy Phase",
      surfaceMode: { kind: "phase-migration", phaseId: "phase-1" },
    });
  });

  it("succeed() surfaces as an error (not complete) when a listener races the resolution, and retry routes sanely (no hot-loop)", () => {
    const controller = new PhaseMigrationController();
    const start = vi.fn();
    const completionListener = vi.fn();
    controller.attach(PHASE_TAB_ID, "phase-1", start);
    const unsubscribeCompletion =
      controller.subscribeCompletion(completionListener);
    onTestFinished(unsubscribeCompletion);
    const unsubscribeRace = tabCommandCoordinator.subscribe(() => {
      const current = useEpicCanvasStore.getState().tabsById[PHASE_TAB_ID];
      if (current?.surfaceMode?.kind === "phase-migration") {
        resolveTabEpicIdentity(PHASE_TAB_ID, "phase-1", "epic-racer");
      }
    });
    onTestFinished(unsubscribeRace);

    controller.succeed(PHASE_TAB_ID, "phase-1", 1, "epic-created");

    expect(controller.snapshot(PHASE_TAB_ID)).toMatchObject({
      status: "error",
      errorMessage: "The migrated Epic could not be attached to this tab.",
    });
    expect(completionListener).not.toHaveBeenCalled();
    expect(
      useEpicCanvasStore.getState().tabsById[PHASE_TAB_ID]?.surfaceMode,
    ).toEqual({ kind: "phase-migration", phaseId: "phase-1" });

    // The race already committed the tab to a third epic through the same
    // authorized action, ahead of this migration's own resolution - a real
    // caller can't retry its way back to "phase-1" against that. What
    // matters here is that `retry()` routes into its existing pending/start
    // cycle sanely (same "retries after an error" mechanics as the
    // ordinary-failure pin above) instead of hot-looping or getting stuck.
    controller.retry(PHASE_TAB_ID);

    expect(controller.snapshot(PHASE_TAB_ID)).toMatchObject({
      status: "pending",
      errorMessage: null,
    });
    expect(start.mock.calls).toEqual([[1], [2]]);
    expect(completionListener).not.toHaveBeenCalled();
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
