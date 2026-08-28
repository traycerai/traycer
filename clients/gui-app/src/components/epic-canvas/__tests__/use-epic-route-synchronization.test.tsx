import type { ReactNode } from "react";
import {
  act,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";
import type { CloudChatSummary } from "@traycer/protocol/host/epic/cloud-chat";
import {
  type EpicRouteFocusIntent,
  useEpicRouteSynchronization,
} from "@/components/epic-canvas/hooks/use-epic-route-synchronization";
import type {
  EpicCanvasTileRef,
  TileLayoutNode,
} from "@/stores/epics/canvas/types";
import type { EpicCanvasStore } from "@/stores/epics/canvas/store";
import { getCurrentNestedFocusTarget } from "@/lib/epic-nested-focus-route";
import { useCommentThreadsStore } from "@/stores/comments/comment-threads-store";
import {
  DEFAULT_LEFT_PANEL_GROUPS,
  useLeftPanelStore,
} from "@/stores/epics/left-panel-store";
import {
  requestNestedRoutePrimaryEditorFocus,
  resetNestedRouteDomFocusForTests,
} from "@/lib/nested-route-dom-focus";
import {
  beginNestedFocusNavigation,
  resetNestedFocusNavigationIntentsForTests,
  shouldDeferNestedRouteApplication,
} from "@/lib/nested-focus-navigation-intent";
import {
  resetPaneActivationFocusIntentsForTests,
  usePaneActivationOwnership,
} from "@/components/epic-canvas/pane-activation";
import {
  HOSTED_TILE_INSTANCE_ID_ATTRIBUTE,
  HOSTED_TILE_PANE_ID_ATTRIBUTE,
} from "@/components/epic-canvas/surface-host/hosted-tile-dom";

type CanvasStoreSlice = Pick<
  EpicCanvasStore,
  | "renameTab"
  | "openTileInTab"
  | "applyNestedRouteFocus"
  | "closeCanvasTab"
  | "pendingCreateArtifactIds"
>;

interface TestState {
  sessionHostId: string | null;
  activeArtifactId: string | null;
  autoOpenTarget: {
    readonly id: string;
    readonly type: "chat" | "spec";
    readonly name: string;
  } | null;
  nestedFocusEnabled: boolean;
  useRealCanvasStore: boolean;
  navigate: Mock;
  canvasActivePaneId: string | null;
  canvasRoot: TileLayoutNode | null;
  canvasTiles: Readonly<Record<string, EpicCanvasTileRef>>;
  records: ReadonlyArray<{ readonly id: string }>;
  /** Chat ids the `useCloudChatList` mock answers as present
   * (chat-sync-v2 ticket 36's same-host cloud-known reap exemption). */
  cloudChatIds: ReadonlySet<string>;
  /** Chat ids the mock answers as present but owned by a COLLABORATOR
   * (`isOwnedByViewer: false`) - rows the sweep's liveness set must ignore,
   * because the substitution resolver refuses to serve them. */
  cloudCollaboratorChatIds: ReadonlySet<string>;
  chatRecordListAuthoritative: boolean;
  canvasStore: CanvasStoreSlice;
  openEpicState: {
    readonly setLastFocusedArtifactId: Mock;
    readonly setLastFocusedThreadId: Mock;
  };
}

const testState = vi.hoisted<TestState>(() => ({
  sessionHostId: "host-1",
  activeArtifactId: null,
  autoOpenTarget: null,
  nestedFocusEnabled: false,
  useRealCanvasStore: false,
  navigate: vi.fn(),
  canvasActivePaneId: null,
  canvasRoot: null,
  canvasTiles: {},
  records: [],
  cloudChatIds: new Set<string>(),
  cloudCollaboratorChatIds: new Set<string>(),
  chatRecordListAuthoritative: true,
  canvasStore: {
    renameTab: vi.fn(),
    openTileInTab: vi.fn(),
    applyNestedRouteFocus: vi.fn(),
    closeCanvasTab: vi.fn(),
    pendingCreateArtifactIds: new Set<string>(),
  },
  openEpicState: {
    setLastFocusedArtifactId: vi.fn(),
    setLastFocusedThreadId: vi.fn(),
  },
}));

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => testState.navigate,
  useRouter: () => ({ history: {} }),
}));

vi.mock("@/lib/persistent-history", () => ({
  getHistoryController: () =>
    testState.nestedFocusEnabled ? { kind: "persistent-history" } : null,
}));

vi.mock("@/providers/use-open-epic-handle", () => ({
  useOpenEpicHandle: () => ({
    store: {
      getState: () => testState.openEpicState,
    },
  }),
}));

vi.mock("@/stores/epics/canvas/store", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/stores/epics/canvas/store")>();
  return {
    ...actual,
    useActiveEpicArtifactId: (tabId: string) =>
      testState.useRealCanvasStore
        ? actual.useActiveEpicArtifactId(tabId)
        : testState.activeArtifactId,
    useEpicCanvas: (tabId: string) =>
      testState.useRealCanvasStore
        ? actual.useEpicCanvas(tabId)
        : {
            root: testState.canvasRoot,
            activePaneId: testState.canvasActivePaneId,
            tilesByInstanceId: testState.canvasTiles,
            sizesByGroupId: {},
          },
    useEpicCanvasStore: <T,>(selector: (store: CanvasStoreSlice) => T): T =>
      testState.useRealCanvasStore
        ? actual.useEpicCanvasStore(selector)
        : selector(testState.canvasStore),
    useEpicTab: (tabId: string) =>
      testState.useRealCanvasStore ? actual.useEpicTab(tabId) : null,
  };
});

vi.mock("@/lib/epic-selectors", () => ({
  useEpicArtifactRecords: () => testState.records,
  useEpicChatRecordListAuthoritative: () =>
    testState.chatRecordListAuthoritative,
  useEpicLastFocusedArtifactId: () => null,
  useEpicSnapshotLoaded: () => true,
  useEpicTitle: () => "",
}));

// The host whose projection feeds `records` - the Epic session's (the canvas
// host), which is the policing identity `isTileRefRecordLive` judges against.
// This suite used to seed the app-wide read; the sync no longer reads it.
vi.mock("@/components/epic-canvas/hooks/use-canvas-host-id", () => ({
  useCanvasHostId: () => testState.sessionHostId,
}));

vi.mock("@/hooks/epic/use-epic-session-host-client", () => ({
  useEpicSessionHostClient: () => null,
}));

vi.mock("@/lib/epic-auto-open", () => ({
  resolveAutoOpenTarget: () => testState.autoOpenTarget,
}));

// The reap effect's same-host cloud-known exemption (chat-sync-v2 ticket
// 36) reads these two - stubbed at the hook boundary, same reason as every
// other seam in this provider-less suite.
vi.mock("@/lib/host", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/host")>();
  return { ...actual, useHostClient: () => null };
});

