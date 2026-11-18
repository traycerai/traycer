/**
 * Reopening a closed tab through the real record gate, which the two sibling
 * suites mock. A terminal-agent tile with no row in the session is left out
 * only once `epic.listTuiAgents` has answered: before that the missing row
 * says nothing about the agent, and dropping the tile would lose a live one.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { KeybindingRouter } from "@/lib/keybindings/dispatch";
import { __getOpenEpicRegistryForTests } from "@/lib/registries/epic-session-registry";
import { useTabRecoveryHistory } from "@/lib/tab-recovery/history";
import { reopenClosedTab } from "@/lib/tab-recovery/reopen";
import {
  CHAT_A,
  pane,
} from "@/stores/epics/canvas/__tests__/canvas-test-fixtures";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import {
  makeOpenableNodeRef,
  type EpicCanvasTileRef,
} from "@/stores/epics/canvas/types";
import { newEmptyEpicSession } from "@/stores/epics/open-epic/test-support/empty-epic-session";
import { useTabsStore } from "@/stores/tabs/store";
import { tabCommandCoordinator } from "@/stores/tabs/tab-command-coordinator";
import { seedActiveEpicTabInTabsStore } from "@/stores/tabs/test-support/tabs-store-fixtures";

const EPIC_ID = "epic-reopen-agent";
const HOST_ID = "host-open";

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

const closedAgent: EpicCanvasTileRef = makeOpenableNodeRef({
  id: "agent-1",
  instanceId: "inst-agent-1",
  type: "terminal-agent",
  name: "Closed agent",
  hostId: HOST_ID,
});

/** A pending chat keeps the tab non-empty whatever the gate says of the agent. */
const pendingChat: EpicCanvasTileRef = { ...CHAT_A, hostId: HOST_ID };

/**
 * The task's other tab stays open: closing the last one releases the session,
 * and with no session the gate has no record to judge and keeps every tile.
 */
function closeTabHoldingTheAgent(): string {
  useEpicCanvasStore.getState().openEpicTab(EPIC_ID, "Task");
  const tabId = useEpicCanvasStore
    .getState()
    .openEpicTab(EPIC_ID, "Task again");
  const tiles = [closedAgent, pendingChat];
  useEpicCanvasStore.setState((state) => ({
    canvasByTabId: {
      ...state.canvasByTabId,
      [tabId]: {
        root: pane(
          "pane-1",
          tiles.map((tile) => tile.instanceId),
        ),
        activePaneId: "pane-1",
        tilesByInstanceId: Object.fromEntries(
          tiles.map((tile) => [tile.instanceId, tile]),
        ),
        sizesByGroupId: {},
      },
    },
    pendingCreateArtifactIds: new Set([pendingChat.id]),
  }));
  seedActiveEpicTabInTabsStore(tabId);
  expect(
    tabCommandCoordinator.closeRefAfterConfirmed({ kind: "epic", id: tabId }),
  ).toBe(true);
  return tabId;
}

function restoredTiles(tabId: string): ReadonlyArray<string> {
  const canvas = useEpicCanvasStore.getState().canvasByTabId[tabId];
  if (canvas === undefined) {
    throw new Error("expected the reopened task to have a canvas");
  }
  return Object.keys(canvas.tilesByInstanceId);
}

beforeEach(() => {
  useTabsStore.setState(useTabsStore.getInitialState(), true);
  useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
  useTabRecoveryHistory.setState({ entries: [], ready: true });
});

afterEach(() => {
  __getOpenEpicRegistryForTests().disposeAll();
});

describe("reopening a closed tab holding a terminal agent with no record", () => {
  it("keeps the agent's tile while its record list has not answered", async () => {
    newEmptyEpicSession(EPIC_ID, HOST_ID);
    const tabId = closeTabHoldingTheAgent();

    await reopenClosedTab(router);

    expect(restoredTiles(tabId)).toEqual([
      closedAgent.instanceId,
      pendingChat.instanceId,
    ]);
  });

  it("leaves the agent's tile out once its record list has answered", async () => {
    const session = newEmptyEpicSession(EPIC_ID, HOST_ID);
    session.store.getState().markTuiAgentRecordListAuthoritative();
    const tabId = closeTabHoldingTheAgent();

    await reopenClosedTab(router);

    expect(restoredTiles(tabId)).toEqual([pendingChat.instanceId]);
  });
});
