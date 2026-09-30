/**
 * Reopening a closed task through the real stores and the real command
 * coordinator: the task has to come back with the tiles it had open. Only the
 * host projection that says whether a tile's record is still live is faked;
 * `reopen.test.ts` covers the surrounding decisions with everything mocked.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { KeybindingRouter } from "@/lib/keybindings/dispatch";
import { useTabRecoveryHistory } from "@/lib/tab-recovery/history";
import { reopenClosedTab } from "@/lib/tab-recovery/reopen";
import {
  CHAT_A,
  SPEC_A,
  pane,
} from "@/stores/epics/canvas/__tests__/canvas-test-fixtures";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import type {
  EpicCanvasState,
  EpicCanvasTileRef,
  EpicNodeRef,
} from "@/stores/epics/canvas/types";
import { useTabsStore } from "@/stores/tabs/store";
import { tabCommandCoordinator } from "@/stores/tabs/tab-command-coordinator";
import { seedActiveEpicTabInTabsStore } from "@/stores/tabs/test-support/tabs-store-fixtures";

const mocks = vi.hoisted(() => ({
  tileRecordIsLive: vi.fn<(instanceId: string) => boolean>(),
}));

vi.mock("@/lib/commands/actions/history-navigation", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@/lib/commands/actions/history-navigation")
    >();
  return {
    ...actual,
    preservedTileRecordIsLive: (preserved: {
      readonly node: EpicCanvasTileRef;
    }) => mocks.tileRecordIsLive(preserved.node.instanceId),
  };
});

const router: KeybindingRouter = {
  getPathname: () => "/",
  navigateHome: () => undefined,
  navigateSettings: () => undefined,
  navigateToEpic: () => undefined,
  navigateToEpicTab: () => undefined,
  navigateToEpicList: () => undefined,
  navigateSettingsSection: () => undefined,
  navigateToTabIntent: () => undefined,
  goBack: () => undefined,
  goForward: () => undefined,
  isHistoryNavAvailable: () => false,
  canGoBack: () => false,
  canGoForward: () => false,
};

function canvasHolding(tiles: ReadonlyArray<EpicNodeRef>): EpicCanvasState {
  return {
    root: pane(
      "pane-1",
      tiles.map((tile) => tile.instanceId),
    ),
    activePaneId: "pane-1",
    tilesByInstanceId: Object.fromEntries(
      tiles.map((tile) => [tile.instanceId, tile]),
    ),
    sizesByGroupId: {},
  };
}

/** Opens a task holding `tiles` in one pane, then closes it the way the strip does. */
function closeTaskHolding(tiles: ReadonlyArray<EpicNodeRef>): string {
  const tabId = useEpicCanvasStore
    .getState()
    .openEpicTab("epic-reopen-canvas", "Task");
  useEpicCanvasStore.setState((state) => ({
    canvasByTabId: { ...state.canvasByTabId, [tabId]: canvasHolding(tiles) },
  }));
  seedActiveEpicTabInTabsStore(tabId);
  expect(
    tabCommandCoordinator.closeRefAfterConfirmed({ kind: "epic", id: tabId }),
  ).toBe(true);
  return tabId;
}

function restoredCanvas(tabId: string): EpicCanvasState {
  const canvas = useEpicCanvasStore.getState().canvasByTabId[tabId];
  if (canvas === undefined) {
    throw new Error("expected the reopened task to have a canvas");
  }
  return canvas;
}

beforeEach(() => {
  mocks.tileRecordIsLive.mockReset();
  mocks.tileRecordIsLive.mockImplementation(() => true);
  useTabsStore.setState(useTabsStore.getInitialState(), true);
  useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
  useTabRecoveryHistory.setState({ entries: [], ready: true });
});

describe("reopening a closed task", () => {
  it("brings back both of the tiles it had open", async () => {
    const tabId = closeTaskHolding([SPEC_A, CHAT_A]);
    expect(useEpicCanvasStore.getState().openTabOrder).not.toContain(tabId);

    await reopenClosedTab(router);

    expect(useEpicCanvasStore.getState().openTabOrder).toContain(tabId);
    const canvas = restoredCanvas(tabId);
    expect(canvas.tilesByInstanceId).toEqual({
      [SPEC_A.instanceId]: SPEC_A,
      [CHAT_A.instanceId]: CHAT_A,
    });
    expect(canvas.root).toMatchObject({
      kind: "pane",
      tabInstanceIds: [SPEC_A.instanceId, CHAT_A.instanceId],
    });
  });

  it("brings back its tiles from the journal when the store no longer holds its canvas", async () => {
    const tabId = closeTaskHolding([SPEC_A, CHAT_A]);
    useEpicCanvasStore.setState((state) => ({
      canvasByTabId: Object.fromEntries(
        Object.entries(state.canvasByTabId).filter(([id]) => id !== tabId),
      ),
    }));

    await reopenClosedTab(router);

    expect(restoredCanvas(tabId).tilesByInstanceId).toEqual({
      [SPEC_A.instanceId]: SPEC_A,
      [CHAT_A.instanceId]: CHAT_A,
    });
  });

  it("leaves out a tile that is no longer recoverable, pane reference included", async () => {
    const tabId = closeTaskHolding([SPEC_A, CHAT_A]);
    mocks.tileRecordIsLive.mockImplementation(
      (instanceId) => instanceId !== SPEC_A.instanceId,
    );

    await reopenClosedTab(router);

    expect(useEpicCanvasStore.getState().openTabOrder).toContain(tabId);
    const canvas = restoredCanvas(tabId);
    expect(canvas.tilesByInstanceId).toEqual({
      [CHAT_A.instanceId]: CHAT_A,
    });
    expect(canvas.root).toMatchObject({
      kind: "pane",
      tabInstanceIds: [CHAT_A.instanceId],
    });
  });
});