// A SETTLED, successful list - the sweep under test refuses to run until the
// cloud list has produced an answer that can AUTHORIZE it (success,
// `E_HOST_UNSUPPORTED`, or a disabled query), because an in-flight or
// transiently failed list reads every cloud row as absent and would reap the
// never-adopted same-host chat the exemption exists for. A stub that enumerates only the flags its
// consumer read when it was written answers `undefined` for `isSuccess`, which
// that gate takes as "still in flight" - the sweep then never runs at all and
// every assertion about it times out instead of failing on its subject. Rows
// are whole `CloudChatSummary` values for the same reason: the next field a
// consumer starts reading fails `compile` here rather than silently reading
// `undefined`.
vi.mock("@/hooks/chats/use-cloud-chat-queries", () => {
  const cloudRow = (
    chatId: string,
    isOwnedByViewer: boolean,
  ): CloudChatSummary => ({
    identity: {
      taskId: EPIC_ID,
      chatId,
      ownerUserId: isOwnedByViewer ? "user-1" : "collaborator-1",
    },
    ownerHostId: "owner-host",
    createdAt: 1,
    visibility: "task",
    title: null,
    isTitleEditedByUser: false,
    parentChatId: null,
    isArchived: false,
    runSettingsSummary: null,
    metadataUpdatedAt: 1,
    headSha256: null,
    publishedAt: null,
    throughRecordSeq: null,
    isOwnedByViewer,
  });
  return {
    useCloudChatList: () => ({
      data: {
        chats: [
          ...[...testState.cloudChatIds].map((chatId) =>
            cloudRow(chatId, true),
          ),
          ...[...testState.cloudCollaboratorChatIds].map((chatId) =>
            cloudRow(chatId, false),
          ),
        ],
      },
      // `isEnabled` too: the sweep asks `cloudChatListAuthorizesRecordSweep`,
      // which reads a DISABLED query as authorizing (nothing will answer it).
      // A stub omitting this answers `undefined`, which that predicate reads
      // as disabled - the gate would then be open in every test whatever the
      // other flags said.
      isEnabled: true,
      isSuccess: true,
      isError: false,
      isPending: false,
      isFetching: false,
      error: null,
    }),
    isCloudChatListSettled: (query: {
      readonly isEnabled: boolean;
      readonly isSuccess: boolean;
      readonly isError: boolean;
    }) => !query.isEnabled || query.isSuccess || query.isError,
    cloudChatListAuthorizesRecordSweep: (query: {
      readonly isEnabled: boolean;
      readonly isSuccess: boolean;
      readonly isError: boolean;
      readonly error: { readonly code: string } | null;
    }) =>
      !query.isEnabled ||
      query.isSuccess ||
      (query.isError && query.error?.code === "E_HOST_UNSUPPORTED"),
  };
});

const EPIC_ID = "route-sync-epic";
const TAB_ID = "route-sync-tab";
const THREAD_FOCUS_INTENT: EpicRouteFocusIntent = {
  epicId: EPIC_ID,
  tabId: TAB_ID,
  focusedAt: 123,
  focusArtifactId: "artifact-1",
  focusThreadId: "thread-1",
  focusPaneId: undefined,
  focusTileInstanceId: undefined,
};

function resetStores(): void {
  resetNestedRouteDomFocusForTests();
  resetNestedFocusNavigationIntentsForTests();
  resetPaneActivationFocusIntentsForTests();
  window.localStorage.clear();
  useLeftPanelStore.setState({
    activePanelIdByTabId: {},
    panelGroups: DEFAULT_LEFT_PANEL_GROUPS,
    mainCollapsedByTabId: {},
    panelSectionCollapsedByPanelId: {},
    commentsPanelRevealedByTabId: {},
    localRootCreatePendingByEpicPanel: {},
    acknowledgedRootCreatePendingByEpicPanel: {},
  });
  useCommentThreadsStore.setState({
    activeByEpicId: {},
    hoverByEpicId: {},
    flashByEpicId: {},
    draftByEpicId: {},
    artifactByEpicId: {},
  });
  testState.activeArtifactId = null;
  testState.sessionHostId = "host-1";
  testState.nestedFocusEnabled = false;
  testState.useRealCanvasStore = false;
  testState.navigate.mockClear();
  testState.canvasActivePaneId = null;
  testState.autoOpenTarget = {
    id: "artifact-1",
    type: "spec",
    name: "Focused artifact",
  };
  testState.canvasRoot = null;
  testState.canvasTiles = {};
  testState.records = [];
  testState.cloudChatIds = new Set();
  testState.cloudCollaboratorChatIds = new Set();
  testState.chatRecordListAuthoritative = true;
  vi.mocked(testState.canvasStore.renameTab).mockClear();
  vi.mocked(testState.canvasStore.openTileInTab).mockClear();
  vi.mocked(testState.canvasStore.applyNestedRouteFocus).mockClear();
  vi.mocked(testState.canvasStore.closeCanvasTab).mockClear();
  testState.openEpicState.setLastFocusedArtifactId.mockClear();
  testState.openEpicState.setLastFocusedThreadId.mockClear();
}

function PaneActivationOriginBoundary(props: { readonly children: ReactNode }) {
  const activation = usePaneActivationOwnership({
    active: false,
    activate: () => undefined,
  });
  return (
    <div
      onFocusCapture={activation.onFocusCapture}
      onPointerCancelCapture={activation.onPointerCancelCapture}
      onPointerDownCapture={activation.onPointerDownCapture}
    >
      {props.children}
    </div>
  );
}

function specTile(
  id: string,
  instanceId: string,
  name: string,
): EpicCanvasTileRef {
  return {
    id,
    instanceId,
    type: "spec",
    name,
    hostId: "host-1",
  };
}

