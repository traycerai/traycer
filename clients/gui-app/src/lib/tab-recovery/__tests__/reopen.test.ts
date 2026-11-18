import { beforeEach, describe, expect, it, vi } from "vitest";

import type { KeybindingRouter } from "@/lib/keybindings/dispatch";
import type {
  EpicCanvasState,
  EpicCanvasTileRef,
  EpicNodeRef,
  EpicViewTab,
} from "@/stores/epics/canvas/types";
import {
  CHAT_A,
  SPEC_A,
  pane,
} from "@/stores/epics/canvas/__tests__/canvas-test-fixtures";
import {
  useTabRecoveryHistory,
  type ClosedHeaderTab,
  type TabRecoveryEntry,
} from "@/lib/tab-recovery/history";
import { reopenClosedTab } from "@/lib/tab-recovery/reopen";

const mocks = vi.hoisted(() => {
  const tabsById: Record<string, EpicViewTab | undefined> = {};
  const canvasByTabId: Record<string, EpicCanvasState | undefined> = {};
  const closedTilePayloadsByTabId: Record<
    string,
    Readonly<
      Record<
        string,
        { readonly node: typeof SPEC_A; readonly pendingCreate: boolean }
      >
    >
  > = {};
  return {
    restoreClosedHeaderTabs:
      vi.fn<
        (
          items: readonly ClosedHeaderTab[],
          replaceEmptyDraftId: string | null,
        ) => void
      >(),
    navigateToTabIntent: vi.fn<(intent: unknown) => void>(),
    preservedTileRecordIsLive: vi.fn<
      (
        preserved: {
          readonly node: EpicCanvasTileRef;
          readonly pendingCreate: boolean;
        },
        epicId: string,
        pendingCreateArtifactIds: ReadonlySet<string>,
      ) => boolean
    >(),
    prepareSavedDraft:
      vi.fn<
        (item: ClosedHeaderTab, stillCurrent: () => boolean) => Promise<boolean>
      >(),
    landingDrafts: [] as Array<{
      readonly id: string;
      readonly closed: boolean;
    }>,
    toastInfo: vi.fn<(message: string, options: unknown) => void>(),
    canvasState: {
      openTabOrder: [] as string[],
      tabsById,
      canvasByTabId,
      closedTilePayloadsByTabId,
      pendingCreateArtifactIds: new Set<string>(),
    },
  };
});

vi.mock("sonner", () => ({
  toast: { info: mocks.toastInfo },
}));

vi.mock("@/stores/epics/canvas/store", () => ({
  useEpicCanvasStore: {
    getState: vi.fn(() => mocks.canvasState),
  },
}));

vi.mock("@/stores/home/landing-draft-store", () => ({
  useLandingDraftStore: {
    getState: vi.fn(() => ({ drafts: mocks.landingDrafts })),
  },
}));

vi.mock("../saved-draft", () => ({
  prepareSavedDraft: mocks.prepareSavedDraft,
}));

vi.mock("@/stores/tabs/tab-command-coordinator", () => ({
  tabCommandCoordinator: {
    restoreClosedHeaderTabs: mocks.restoreClosedHeaderTabs,
  },
}));

vi.mock("@/lib/tab-navigation/intents", () => ({
  draftTabIntent: vi.fn((draftId: string) => ({ kind: "draft", draftId })),
  existingEpicTabIntentWithNestedFocus: vi.fn(
    (input: { readonly epicId: string; readonly tabId: string }) => ({
      kind: "epic",
      epicId: input.epicId,
      tabId: input.tabId,
    }),
  ),
}));

vi.mock("@/lib/commands/actions/history-navigation", () => ({
  preservedTileRecordIsLive: mocks.preservedTileRecordIsLive,
}));

vi.mock("@/lib/terminals/plain-terminal-presentation-invalidation", () => ({
  rejectClosedPlainTerminalRestore: vi.fn(() => false),
}));

vi.mock("@/lib/query-client", () => ({ queryClient: {} }));

vi.mock("@/stores/epics/canvas/migrate-canvas", () => ({
  parseEpicCanvasState: vi.fn((value: EpicCanvasState) => value),
}));

vi.mock("@/stores/epics/canvas/tile-tree", () => ({
  findPaneById: vi.fn(() => null),
}));

const EMPTY_CANVAS: EpicCanvasState = {
  root: null,
  activePaneId: null,
  tilesByInstanceId: {},
  sizesByGroupId: {},
};

function router(pathname: string): KeybindingRouter {
  return {
    getPathname: () => pathname,
    navigateHome: () => undefined,
    navigateSettings: () => undefined,
    navigateToEpic: () => undefined,
    navigateToEpicTab: () => undefined,
    navigateToEpicList: () => undefined,
    navigateSettingsSection: () => undefined,
    navigateToTabIntent: (intent) => mocks.navigateToTabIntent(intent),
    goBack: () => undefined,
    goForward: () => undefined,
    isHistoryNavAvailable: () => false,
    canGoBack: () => false,
    canGoForward: () => false,
  };
}

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

function restoredTaskCanvas(): EpicCanvasState {
  const item = mocks.restoreClosedHeaderTabs.mock.calls.at(0)?.[0].at(0);
  if (item === undefined || item.kind !== "epic") {
    throw new Error("expected the coordinator to be handed a task");
  }
  return item.canvas;
}

function epicEntry(input: {
  readonly id: string;
  readonly bulk: boolean;
  readonly canvas: EpicCanvasState;
}): TabRecoveryEntry {
  return {
    id: input.id,
    kind: "header",
    bulk: input.bulk,
    items: [
      {
        kind: "epic",
        index: 0,
        tab: { tabId: "tab-1", epicId: "epic-1", name: "Task" },
        canvas: input.canvas,
      },
    ],
  };
}

function draftRef(
  draftId: string,
): Extract<ClosedHeaderTab, { kind: "draft" }> {
  return {
    kind: "draft",
    draftId,
    hostId: "host-1",
    index: 0,
  };
}

beforeEach(() => {
  mocks.restoreClosedHeaderTabs.mockReset();
  mocks.navigateToTabIntent.mockReset();
  mocks.preservedTileRecordIsLive.mockReset();
  mocks.preservedTileRecordIsLive.mockImplementation(() => true);
  mocks.prepareSavedDraft.mockReset();
  mocks.prepareSavedDraft.mockResolvedValue(true);
  mocks.landingDrafts.length = 0;
  mocks.toastInfo.mockReset();
  mocks.canvasState.openTabOrder.length = 0;
  for (const key of Object.keys(mocks.canvasState.tabsById))
    delete mocks.canvasState.tabsById[key];
  for (const key of Object.keys(mocks.canvasState.canvasByTabId))
    delete mocks.canvasState.canvasByTabId[key];
  for (const key of Object.keys(mocks.canvasState.closedTilePayloadsByTabId))
    delete mocks.canvasState.closedTilePayloadsByTabId[key];
  mocks.canvasState.pendingCreateArtifactIds.clear();
  useTabRecoveryHistory.setState({ entries: [], ready: true });
});