function setSinglePaneCanvas(
  paneId: string,
  tabs: ReadonlyArray<EpicCanvasTileRef>,
  activeTabId: string | null,
): void {
  testState.canvasActivePaneId = paneId;
  testState.canvasRoot = {
    kind: "pane",
    id: paneId,
    tabInstanceIds: tabs.map((tab) => tab.instanceId),
    activeTabId,
    previewTabId: null,
    activationHistory: activeTabId === null ? [] : [activeTabId],
  };
  testState.canvasTiles = Object.fromEntries(
    tabs.map((tab) => [tab.instanceId, tab]),
  );
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isSearchUpdater(
  value: unknown,
): value is (prev: Readonly<Record<string, unknown>>) => unknown {
  return typeof value === "function";
}

function lastNavigateSearchPatch(): Readonly<Record<string, unknown>> {
  const call = testState.navigate.mock.calls.at(-1);
  if (call === undefined) throw new Error("expected navigate call");
  const options: unknown = call[0];
  if (!isRecord(options)) throw new Error("expected navigate options");
  const search = options.search;
  if (!isSearchUpdater(search)) {
    throw new Error("expected search updater");
  }
  const result: unknown = search({});
  if (!isRecord(result)) throw new Error("expected search patch result");
  return result;
}

/**
 * The applied-nested-target focus restore runs inside a `requestAnimationFrame`.
 * Await two frames (wrapped in `act` so React state settles) to let that
 * scheduled `.focus()` land before asserting.
 */
async function flushFocusRestore(): Promise<void> {
  await act(async () => {
    await new Promise<void>((resolve) => {
      window.requestAnimationFrame(() => {
        window.requestAnimationFrame(() => resolve());
      });
    });
  });
}

describe("useEpicRouteSynchronization", () => {
  beforeEach(resetStores);
  afterEach(resetStores);

  it("canonicalizes a desktop route with no nested params to the current canvas focus", async () => {
    testState.nestedFocusEnabled = true;
    setSinglePaneCanvas(
      "pane-current",
      [specTile("artifact-current", "tile-current", "Current artifact")],
      "tile-current",
    );

    renderHook(
      (intent: EpicRouteFocusIntent) => useEpicRouteSynchronization(intent),
      {
        initialProps: {
          epicId: EPIC_ID,
          tabId: TAB_ID,
          focusedAt: undefined,
          focusArtifactId: undefined,
          focusThreadId: undefined,
          focusPaneId: undefined,
          focusTileInstanceId: undefined,
        },
      },
    );

    await waitFor(() => {
      expect(testState.navigate).toHaveBeenCalled();
    });
    expect(lastNavigateSearchPatch()).toMatchObject({
      focusPaneId: "pane-current",
      focusTileInstanceId: "tile-current",
    });
    expect(testState.navigate.mock.calls.at(-1)?.[0]).toMatchObject({
      to: "/epics/$epicId/$tabId",
      params: { epicId: EPIC_ID, tabId: TAB_ID },
      replace: true,
    });
  });

  it("lets legacy artifact focus resolve before canonicalizing missing nested params", async () => {
    testState.nestedFocusEnabled = true;
    setSinglePaneCanvas(
      "pane-existing",
      [specTile("artifact-existing", "tile-existing", "Existing artifact")],
      "tile-existing",
    );

    const hook = renderHook(
      (intent: EpicRouteFocusIntent) => useEpicRouteSynchronization(intent),
      {
        initialProps: {
          ...THREAD_FOCUS_INTENT,
          focusThreadId: undefined,
        },
      },
    );

    await waitFor(() => {
      expect(testState.canvasStore.openTileInTab).toHaveBeenCalledWith(
        TAB_ID,
        expect.objectContaining({
          id: "artifact-1",
          type: "spec",
          name: "Focused artifact",
        }),
      );
    });
    expect(testState.navigate).not.toHaveBeenCalled();

    testState.activeArtifactId = "artifact-1";
    setSinglePaneCanvas(
      "pane-focused",
      [specTile("artifact-1", "tile-focused", "Focused artifact")],
      "tile-focused",
    );
    hook.rerender({
      ...THREAD_FOCUS_INTENT,
      focusThreadId: undefined,
    });

    await waitFor(() => {
      expect(testState.navigate).toHaveBeenCalled();
    });
    expect(lastNavigateSearchPatch()).toMatchObject({
      focusPaneId: "pane-focused",
      focusTileInstanceId: "tile-focused",
    });
  });

  it("reopens a closed chat for an explicit notification focus", async () => {
    testState.autoOpenTarget = {
      id: "chat-notified",
      type: "chat",
      name: "Notified chat",
    };

    renderHook(
      (intent: EpicRouteFocusIntent) => useEpicRouteSynchronization(intent),
      {
        initialProps: {
          epicId: EPIC_ID,
          tabId: TAB_ID,
          focusedAt: 904,
          focusArtifactId: "chat-notified",
          focusThreadId: undefined,
          focusPaneId: undefined,
          focusTileInstanceId: undefined,
        },
      },
    );

    await waitFor(() => {
      expect(testState.canvasStore.openTileInTab).toHaveBeenCalledWith(
        TAB_ID,
        expect.objectContaining({
          id: "chat-notified",
          type: "chat",
          name: "Notified chat",
        }),
      );
    });
  });

  it("applies valid nested params with the raw canvas focus action", async () => {
    testState.nestedFocusEnabled = true;
    setSinglePaneCanvas(
      "pane-current",
      [
        specTile("artifact-a", "tile-a", "Artifact A"),
        specTile("artifact-b", "tile-b", "Artifact B"),
      ],
      "tile-a",
    );

    renderHook(
      (intent: EpicRouteFocusIntent) => useEpicRouteSynchronization(intent),
      {
        initialProps: {
          epicId: EPIC_ID,
          tabId: TAB_ID,
          focusedAt: undefined,
          focusArtifactId: undefined,
          focusThreadId: undefined,
          focusPaneId: "pane-current",
          focusTileInstanceId: "tile-b",
        },
      },
    );

    await waitFor(() => {
      expect(testState.canvasStore.applyNestedRouteFocus).toHaveBeenCalledWith(
        TAB_ID,
        {
          paneId: "pane-current",
          tileInstanceId: "tile-b",
        },
      );
    });
    expect(testState.navigate).not.toHaveBeenCalled();
    expect(testState.canvasStore.openTileInTab).not.toHaveBeenCalled();
  });

  it("does not let a stale route target undo an in-flight local pane navigation", () => {
    testState.nestedFocusEnabled = true;
    setSinglePaneCanvas(
      "pane-current",
      [
        specTile("artifact-a", "tile-a", "Artifact A"),
        specTile("artifact-b", "tile-b", "Artifact B"),
      ],
      "tile-b",
    );
    beginNestedFocusNavigation(EPIC_ID, TAB_ID, {
      paneId: "pane-current",
      tileInstanceId: "tile-b",
    });

    const view = renderHook(
      (intent: EpicRouteFocusIntent) => useEpicRouteSynchronization(intent),
      {
        initialProps: {
          epicId: EPIC_ID,
          tabId: TAB_ID,
          focusedAt: undefined,
          focusArtifactId: undefined,
          focusThreadId: undefined,
          focusPaneId: "pane-current",
          focusTileInstanceId: "tile-a",
        },
      },
    );

    expect(testState.canvasStore.applyNestedRouteFocus).not.toHaveBeenCalled();

    view.rerender({
      epicId: EPIC_ID,
      tabId: TAB_ID,
      focusedAt: undefined,
      focusArtifactId: undefined,
      focusThreadId: undefined,
      focusPaneId: "pane-current",
      focusTileInstanceId: "tile-b",
    });

    expect(
      shouldDeferNestedRouteApplication(EPIC_ID, TAB_ID, {
        paneId: "pane-current",
        tileInstanceId: "tile-b",
      }),
    ).toBe(false);
    expect(testState.canvasStore.applyNestedRouteFocus).not.toHaveBeenCalled();
  });

  it("reapplies the route target when an optimistic navigation never commits", async () => {
    vi.useFakeTimers();
    let unmountHook: (() => void) | null = null;
    const { useEpicCanvasStore: realCanvasStore } = await vi.importActual<
      typeof import("@/stores/epics/canvas/store")
    >("@/stores/epics/canvas/store");
    try {
      testState.nestedFocusEnabled = true;
      testState.useRealCanvasStore = true;
      testState.records = [{ id: "artifact-a" }, { id: "artifact-b" }];
      realCanvasStore.setState(realCanvasStore.getInitialState(), true);
      const realStore = realCanvasStore.getState();
      const realTabId = realStore.openEpicTab(EPIC_ID, "Route retry");
      realStore.openTileInTab(
        realTabId,
        specTile("artifact-a", "tile-a", "Artifact A"),
      );
      realStore.openTileInTab(
        realTabId,
        specTile("artifact-b", "tile-b", "Artifact B"),
      );
      const before = realCanvasStore.getState().canvasByTabId[realTabId];
      if (before === undefined) throw new Error("Expected seeded canvas");
      const paneId = before.activePaneId;
      if (paneId === null) throw new Error("Expected seeded active pane");
      expect(getCurrentNestedFocusTarget(before)).toEqual({
        paneId,
        tileInstanceId: "tile-b",
      });
      beginNestedFocusNavigation(EPIC_ID, realTabId, {
        paneId,
        tileInstanceId: "tile-b",
      });

      const view = renderHook(
        (intent: EpicRouteFocusIntent) => useEpicRouteSynchronization(intent),
        {
          initialProps: {
            epicId: EPIC_ID,
            tabId: realTabId,
            focusedAt: undefined,
            focusArtifactId: undefined,
            focusThreadId: undefined,
            focusPaneId: paneId,
            focusTileInstanceId: "tile-a",
          },
        },
      );
      unmountHook = view.unmount;

      const deferred = realCanvasStore.getState().canvasByTabId[realTabId];
      if (deferred === undefined) throw new Error("Expected deferred canvas");
      expect(getCurrentNestedFocusTarget(deferred)).toEqual({
        paneId,
        tileInstanceId: "tile-b",
      });

      await act(async () => {
        await vi.advanceTimersByTimeAsync(2_000);
      });

      const applied = realCanvasStore.getState().canvasByTabId[realTabId];
      if (applied === undefined) throw new Error("Expected applied canvas");
      expect(getCurrentNestedFocusTarget(applied)).toEqual({
        paneId,
        tileInstanceId: "tile-a",
      });
    } finally {
      unmountHook?.();
      testState.useRealCanvasStore = false;
      realCanvasStore.setState(realCanvasStore.getInitialState(), true);
      vi.useRealTimers();
    }
  });

  it("treats a pane-only route as applied when the active pane contains a tile", async () => {
    testState.nestedFocusEnabled = true;
    setSinglePaneCanvas(
      "pane-current",
      [specTile("artifact-current", "tile-current", "Current artifact")],
      "tile-current",
    );

    renderHook(
      (intent: EpicRouteFocusIntent) => useEpicRouteSynchronization(intent),
      {
        initialProps: {
          epicId: EPIC_ID,
          tabId: TAB_ID,
          focusedAt: undefined,
          focusArtifactId: undefined,
          focusThreadId: undefined,
          focusPaneId: "pane-current",
          focusTileInstanceId: undefined,
        },
      },
    );

    await waitFor(() => {
      expect(testState.navigate).not.toHaveBeenCalled();
      expect(
        testState.canvasStore.applyNestedRouteFocus,
      ).not.toHaveBeenCalled();
    });
  });

  it("treats mismatched legacy artifact fields as inert when nested params are present", async () => {
    testState.nestedFocusEnabled = true;
    testState.activeArtifactId = "artifact-current";
    setSinglePaneCanvas(
      "pane-current",
      [specTile("artifact-current", "tile-current", "Current artifact")],
      "tile-current",
    );

    renderHook(
      (intent: EpicRouteFocusIntent) => useEpicRouteSynchronization(intent),
      {
        initialProps: {
          ...THREAD_FOCUS_INTENT,
          focusPaneId: "pane-current",
          focusTileInstanceId: "tile-current",
        },
      },
    );

    await waitFor(() => {
      expect(testState.navigate).not.toHaveBeenCalled();
      expect(testState.canvasStore.openTileInTab).not.toHaveBeenCalled();
      expect(
        testState.openEpicState.setLastFocusedArtifactId,
      ).not.toHaveBeenCalledWith("artifact-1");
      expect(
        testState.openEpicState.setLastFocusedThreadId,
      ).not.toHaveBeenCalled();
      expect(useLeftPanelStore.getState().isCommentsPanelRevealed(TAB_ID)).toBe(
        false,
      );
      expect(
        useCommentThreadsStore.getState().activeByEpicId[EPIC_ID],
      ).toBeUndefined();
    });
  });

  it("recovers a stale current nested route to the current valid focus", async () => {
    testState.nestedFocusEnabled = true;
    setSinglePaneCanvas(
      "pane-current",
      [specTile("artifact-current", "tile-current", "Current artifact")],
      "tile-current",
    );

    renderHook(
      (intent: EpicRouteFocusIntent) => useEpicRouteSynchronization(intent),
      {
        initialProps: {
          epicId: EPIC_ID,
          tabId: TAB_ID,
          focusedAt: undefined,
          focusArtifactId: undefined,
          focusThreadId: undefined,
          focusPaneId: "pane-current",
          focusTileInstanceId: "tile-stale",
        },
      },
    );

    await waitFor(() => {
      expect(testState.navigate).toHaveBeenCalled();
    });
    expect(lastNavigateSearchPatch()).toMatchObject({
      focusPaneId: "pane-current",
      focusTileInstanceId: "tile-current",
    });
    expect(testState.canvasStore.applyNestedRouteFocus).not.toHaveBeenCalled();
  });

  it("clears stale nested params when no valid current focus exists", async () => {
    testState.nestedFocusEnabled = true;
    testState.canvasRoot = {
      kind: "pane",
      id: "pane-empty",
      tabInstanceIds: [],
      activeTabId: null,
      previewTabId: null,
      activationHistory: [],
    };
    testState.canvasActivePaneId = "pane-missing";
    testState.canvasTiles = {};

    renderHook(
      (intent: EpicRouteFocusIntent) => useEpicRouteSynchronization(intent),
      {
        initialProps: {
          epicId: EPIC_ID,
          tabId: TAB_ID,
          focusedAt: undefined,
          focusArtifactId: undefined,
          focusThreadId: undefined,
          focusPaneId: "pane-stale",
          focusTileInstanceId: undefined,
        },
      },
    );

    await waitFor(() => {
      expect(testState.navigate).toHaveBeenCalled();
    });
    expect(lastNavigateSearchPatch()).toMatchObject({
      focusPaneId: undefined,
      focusTileInstanceId: undefined,
    });
    expect(testState.canvasStore.applyNestedRouteFocus).not.toHaveBeenCalled();
  });

  it("reveals and activates comments for a focused thread deep link", async () => {
    const hook = renderHook(
      (intent: EpicRouteFocusIntent) => useEpicRouteSynchronization(intent),
      {
        initialProps: THREAD_FOCUS_INTENT,
      },
    );

    await waitFor(() => {
      expect(testState.canvasStore.openTileInTab).toHaveBeenCalledWith(
        TAB_ID,
        expect.objectContaining({
          id: "artifact-1",
          type: "spec",
          name: "Focused artifact",
        }),
      );
    });

    testState.activeArtifactId = "artifact-1";
    hook.rerender(THREAD_FOCUS_INTENT);

    await waitFor(() =>
      expect(
        testState.openEpicState.setLastFocusedThreadId,
      ).toHaveBeenCalledWith("thread-1"),
    );

    await waitFor(() => {
      expect(useLeftPanelStore.getState().isCommentsPanelRevealed(TAB_ID)).toBe(
        true,
      );
      expect(useLeftPanelStore.getState().getActivePanelId(TAB_ID)).toBe(
        "comments",
      );
      expect(useCommentThreadsStore.getState().activeByEpicId[EPIC_ID]).toBe(
        "thread-1",
      );
    });
  });

  it("does not reuse focused-thread dedupe keys across epics", async () => {
    testState.autoOpenTarget = null;
    testState.activeArtifactId = "artifact-1";
    const hook = renderHook(
      (intent: EpicRouteFocusIntent) => useEpicRouteSynchronization(intent),
      {
        initialProps: THREAD_FOCUS_INTENT,
      },
    );

    await waitFor(() => {
      expect(useCommentThreadsStore.getState().activeByEpicId[EPIC_ID]).toBe(
        "thread-1",
      );
    });

    hook.rerender({
      ...THREAD_FOCUS_INTENT,
      epicId: "route-sync-epic-b",
      tabId: "route-sync-tab-b",
    });

    await waitFor(() => {
      expect(
        useLeftPanelStore
          .getState()
          .isCommentsPanelRevealed("route-sync-tab-b"),
      ).toBe(true);
      expect(
        useCommentThreadsStore.getState().activeByEpicId["route-sync-epic-b"],
      ).toBe("thread-1");
    });
  });

  it("does not reuse auto-open dedupe keys across epics", async () => {
    const hook = renderHook(
      (intent: EpicRouteFocusIntent) => useEpicRouteSynchronization(intent),
      {
        initialProps: {
          ...THREAD_FOCUS_INTENT,
          focusThreadId: undefined,
        },
      },
    );

    await waitFor(() => {
      expect(testState.canvasStore.openTileInTab).toHaveBeenCalledWith(
        TAB_ID,
        expect.objectContaining({
          id: "artifact-1",
          type: "spec",
          name: "Focused artifact",
        }),
      );
    });

    vi.mocked(testState.canvasStore.openTileInTab).mockClear();
    hook.rerender({
      ...THREAD_FOCUS_INTENT,
      epicId: "route-sync-epic-b",
      tabId: "route-sync-tab-b",
      focusThreadId: undefined,
    });

    await waitFor(() => {
      expect(testState.canvasStore.openTileInTab).toHaveBeenCalledWith(
        "route-sync-tab-b",
        expect.objectContaining({
          id: "artifact-1",
          type: "spec",
          name: "Focused artifact",
        }),
      );
    });
  });

  it("closes removed record-backed tiles by tab instance id while preserving local git diff tiles", async () => {
    testState.autoOpenTarget = null;
    testState.records = [{ id: "live-artifact" }];
    const gitTile: EpicCanvasTileRef = {
      id: "git-diff-local",
      instanceId: "inst-git-diff-local",
      type: "git-diff",
      name: "file.ts · Working",
      hostId: "host-1",
      repositoryContext: null,
      diff: {
        kind: "file",
        runningDir: "/repo",
        filePath: "src/file.ts",
        stage: "unstaged",
      },
      view: {
        collapsedFilePaths: [],
      },
    };
    const removedChat: EpicCanvasTileRef = {
      id: "removed-chat",
      instanceId: "inst-removed-chat",
      type: "chat",
      name: "Removed chat",
      hostId: "host-1",
    };
    testState.canvasRoot = {
      kind: "pane",
      id: "group-1",
      tabInstanceIds: [gitTile.instanceId, removedChat.instanceId],
      activeTabId: "inst-git-diff-local",
      previewTabId: null,
      activationHistory: [gitTile.instanceId],
    };
    testState.canvasTiles = {
      [gitTile.instanceId]: gitTile,
      [removedChat.instanceId]: removedChat,
    };

    renderHook(
      (intent: EpicRouteFocusIntent) => useEpicRouteSynchronization(intent),
      {
        initialProps: {
          epicId: EPIC_ID,
          tabId: TAB_ID,
          focusedAt: undefined,
          focusArtifactId: undefined,
          focusThreadId: undefined,
          focusPaneId: undefined,
          focusTileInstanceId: undefined,
        },
      },
    );

    await waitFor(() => {
      expect(testState.canvasStore.closeCanvasTab).toHaveBeenCalledWith(
        TAB_ID,
        "group-1",
        "inst-removed-chat",
      );
    });
    expect(testState.canvasStore.closeCanvasTab).not.toHaveBeenCalledWith(
      TAB_ID,
      "group-1",
      "git-diff-local",
    );
    expect(testState.canvasStore.closeCanvasTab).not.toHaveBeenCalledWith(
      TAB_ID,
      "group-1",
      "removed-chat",
    );
  });

  it("does not close a same-host chat until the local record list is authoritative", async () => {
    testState.autoOpenTarget = null;
    testState.chatRecordListAuthoritative = false;
    const unansweredChat: EpicCanvasTileRef = {
      id: "record-list-unanswered-chat",
      instanceId: "inst-record-list-unanswered-chat",
      type: "chat",
      name: "Record list unanswered",
      hostId: "host-1",
    };
    const removedSpec: EpicCanvasTileRef = {
      id: "removed-spec",
      instanceId: "inst-removed-spec",
      type: "spec",
      name: "Removed spec",
      hostId: "host-1",
    };
    testState.canvasRoot = {
      kind: "pane",
      id: "group-1",
      tabInstanceIds: [unansweredChat.instanceId, removedSpec.instanceId],
      activeTabId: unansweredChat.instanceId,
      previewTabId: null,
      activationHistory: [unansweredChat.instanceId],
    };
    testState.canvasTiles = {
      [unansweredChat.instanceId]: unansweredChat,
      [removedSpec.instanceId]: removedSpec,
    };

    renderHook(
      (intent: EpicRouteFocusIntent) => useEpicRouteSynchronization(intent),
      {
        initialProps: {
          epicId: EPIC_ID,
          tabId: TAB_ID,
          focusedAt: undefined,
          focusArtifactId: undefined,
          focusThreadId: undefined,
          focusPaneId: undefined,
          focusTileInstanceId: undefined,
        },
      },
    );

    await waitFor(() => {
      expect(testState.canvasStore.closeCanvasTab).toHaveBeenCalledWith(
        TAB_ID,
        "group-1",
        removedSpec.instanceId,
      );
    });
    expect(testState.canvasStore.closeCanvasTab).not.toHaveBeenCalledWith(
      TAB_ID,
      "group-1",
      unansweredChat.instanceId,
    );
  });

  // chat-sync-v2 ticket 36: a chat with no local record but still known to
  // `epic.listCloudChats` must NOT be reaped - a leased identity that never
  // adopted this chat's rows, not a genuine deletion.
  it("does not close a record-less chat tile that is still cloud-known", async () => {
    testState.autoOpenTarget = null;
    testState.records = [{ id: "live-artifact" }];
    testState.cloudChatIds = new Set(["cloud-known-chat"]);
    const cloudKnownChat: EpicCanvasTileRef = {
      id: "cloud-known-chat",
      instanceId: "inst-cloud-known-chat",
      type: "chat",
      name: "Cloud-known chat",
      hostId: "host-1",
    };
    testState.canvasRoot = {
      kind: "pane",
      id: "group-1",
      tabInstanceIds: [cloudKnownChat.instanceId],
      activeTabId: cloudKnownChat.instanceId,
      previewTabId: null,
      activationHistory: [cloudKnownChat.instanceId],
    };
    // The POSITIVE control, in the same pane: a chat that is neither
    // record-backed nor cloud-known, which the sweep must close. Waiting for
    // THAT close is what proves the sweep ran at all - `not.toHaveBeenCalled()`
    // on its own is satisfied by the first poll and passes just as happily when
    // `snapshotLoaded` or the cloud-list gate left the effect switched off,
    // which is the failure this suite's own mock comment warns about.
    const reapedChat: EpicCanvasTileRef = {
      id: "unknown-chat",
      instanceId: "inst-unknown-chat",
      type: "chat",
      name: "Neither local nor cloud-known",
      hostId: "host-1",
    };
    testState.canvasRoot = {
      kind: "pane",
      id: "group-1",
      tabInstanceIds: [cloudKnownChat.instanceId, reapedChat.instanceId],
      activeTabId: cloudKnownChat.instanceId,
      previewTabId: null,
      activationHistory: [cloudKnownChat.instanceId],
    };
    testState.canvasTiles = {
      [cloudKnownChat.instanceId]: cloudKnownChat,
      [reapedChat.instanceId]: reapedChat,
    };

    renderHook(
      (intent: EpicRouteFocusIntent) => useEpicRouteSynchronization(intent),
      {
        initialProps: {
          epicId: EPIC_ID,
          tabId: TAB_ID,
          focusedAt: undefined,
          focusArtifactId: undefined,
          focusThreadId: undefined,
          focusPaneId: undefined,
          focusTileInstanceId: undefined,
        },
      },
    );

    await waitFor(() => {
      expect(testState.canvasStore.closeCanvasTab).toHaveBeenCalledWith(
        TAB_ID,
        "group-1",
        reapedChat.instanceId,
      );
    });
    expect(testState.canvasStore.closeCanvasTab).not.toHaveBeenCalledWith(
      TAB_ID,
      "group-1",
      cloudKnownChat.instanceId,
    );
  });

  // A COLLABORATOR's row with the same host-minted chatId is not evidence the
  // viewer's tab is alive: the substitution resolver refuses to serve rows the
  // viewer does not own, so keeping the tab open on that row's strength would
  // leave it permanently loading. The liveness set filters by viewer
  // ownership, same as the resolver.
  it("closes a record-less chat tile whose only cloud row belongs to a collaborator", async () => {
    testState.autoOpenTarget = null;
    testState.records = [{ id: "live-artifact" }];
    testState.cloudChatIds = new Set(["viewer-kept-chat"]);
    testState.cloudCollaboratorChatIds = new Set(["collaborator-only-chat"]);
    const keptChat: EpicCanvasTileRef = {
      id: "viewer-kept-chat",
      instanceId: "inst-viewer-kept-chat",
      type: "chat",
      name: "Viewer's cloud-known chat",
      hostId: "host-1",
    };
    const collaboratorOnlyChat: EpicCanvasTileRef = {
      id: "collaborator-only-chat",
      instanceId: "inst-collaborator-only-chat",
      type: "chat",
      name: "Collaborator's row only",
      hostId: "host-1",
    };
    testState.canvasRoot = {
      kind: "pane",
      id: "group-1",
      tabInstanceIds: [keptChat.instanceId, collaboratorOnlyChat.instanceId],
      activeTabId: keptChat.instanceId,
      previewTabId: null,
      activationHistory: [keptChat.instanceId],
    };
    testState.canvasTiles = {
      [keptChat.instanceId]: keptChat,
      [collaboratorOnlyChat.instanceId]: collaboratorOnlyChat,
    };

    renderHook(
      (intent: EpicRouteFocusIntent) => useEpicRouteSynchronization(intent),
      {
        initialProps: {
          epicId: EPIC_ID,
          tabId: TAB_ID,
          focusedAt: undefined,
          focusArtifactId: undefined,
          focusThreadId: undefined,
          focusPaneId: undefined,
          focusTileInstanceId: undefined,
        },
      },
    );

    await waitFor(() => {
      expect(testState.canvasStore.closeCanvasTab).toHaveBeenCalledWith(
        TAB_ID,
        "group-1",
        collaboratorOnlyChat.instanceId,
      );
    });
    // The viewer's own row keeps its tab, in the same sweep - the positive
    // control proving ownership is what made the difference.
    expect(testState.canvasStore.closeCanvasTab).not.toHaveBeenCalledWith(
      TAB_ID,
      "group-1",
      keptChat.instanceId,
    );
  });

  it("keeps editor focus when a canvas mutation re-runs an already-applied nested focus target", async () => {
    testState.nestedFocusEnabled = true;
    setSinglePaneCanvas(
      "pane-current",
      [specTile("artifact-current", "tile-current", "Current artifact")],
      "tile-current",
    );

    // Mirror the canvas DOM the focus restore queries: the selected tab layer
    // (an ancestor with `tabIndex=-1`) wraps the editable artifact body, just
    // like pane → tab layer → ProseMirror surface in the app.
    const paneEl = document.createElement("div");
    paneEl.setAttribute("data-group-id", "pane-current");
    paneEl.setAttribute("data-active", "true");
    paneEl.tabIndex = -1;
    const tileEl = document.createElement("div");
    tileEl.setAttribute("data-tab-instance-id", "tile-current");
    tileEl.setAttribute("data-selected", "true");
    tileEl.tabIndex = -1;
    const editorEl = document.createElement("textarea");
    tileEl.appendChild(editorEl);
    paneEl.appendChild(tileEl);
    document.body.appendChild(paneEl);

    try {
      const hook = renderHook(
        (intent: EpicRouteFocusIntent) => useEpicRouteSynchronization(intent),
        {
          initialProps: {
            epicId: EPIC_ID,
            tabId: TAB_ID,
            focusedAt: undefined,
            focusArtifactId: undefined,
            focusThreadId: undefined,
            focusPaneId: "pane-current",
            focusTileInstanceId: "tile-current",
          },
        },
      );

      // First application of the target legitimately restores focus to the tab
      // container - a genuine tab switch has no deeper focus to preserve.
      await waitFor(() => {
        expect(document.activeElement).toBe(tileEl);
      });

      // The user clicks into the body and starts typing.
      editorEl.focus();
      expect(document.activeElement).toBe(editorEl);

      // A title rename (Notion-style doc-title-follow, or a tab rename) mutates
      // the canvas, so `useEpicCanvas` hands back a new identity and the focus
      // effect re-runs with the SAME, still-applied target. It must not yank
      // focus back up to the tab container and eject the user from edit mode.
      testState.canvasTiles = {
        "tile-current": specTile("artifact-current", "tile-current", "Renamed"),
      };
      hook.rerender({
        epicId: EPIC_ID,
        tabId: TAB_ID,
        focusedAt: undefined,
        focusArtifactId: undefined,
        focusThreadId: undefined,
        focusPaneId: "pane-current",
        focusTileInstanceId: "tile-current",
      });
      await flushFocusRestore();

      expect(document.activeElement).toBe(editorEl);
    } finally {
      paneEl.remove();
    }
  });

  it("preserves a newly opened portalled control while applying its pane route focus", async () => {
    testState.nestedFocusEnabled = true;
    setSinglePaneCanvas(
      "pane-current",
      [specTile("artifact-current", "tile-current", "Current artifact")],
      "tile-current",
    );

    const paneEl = document.createElement("div");
    paneEl.setAttribute("data-group-id", "pane-current");
    paneEl.setAttribute("data-active", "true");
    paneEl.tabIndex = -1;
    const tileEl = document.createElement("div");
    tileEl.setAttribute("data-tab-instance-id", "tile-current");
    tileEl.setAttribute("data-selected", "true");
    tileEl.tabIndex = -1;
    paneEl.appendChild(tileEl);
    document.body.appendChild(paneEl);

    const portalInput = document.createElement("input");
    portalInput.setAttribute("aria-label", "Portalled picker search");
    document.body.appendChild(portalInput);
    const activationView = render(
      <PaneActivationOriginBoundary>
        <button type="button">Open model picker</button>
      </PaneActivationOriginBoundary>,
      { container: tileEl },
    );

    try {
      fireEvent.pointerDown(
        screen.getByRole("button", { name: "Open model picker" }),
      );
      portalInput.focus();

      renderHook(
        (intent: EpicRouteFocusIntent) => useEpicRouteSynchronization(intent),
        {
          initialProps: {
            epicId: EPIC_ID,
            tabId: TAB_ID,
            focusedAt: undefined,
            focusArtifactId: undefined,
            focusThreadId: undefined,
            focusPaneId: "pane-current",
            focusTileInstanceId: "tile-current",
          },
        },
      );

      await flushFocusRestore();
      expect(document.activeElement).toBe(portalInput);
    } finally {
      activationView.unmount();
      portalInput.remove();
      paneEl.remove();
    }
  });

  it("restores a requested primary editor after applying nested pane focus", async () => {
    testState.nestedFocusEnabled = true;
    setSinglePaneCanvas(
      "pane-target",
      [specTile("chat-target", "tile-target", "Target chat")],
      "tile-target",
    );

    const sourceEditor = document.createElement("textarea");
    document.body.appendChild(sourceEditor);
    sourceEditor.focus();

    const paneEl = document.createElement("div");
    paneEl.setAttribute("data-group-id", "pane-target");
    paneEl.setAttribute("data-active", "true");
    paneEl.tabIndex = -1;
    const tileEl = document.createElement("div");
    tileEl.setAttribute("data-tab-instance-id", "tile-target");
    tileEl.setAttribute("data-selected", "true");
    tileEl.tabIndex = -1;
    const composer = document.createElement("div");
    composer.setAttribute("data-chat-composer", "");
    const targetEditor = document.createElement("div");
    targetEditor.setAttribute("data-composer-editor", "");
    targetEditor.setAttribute("role", "textbox");
    targetEditor.setAttribute("aria-label", "Target chat composer");
    targetEditor.tabIndex = 0;
    composer.appendChild(targetEditor);
    tileEl.appendChild(composer);
    paneEl.appendChild(tileEl);
    document.body.appendChild(paneEl);

    requestNestedRoutePrimaryEditorFocus(EPIC_ID, TAB_ID, {
      paneId: "pane-target",
      tileInstanceId: "tile-target",
    });

    try {
      renderHook(
        (intent: EpicRouteFocusIntent) => useEpicRouteSynchronization(intent),
        {
          initialProps: {
            epicId: EPIC_ID,
            tabId: TAB_ID,
            focusedAt: undefined,
            focusArtifactId: undefined,
            focusThreadId: undefined,
            focusPaneId: "pane-target",
            focusTileInstanceId: "tile-target",
          },
        },
      );

      await flushFocusRestore();
      expect(document.activeElement).toBe(
        screen.getByRole("textbox", { name: "Target chat composer" }),
      );
    } finally {
      sourceEditor.remove();
      paneEl.remove();
    }
  });

  it("does not re-focus the tile when a rename fires while focus sits outside it (tab-strip rename)", async () => {
    testState.nestedFocusEnabled = true;
    setSinglePaneCanvas(
      "pane-current",
      [specTile("artifact-current", "tile-current", "Current artifact")],
      "tile-current",
    );

    // The tab-strip rename input lives in the pane but OUTSIDE the tile layer,
    // mirroring the real DOM (strip is a sibling of the tab body).
    const paneEl = document.createElement("div");
    paneEl.setAttribute("data-group-id", "pane-current");
    paneEl.setAttribute("data-active", "true");
    paneEl.tabIndex = -1;
    const renameInputEl = document.createElement("input");
    const tileEl = document.createElement("div");
    tileEl.setAttribute("data-tab-instance-id", "tile-current");
    tileEl.setAttribute("data-selected", "true");
    tileEl.tabIndex = -1;
    paneEl.appendChild(renameInputEl);
    paneEl.appendChild(tileEl);
    document.body.appendChild(paneEl);

    try {
      const hook = renderHook(
        (intent: EpicRouteFocusIntent) => useEpicRouteSynchronization(intent),
        {
          initialProps: {
            epicId: EPIC_ID,
            tabId: TAB_ID,
            focusedAt: undefined,
            focusArtifactId: undefined,
            focusThreadId: undefined,
            focusPaneId: "pane-current",
            focusTileInstanceId: "tile-current",
          },
        },
      );

      // Tab was activated earlier: its focus restore has already run once.
      await waitFor(() => {
        expect(document.activeElement).toBe(tileEl);
      });

      // The user opens the tab's rename input and commits. Focus is in the
      // strip input (not the tile) and the commit mutates the canvas.
      renameInputEl.focus();
      expect(document.activeElement).toBe(renameInputEl);

      testState.canvasTiles = {
        "tile-current": specTile("artifact-current", "tile-current", "Renamed"),
      };
      hook.rerender({
        epicId: EPIC_ID,
        tabId: TAB_ID,
        focusedAt: undefined,
        focusArtifactId: undefined,
        focusThreadId: undefined,
        focusPaneId: "pane-current",
        focusTileInstanceId: "tile-current",
      });
      await flushFocusRestore();

      // The rename did not change the focus target, so the restore must not
      // fire and stamp the stray selection ring onto the tile.
      expect(document.activeElement).toBe(renameInputEl);
    } finally {
      paneEl.remove();
    }
  });

  it("ticket 21 slice 4: prefers the hosted record over the real selected physical wrapper (design-review F4)", async () => {
    testState.nestedFocusEnabled = true;
    setSinglePaneCanvas(
      "pane-hosted",
      [specTile("chat-hosted", "tile-hosted", "Hosted chat")],
      "tile-hosted",
    );

    // Physical pane AND the real selected-tab wrapper `TabGroupView` keeps
    // mounted around `TileSurfaceSlot`'s bare geometry anchor for a hosted
    // chat - both carry the SAME instanceId a naive physical-only query would
    // match first. Its presence must not shadow the hosted fallback.
    const paneEl = document.createElement("div");
    paneEl.setAttribute("data-group-id", "pane-hosted");
    paneEl.setAttribute("data-active", "true");
    paneEl.tabIndex = -1;
    document.body.appendChild(paneEl);

    const selectedWrapperEl = document.createElement("div");
    selectedWrapperEl.setAttribute("data-tab-instance-id", "tile-hosted");
    selectedWrapperEl.setAttribute("data-selected", "true");
    selectedWrapperEl.tabIndex = -1;
    document.body.appendChild(selectedWrapperEl);

    const hostedRecord = document.createElement("div");
    hostedRecord.setAttribute(HOSTED_TILE_INSTANCE_ID_ATTRIBUTE, "tile-hosted");
    hostedRecord.setAttribute(HOSTED_TILE_PANE_ID_ATTRIBUTE, "pane-hosted");
    hostedRecord.tabIndex = -1;
    document.body.appendChild(hostedRecord);

    // Park focus elsewhere so focusNestedRouteTarget will pull it onto the
    // resolved element (rather than no-opping because focus is already inside).
    const outside = document.createElement("button");
    outside.type = "button";
    document.body.appendChild(outside);
    outside.focus();
    expect(document.activeElement).toBe(outside);

    try {
      renderHook(
        (intent: EpicRouteFocusIntent) => useEpicRouteSynchronization(intent),
        {
          initialProps: {
            epicId: EPIC_ID,
            tabId: TAB_ID,
            focusedAt: undefined,
            focusArtifactId: undefined,
            focusThreadId: undefined,
            focusPaneId: "pane-hosted",
            focusTileInstanceId: "tile-hosted",
          },
        },
      );

      await flushFocusRestore();
      // Direct signal: focus landed on the hosted record, NOT the real
      // selected physical wrapper that is also present and would otherwise
      // be found first by the physical query.
      expect(document.activeElement).toBe(hostedRecord);
      expect(document.activeElement).not.toBe(selectedWrapperEl);
    } finally {
      outside.remove();
      hostedRecord.remove();
      selectedWrapperEl.remove();
      paneEl.remove();
    }
  });

  it("ticket 21 slice 4: falls back to the physical selected wrapper when no hosted record exists (switch-off parity)", async () => {
    testState.nestedFocusEnabled = true;
    setSinglePaneCanvas(
      "pane-unhosted",
      [specTile("chat-unhosted", "tile-unhosted", "Unhosted chat")],
      "tile-unhosted",
    );

    // No hosted record anywhere - mirrors the switch-off / non-chat-tile
    // shape, where `findHostedTileElement` always misses and the ORIGINAL
    // physical lookup must still resolve exactly as it did before F4.
    const selectedWrapperEl = document.createElement("div");
    selectedWrapperEl.setAttribute("data-tab-instance-id", "tile-unhosted");
    selectedWrapperEl.setAttribute("data-selected", "true");
    selectedWrapperEl.tabIndex = -1;
    document.body.appendChild(selectedWrapperEl);

    const outside = document.createElement("button");
    outside.type = "button";
    document.body.appendChild(outside);
    outside.focus();
    expect(document.activeElement).toBe(outside);

    try {
      renderHook(
        (intent: EpicRouteFocusIntent) => useEpicRouteSynchronization(intent),
        {
          initialProps: {
            epicId: EPIC_ID,
            tabId: TAB_ID,
            focusedAt: undefined,
            focusArtifactId: undefined,
            focusThreadId: undefined,
            focusPaneId: "pane-unhosted",
            focusTileInstanceId: "tile-unhosted",
          },
        },
      );

      await flushFocusRestore();
      expect(document.activeElement).toBe(selectedWrapperEl);
    } finally {
      outside.remove();
      selectedWrapperEl.remove();
    }
  });
});