describe("reopenClosedTab", () => {
  it("navigates to a single recovered task from another task", async () => {
    useTabRecoveryHistory.setState({
      entries: [
        epicEntry({ id: "entry-1", bulk: false, canvas: EMPTY_CANVAS }),
      ],
      ready: true,
    });

    await reopenClosedTab(router("/epics/other/other-tab"));

    expect(mocks.restoreClosedHeaderTabs).toHaveBeenCalledWith(
      [expect.objectContaining({ kind: "epic" })],
      null,
    );
    expect(mocks.navigateToTabIntent).toHaveBeenCalledTimes(1);
    expect(useTabRecoveryHistory.getState().entries).toHaveLength(0);
  });

  it("restores a bulk close without changing focus while already on that task", async () => {
    useTabRecoveryHistory.setState({
      entries: [epicEntry({ id: "entry-1", bulk: true, canvas: EMPTY_CANVAS })],
      ready: true,
    });

    await reopenClosedTab(router("/epics/epic-1/tab-1"));

    expect(mocks.restoreClosedHeaderTabs).toHaveBeenCalledWith(
      [expect.objectContaining({ kind: "epic" })],
      null,
    );
    expect(mocks.navigateToTabIntent).not.toHaveBeenCalled();
    expect(useTabRecoveryHistory.getState().entries).toHaveLength(0);
  });

  it("reopens a saved draft by reference so the store supplies its latest content", async () => {
    const item: Extract<ClosedHeaderTab, { kind: "draft" }> = {
      kind: "draft",
      draftId: "saved-draft",
      hostId: "host-1",
      index: 0,
    };
    const entry: TabRecoveryEntry = {
      id: "entry-1",
      kind: "header",
      bulk: false,
      items: [item],
    };
    useTabRecoveryHistory.setState({ entries: [entry], ready: true });

    await reopenClosedTab(router("/"));

    expect(mocks.prepareSavedDraft).toHaveBeenCalledWith(
      item,
      expect.any(Function),
    );
    expect(mocks.restoreClosedHeaderTabs).toHaveBeenCalledWith([item], null);
    expect(useTabRecoveryHistory.getState().entries).toHaveLength(0);
  });

  it("restores navigation after preparing an open host draft as a closed mirror", async () => {
    const item: Extract<ClosedHeaderTab, { kind: "draft" }> = {
      kind: "draft",
      draftId: "host-open-draft",
      hostId: "host-1",
      index: 0,
    };
    const entry: TabRecoveryEntry = {
      id: "entry-1",
      kind: "header",
      bulk: false,
      items: [item],
    };
    useTabRecoveryHistory.setState({ entries: [entry], ready: true });
    mocks.prepareSavedDraft.mockImplementation((draftItem, current) => {
      if (draftItem.kind !== "draft") return Promise.resolve(false);
      expect(draftItem.hostId).toBe("host-1");
      if (!current()) return Promise.resolve(false);
      mocks.landingDrafts.push({ id: draftItem.draftId, closed: true });
      return Promise.resolve(true);
    });

    await reopenClosedTab(router("/"));

    expect(mocks.landingDrafts).toEqual([
      { id: "host-open-draft", closed: true },
    ]);
    expect(mocks.restoreClosedHeaderTabs).toHaveBeenCalledWith([item], null);
    expect(mocks.navigateToTabIntent).toHaveBeenCalledWith({
      kind: "draft",
      draftId: "host-open-draft",
    });
  });

  it("keeps the recovery entry when a draft cannot be restored", async () => {
    const item = draftRef("draft-1");
    const entry: TabRecoveryEntry = {
      id: "entry-1",
      kind: "header",
      bulk: false,
      items: [item],
    };
    useTabRecoveryHistory.setState({ entries: [entry], ready: true });
    mocks.prepareSavedDraft.mockRejectedValue(new Error("host unavailable"));

    await reopenClosedTab(router("/"));

    expect(mocks.restoreClosedHeaderTabs).not.toHaveBeenCalled();
    expect(mocks.toastInfo).toHaveBeenCalledTimes(1);
    const toastCall = mocks.toastInfo.mock.calls.at(0);
    const toastOptions = toastCall?.[1];
    if (
      typeof toastOptions !== "object" ||
      toastOptions === null ||
      !("description" in toastOptions) ||
      typeof toastOptions.description !== "string"
    ) {
      throw new Error("expected a recovery toast description");
    }
    expect(toastOptions.description).toContain("kept");
    expect(useTabRecoveryHistory.getState().entries).toEqual([entry]);
  });

  it("restores available bulk items and retains only the failed draft", async () => {
    const failedDraft = draftRef("draft-1");
    const entry: TabRecoveryEntry = {
      id: "entry-1",
      kind: "header",
      bulk: true,
      items: [
        ...epicEntry({ id: "entry-1", bulk: true, canvas: EMPTY_CANVAS }).items,
        { ...draftRef("draft-1"), index: 1 },
      ],
    };
    useTabRecoveryHistory.setState({ entries: [entry], ready: true });
    mocks.prepareSavedDraft.mockRejectedValue(new Error("host unavailable"));

    await reopenClosedTab(router("/"));

    expect(mocks.restoreClosedHeaderTabs).toHaveBeenCalledWith(
      [expect.objectContaining({ kind: "epic" })],
      null,
    );
    expect(useTabRecoveryHistory.getState().entries).toEqual([
      expect.objectContaining({
        id: "entry-1",
        items: [{ ...failedDraft, index: 1 }],
      }),
    ]);
    expect(mocks.toastInfo).toHaveBeenCalledTimes(1);
    const toastCall = mocks.toastInfo.mock.calls.at(0);
    const toastOptions = toastCall?.[1];
    if (
      typeof toastOptions !== "object" ||
      toastOptions === null ||
      !("description" in toastOptions) ||
      typeof toastOptions.description !== "string"
    ) {
      throw new Error("expected a recovery toast description");
    }
    expect(toastOptions.description).toContain("kept");
  });

  it("hands the tab strip the tiles a closed task had open", async () => {
    const canvas = canvasHolding([SPEC_A, CHAT_A]);
    useTabRecoveryHistory.setState({
      entries: [epicEntry({ id: "entry-1", bulk: false, canvas })],
      ready: true,
    });

    await reopenClosedTab(router("/epics/other/other-tab"));

    expect(mocks.restoreClosedHeaderTabs).toHaveBeenCalledWith(
      [expect.objectContaining({ kind: "epic", canvas })],
      null,
    );
  });

  it("brings a closed task back without a tile that is no longer recoverable", async () => {
    // The parse that trims the pane's own reference to the dropped tile is
    // mocked here; its effect is covered against the real stores in
    // `reopen-task-canvas.test.ts`.
    const canvas = canvasHolding([SPEC_A, CHAT_A]);
    useTabRecoveryHistory.setState({
      entries: [epicEntry({ id: "entry-1", bulk: false, canvas })],
      ready: true,
    });
    mocks.preservedTileRecordIsLive.mockImplementation(
      (preserved) => preserved.node.instanceId !== SPEC_A.instanceId,
    );

    await reopenClosedTab(router("/epics/other/other-tab"));

    expect(restoredTaskCanvas().tilesByInstanceId).toEqual({
      [CHAT_A.instanceId]: CHAT_A,
    });
  });

  it("does not restore a draft removed while it is being prepared", async () => {
    const item = draftRef("draft-1");
    const entry: TabRecoveryEntry = {
      id: "entry-1",
      kind: "header",
      bulk: false,
      items: [item],
    };
    useTabRecoveryHistory.setState({ entries: [entry], ready: true });
    let resolveDraft: (ready: boolean) => void = () => undefined;
    mocks.prepareSavedDraft.mockImplementation(
      () =>
        new Promise<boolean>((resolve) => {
          resolveDraft = resolve;
        }),
    );

    const reopen = reopenClosedTab(router("/"));
    await Promise.resolve();
    expect(mocks.prepareSavedDraft).toHaveBeenCalledTimes(1);

    useTabRecoveryHistory.setState({ entries: [], ready: true });
    resolveDraft(true);
    await reopen;

    expect(mocks.restoreClosedHeaderTabs).not.toHaveBeenCalled();
    expect(useTabRecoveryHistory.getState().entries).toHaveLength(0);
  });
});
