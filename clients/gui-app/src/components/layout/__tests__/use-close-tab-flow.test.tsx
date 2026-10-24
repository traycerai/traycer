import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { toast } from "sonner";
import { useCloseTabFlow } from "@/components/layout/dialogs/use-close-tab-flow";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { useLandingDraftStore } from "@/stores/home/landing-draft-store";
import { useTabsStore } from "@/stores/tabs/store";
import { selectHostFocusedRef } from "@/stores/tabs/selectors";
import { tabItemId, tabRefKey } from "@/stores/tabs/layout";
import { executeTabSplitCommand } from "@/stores/tabs/tab-split-commands";
import { installTabSyncCoordinator } from "@/lib/tab-sync/tab-sync-coordinator";
import { useTabRecoveryHistory } from "@/lib/tab-recovery/history";
import * as TabNav from "@/lib/tab-navigation";
import type { HeaderTab } from "@/stores/tabs/types";
import type {
  OrganizationAction,
  OrganizationView,
} from "@traycer/protocol/host/organization/contracts";

installTabSyncCoordinator({ readyPromise: Promise.resolve() });

const routerState = vi.hoisted(() => ({ pathname: "/" }));
const mockUnsynced = vi.hoisted(() => ({ epicIds: new Set<string>() }));
const navigateSpy = vi.hoisted(() => vi.fn());
const requestCloseWindowSpy = vi.hoisted(() =>
  vi.fn((_windowId: string) => Promise.resolve()),
);
const windowsBridgeState = vi.hoisted(() => ({
  bridge: null as {
    readonly windowId: string;
    readonly requestClose: typeof requestCloseWindowSpy;
  } | null,
}));

const organizationState = vi.hoisted(() => {
  let view: OrganizationView = {
    catalog: [],
    groups: { version: "0", groups: [], memberships: [] },
    appearances: [],
    taskLabels: {},
    ready: true,
    authenticationRequired: false,
    pending: [],
    failures: [],
  };
  const command = vi.fn<(action: OrganizationAction) => Promise<void>>(() =>
    Promise.resolve(),
  );
  const context = {
    supported: true,
    userId: "user-1",
    get view() {
      return view;
    },
    register: () => () => undefined,
    openDialog: () => undefined,
    command,
    refresh: () => Promise.resolve(),
  };
  return {
    command,
    context,
    setView: (next: OrganizationView) => {
      view = next;
    },
  };
});

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => navigateSpy,
  useRouter: () => ({
    state: {
      location: {
        get pathname() {
          return routerState.pathname;
        },
      },
    },
  }),
  useRouterState: ({
    select,
  }: {
    select: (state: { location: { pathname: string } }) => unknown;
  }) => select({ location: { pathname: routerState.pathname } }),
}));

vi.mock("@/providers/windows-bridge-context", () => ({
  useWindowsBridge: () => windowsBridgeState.bridge,
}));

// `peek` / `getEpicSessionHandleHostId` are here because the epic tab's
// `build()` now PROJECTS the serving host off this registry. A partial mock of
// this module therefore reaches the tab projection, and every close flow in
// this file runs through `getHeaderTabs()`. `peek: () => null` is the honest
// answer for a harness with no live session: the tab gets `hostId: null` and
// its consumers fall back to the app-wide client.
vi.mock("@/lib/registries/epic-session-registry", () => ({
  epicHasUnsyncedEdits: (epicId: string) => mockUnsynced.epicIds.has(epicId),
  releaseOpenEpicSessionIfUnused: () => undefined,
  getOpenEpicRegistry: () => ({
    subscribe: () => () => undefined,
    peek: () => null,
  }),
  getEpicSessionHandleHostId: () => null,
  getEpicSessionHostId: () => null,
}));

vi.mock("@/hooks/organization/organization-context", () => ({
  useOrganization: () => organizationState.context,
}));

/**
 * A promise that records itself and every promise derived from it by `then`
 * or `catch`. The close flow hangs its commit and its rejection handler on
 * the promise the organization command returns, so awaiting the recorded set
 * is awaiting the end of that chain, not guessing how many turns it takes.
 */
class TrackedPromise<T> extends Promise<T> {
  static readonly created: Array<Promise<unknown>> = [];

  constructor(executor: ConstructorParameters<typeof Promise<T>>[0]) {
    super(executor);
    TrackedPromise.created.push(this);
  }
}

/** Resolves once every tracked command promise and its derived chain settled. */
async function commandChainSettled(): Promise<void> {
  await act(async () => {
    await Promise.allSettled([...TrackedPromise.created]);
  });
}

function rejectedCommand(message: string): void {
  organizationState.command.mockImplementation(() =>
    TrackedPromise.reject(new Error(message)),
  );
}

/** The command stays out until the returned function answers it. */
function holdCommand(): () => void {
  let accept: (() => void) | undefined;
  organizationState.command.mockImplementation(
    () =>
      new TrackedPromise<void>((resolve) => {
        accept = resolve;
      }),
  );
  return () => {
    if (accept === undefined)
      throw new Error("Expected a pending organization command");
    accept();
  };
}

function organizationView(
  memberships: OrganizationView["groups"]["memberships"],
): OrganizationView {
  return {
    catalog: [],
    groups: {
      version: "0",
      groups: [
        { groupId: "group-a", name: "Group A", color: "#8ab4f8", position: 0 },
      ],
      memberships,
    },
    appearances: [],
    taskLabels: {},
    ready: true,
    authenticationRequired: false,
    pending: [],
    failures: [],
  };
}

function resetOrganization(): void {
  organizationState.context.supported = true;
  TrackedPromise.created.length = 0;
  organizationState.command.mockReset();
  organizationState.command.mockImplementation(() => Promise.resolve());
  organizationState.setView(organizationView([]));
}

function resetStores(): void {
  useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
  useLandingDraftStore.setState({ drafts: [], activeDraftId: null });
  useTabsStore.setState({
    stripOrder: [],
    systemTabs: { history: null, settings: null },
  });
  useTabRecoveryHistory.setState({ entries: [], ready: true });
  mockUnsynced.epicIds.clear();
}

function epicHeaderTab(epicId: string, tabId: string, name: string): HeaderTab {
  return {
    kind: "epic",
    id: tabId,
    epicId,
    hostId: null,
    name,
    route: `/epics/${epicId}/${tabId}`,
    icon: null,
    canClose: true,
    canDuplicate: true,
    canOpenInNewWindow: true,
    appearance: null,
  };
}

function seedGroupedTabs() {
  const a = useEpicCanvasStore.getState().openEpicTab("epic-a", "Alpha");
  const b = useEpicCanvasStore.getState().openEpicTab("epic-b", "Beta");
  const c = useEpicCanvasStore.getState().openEpicTab("epic-c", "Gamma");
  const refA = { kind: "epic" as const, id: a };
  const refB = { kind: "epic" as const, id: b };
  const refC = { kind: "epic" as const, id: c };
  const refs = [refA, refB, refC];
  useTabsStore.setState({
    version: 2,
    items: refs.map((ref) => ({
      kind: "tab" as const,
      id: tabItemId(ref),
      ref,
    })),
    activeItemId: tabItemId(refA),
    stripOrder: refs,
    systemTabs: { history: null, settings: null },
    customizations: {
      [tabRefKey(refA)]: { color: null, icon: null, groupId: "group-a" },
      [tabRefKey(refB)]: { color: null, icon: null, groupId: "group-a" },
      [tabRefKey(refC)]: { color: null, icon: null, groupId: null },
    },
    groups: {
      "group-a": {
        name: "Group A",
        color: "#8ab4f8",
        collapsed: false,
      },
    },
  });
  routerState.pathname = `/epics/epic-a/${a}`;
  return { a, b, c, refA, refB, refC };
}

function CloseGroupHarness(props: {
  readonly groupId: string;
  readonly unrelatedTab: HeaderTab | null;
}) {
  const flow = useCloseTabFlow();
  const unrelatedTab = props.unrelatedTab;
  return (
    <>
      {flow.unsyncedDialog}
      <button
        type="button"
        data-testid="close-group"
        onClick={() => flow.closeGroup(props.groupId)}
      >
        close group
      </button>
      {unrelatedTab !== null ? (
        <button
          type="button"
          data-testid="close-unrelated"
          onClick={() => flow.requestCloseTab(unrelatedTab)}
        >
          close unrelated
        </button>
      ) : null}
    </>
  );
}

function CloseTabHarness(props: { readonly tab: HeaderTab }) {
  const flow = useCloseTabFlow();
  return (
    <>
      {flow.unsyncedDialog}
      <button
        type="button"
        data-testid="close-tab"
        onClick={() => flow.requestCloseTab(props.tab)}
      >
        close tab
      </button>
    </>
  );
}

function draftHeaderTab(draftId: string): HeaderTab {
  return {
    kind: "draft",
    id: draftId,
    route: `/draft/${draftId}`,
    name: "Start Page",
    icon: null,
    canDuplicate: false,
    canOpenInNewWindow: false,
    appearance: null,
  };
}

describe("useCloseTabFlow", () => {
  beforeEach(() => {
    routerState.pathname = "/";
    navigateSpy.mockReset();
    requestCloseWindowSpy.mockClear();
    windowsBridgeState.bridge = null;
    mockUnsynced.epicIds.clear();
    resetStores();
    resetOrganization();
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    resetStores();
    resetOrganization();
  });

  it("closing the active tab focuses the picked neighbor via navigateToTabIntent", () => {
    const a = useEpicCanvasStore.getState().openEpicTab("epic-a", "Alpha");
    const b = useEpicCanvasStore.getState().openEpicTab("epic-b", "Beta");
    routerState.pathname = `/epics/epic-b/${b}`;
    const spy = vi.spyOn(TabNav, "navigateToTabIntent").mockReturnValue();

    const { result } = renderHook(() => useCloseTabFlow());
    act(() => {
      result.current.closeActiveTab();
    });

    // The closed tab is gone from the canvas.
    expect(useEpicCanvasStore.getState().openTabOrder).not.toContain(b);
    // Focus moves to the previous-ordered tab through the seam.
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][1]).toMatchObject({
      kind: "epic",
      tabId: a,
      epicId: "epic-a",
    });
  });

  it("closes the desktop window instead of removing its only blank Start Page", () => {
    const draftId = useLandingDraftStore.getState().createDraft(null);
    routerState.pathname = `/draft/${draftId}`;
    windowsBridgeState.bridge = {
      windowId: "window-b",
      requestClose: requestCloseWindowSpy,
    };

    const { result } = renderHook(() => useCloseTabFlow());
    act(() => {
      result.current.requestCloseTab(draftHeaderTab(draftId));
    });

    expect(requestCloseWindowSpy).toHaveBeenCalledExactlyOnceWith("window-b");
    expect(useLandingDraftStore.getState().drafts).toHaveLength(1);
    expect(navigateSpy).not.toHaveBeenCalled();
  });

  it("keeps the recreate-Start-Page flow for a lone non-empty draft", () => {
    const draftId = useLandingDraftStore.getState().createDraft(null);
    useLandingDraftStore.getState().setDraftContent(
      draftId,
      {
        type: "doc",
        content: [
          { type: "paragraph", content: [{ type: "text", text: "Keep me" }] },
        ],
      },
      null,
    );
    routerState.pathname = `/draft/${draftId}`;
    windowsBridgeState.bridge = {
      windowId: "window-b",
      requestClose: requestCloseWindowSpy,
    };

    const { result } = renderHook(() => useCloseTabFlow());
    act(() => {
      result.current.requestCloseTab(draftHeaderTab(draftId));
    });

    expect(requestCloseWindowSpy).not.toHaveBeenCalled();
    expect(useLandingDraftStore.getState().drafts).toHaveLength(1);
    expect(useLandingDraftStore.getState().drafts[0].closed).toBe(true);
    expect(navigateSpy).toHaveBeenCalledWith({ to: "/" });
  });

  it("does not mistake an image-only draft for a blank Start Page", () => {
    const draftId = useLandingDraftStore.getState().createDraft(null);
    useLandingDraftStore.getState().setDraftContent(
      draftId,
      {
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [
              {
                type: "imageAttachment",
                attrs: {
                  id: "image-1",
                  fileName: "reference.png",
                  hash: "image-hash",
                  mimeType: "image/png",
                  size: 42,
                },
              },
            ],
          },
        ],
      },
      null,
    );
    routerState.pathname = `/draft/${draftId}`;
    windowsBridgeState.bridge = {
      windowId: "window-b",
      requestClose: requestCloseWindowSpy,
    };

    const { result } = renderHook(() => useCloseTabFlow());
    act(() => {
      result.current.requestCloseTab(draftHeaderTab(draftId));
    });

    expect(requestCloseWindowSpy).not.toHaveBeenCalled();
    expect(useLandingDraftStore.getState().drafts).toHaveLength(1);
    expect(useLandingDraftStore.getState().drafts[0].closed).toBe(true);
    expect(navigateSpy).toHaveBeenCalledWith({ to: "/" });
  });

  it("closes a recreated blank Start Page on the next close gesture", () => {
    const epicId = useEpicCanvasStore
      .getState()
      .openEpicTab("epic-only", "Only task");
    routerState.pathname = `/epics/epic-only/${epicId}`;
    windowsBridgeState.bridge = {
      windowId: "window-b",
      requestClose: requestCloseWindowSpy,
    };
    const { result, rerender } = renderHook(() => useCloseTabFlow());

    act(() => {
      result.current.closeActiveTab();
    });
    expect(requestCloseWindowSpy).not.toHaveBeenCalled();
    expect(navigateSpy).toHaveBeenCalledWith({ to: "/" });

    const recreatedDraftId = useLandingDraftStore.getState().createDraft(null);
    routerState.pathname = `/draft/${recreatedDraftId}`;
    rerender();
    act(() => {
      result.current.closeActiveTab();
    });

    expect(requestCloseWindowSpy).toHaveBeenCalledExactlyOnceWith("window-b");
    expect(useLandingDraftStore.getState().drafts).toHaveLength(1);
  });

  it("closes the route-backed tab when a split focuses its fillable half", () => {
    // "Add tab to new split view" lands focus on the EMPTY half, so the split
    // keeps `focusedSide: "right"` with `routeBackingSide: "left"` - the one
    // state where the two diverge, because a side that holds no tab can never
    // back the route. `selectHostFocusedRef` reads null there, so gating the
    // close on it made Cmd+W silently do nothing right after the split command.
    const a = useEpicCanvasStore.getState().openEpicTab("epic-a", "Alpha");
    routerState.pathname = `/epics/epic-a/${a}`;

    expect(executeTabSplitCommand("add", { kind: "epic", id: a })).toBe(true);
    const split = useTabsStore.getState().items[0];
    expect(split).toMatchObject({
      kind: "split",
      left: { kind: "tab", ref: { kind: "epic", id: a } },
      right: { kind: "empty" },
      focusedSide: "right",
      routeBackingSide: "left",
    });
    expect(selectHostFocusedRef(useTabsStore.getState())).toBeNull();

    const { result } = renderHook(() => useCloseTabFlow());
    act(() => {
      result.current.closeActiveTab();
    });

    expect(useEpicCanvasStore.getState().openTabOrder).not.toContain(a);
  });

  it("does not call navigateToTabIntent when closing a non-active tab", () => {
    const a = useEpicCanvasStore.getState().openEpicTab("epic-a", "Alpha");
    const b = useEpicCanvasStore.getState().openEpicTab("epic-b", "Beta");
    routerState.pathname = `/epics/epic-a/${a}`;
    const spy = vi.spyOn(TabNav, "navigateToTabIntent").mockReturnValue();

    const { result } = renderHook(() => useCloseTabFlow());
    act(() => {
      result.current.requestCloseTab({
        kind: "epic",
        id: b,
        epicId: "epic-b",
        hostId: null,
        name: "Beta",
        route: `/epics/epic-b/${b}`,
        icon: null,
        canClose: true,
        canDuplicate: true,
        canOpenInNewWindow: true,
        appearance: null,
      });
    });

    expect(useEpicCanvasStore.getState().openTabOrder).not.toContain(b);
    expect(spy).not.toHaveBeenCalled();
  });

  it("keeps every member of the invoked split when closing other strip items", () => {
    const a = useEpicCanvasStore.getState().openEpicTab("epic-a", "Alpha");
    const b = useEpicCanvasStore.getState().openEpicTab("epic-b", "Beta");
    const c = useEpicCanvasStore.getState().openEpicTab("epic-c", "Gamma");
    useTabsStore.setState({
      version: 2,
      items: [
        {
          kind: "split",
          id: "split-ab",
          left: { kind: "tab", ref: { kind: "epic", id: a } },
          right: { kind: "tab", ref: { kind: "epic", id: b } },
          focusedSide: "left",
          routeBackingSide: "left",
          leftRatio: 0.5,
        },
        { kind: "tab", id: `tab:epic:${c}`, ref: { kind: "epic", id: c } },
      ],
      activeItemId: "split-ab",
      stripOrder: [
        { kind: "epic", id: a },
        { kind: "epic", id: b },
        { kind: "epic", id: c },
      ],
      systemTabs: { history: null, settings: null },
    });
    const spy = vi.spyOn(TabNav, "navigateToTabIntent").mockReturnValue();
    const { result } = renderHook(() => useCloseTabFlow());

    act(() => {
      result.current.closeOtherTabs({
        kind: "epic",
        id: a,
        epicId: "epic-a",
        hostId: null,
        name: "Alpha",
        route: `/epics/epic-a/${a}`,
        icon: null,
        canClose: true,
        canDuplicate: true,
        canOpenInNewWindow: true,
        appearance: null,
      });
    });

    expect(useEpicCanvasStore.getState().openTabOrder).toEqual([a, b]);
    expect(useTabsStore.getState().items).toEqual([
      expect.objectContaining({ id: "split-ab", kind: "split" }),
    ]);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("batches recovery entries when closing a tab group", () => {
    const { a, b, refC } = seedGroupedTabs();

    const { result } = renderHook(() => useCloseTabFlow());
    act(() => {
      result.current.closeGroup("group-a");
    });

    expect(useTabRecoveryHistory.getState().entries).toHaveLength(1);
    const recovery = useTabRecoveryHistory.getState().entries.at(0);
    if (recovery === undefined) {
      throw new Error("expected one bulk header recovery entry");
    }
    expect(recovery.bulk).toBe(true);
    expect(recovery.items.map((item) => item.kind)).toEqual(["epic", "epic"]);
    expect(
      new Set(
        recovery.items.flatMap((item) =>
          item.kind === "epic" ? [item.tab.tabId] : [],
        ),
      ),
    ).toEqual(new Set([a, b]));
    expect(useTabsStore.getState().stripOrder).toEqual([refC]);
  });

  it("confirms a dirty active group close as one bulk recovery action", () => {
    const { a, b, refA, refB, refC } = seedGroupedTabs();
    mockUnsynced.epicIds.add("epic-a");

    render(<CloseGroupHarness groupId="group-a" unrelatedTab={null} />);
    fireEvent.click(screen.getByTestId("close-group"));
    expect(screen.getByTestId("epic-tab-unsynced-dialog")).toBeDefined();
    expect(useTabRecoveryHistory.getState().entries).toEqual([]);
    expect(useTabsStore.getState().stripOrder).toEqual([refA, refB, refC]);

    fireEvent.click(screen.getByTestId("epic-tab-unsynced-discard"));

    expect(useTabRecoveryHistory.getState().entries).toHaveLength(1);
    const recovery = useTabRecoveryHistory.getState().entries.at(0);
    if (recovery === undefined) {
      throw new Error("expected one bulk header recovery entry");
    }
    expect(recovery.bulk).toBe(true);
    const recoveredIds = recovery.items.flatMap((item) =>
      item.kind === "epic" ? [item.tab.tabId] : [],
    );
    expect(new Set(recoveredIds)).toEqual(new Set([a, b]));
    expect(useTabsStore.getState().stripOrder).toEqual([refC]);
  });

  it("cancels a dirty active group close without changing tabs or history", () => {
    const { refA, refB, refC } = seedGroupedTabs();
    mockUnsynced.epicIds.add("epic-a");

    render(<CloseGroupHarness groupId="group-a" unrelatedTab={null} />);
    fireEvent.click(screen.getByTestId("close-group"));
    fireEvent.click(screen.getByTestId("epic-tab-unsynced-wait"));

    expect(useTabRecoveryHistory.getState().entries).toEqual([]);
    expect(useTabsStore.getState().stripOrder).toEqual([refA, refB, refC]);
  });

  it("keeps an unrelated close separate while group confirmation is pending", () => {
    const { a, b, c, refA, refB } = seedGroupedTabs();
    mockUnsynced.epicIds.add("epic-a");

    render(
      <CloseGroupHarness
        groupId="group-a"
        unrelatedTab={epicHeaderTab("epic-c", c, "Gamma")}
      />,
    );
    fireEvent.click(screen.getByTestId("close-group"));
    fireEvent.click(screen.getByTestId("close-unrelated"));

    expect(useTabRecoveryHistory.getState().entries).toHaveLength(1);
    const unrelatedRecovery = useTabRecoveryHistory.getState().entries.at(0);
    if (unrelatedRecovery === undefined) {
      throw new Error("expected unrelated header recovery entry");
    }
    expect(unrelatedRecovery.bulk).toBe(false);
    expect(unrelatedRecovery.items).toHaveLength(1);
    expect(unrelatedRecovery.items[0]).toMatchObject({
      kind: "epic",
      tab: { tabId: c },
    });
    expect(useTabsStore.getState().stripOrder).toEqual([refA, refB]);

    fireEvent.click(screen.getByTestId("epic-tab-unsynced-discard"));
    expect(useTabRecoveryHistory.getState().entries).toHaveLength(2);
    const groupRecovery = useTabRecoveryHistory.getState().entries.at(1);
    if (groupRecovery === undefined) {
      throw new Error("expected group header recovery entry");
    }
    expect(groupRecovery.bulk).toBe(true);
    const groupRecoveredIds = groupRecovery.items.flatMap((item) =>
      item.kind === "epic" ? [item.tab.tabId] : [],
    );
    expect(new Set(groupRecoveredIds)).toEqual(new Set([a, b]));
  });

  it("removes cloud membership before closing an individually closed task", async () => {
    const tabId = useEpicCanvasStore
      .getState()
      .openEpicTab("epic-cloud", "Cloud task");
    organizationState.setView(
      organizationView([
        { taskId: "epic-cloud", groupId: "group-a", position: 0 },
      ]),
    );
    let resolveCommand: (() => void) | undefined;
    organizationState.command.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveCommand = resolve;
        }),
    );

    const { result } = renderHook(() => useCloseTabFlow());
    act(() => {
      result.current.requestCloseTab(
        epicHeaderTab("epic-cloud", tabId, "Cloud task"),
      );
    });

    expect(organizationState.command).toHaveBeenCalledOnce();
    expect(organizationState.command.mock.calls[0]?.[0]).toEqual({
      kind: "groups",
      operations: [{ operation: "removeTask", taskId: "epic-cloud" }],
    });
    expect(useEpicCanvasStore.getState().openTabOrder).toContain(tabId);

    if (resolveCommand === undefined) {
      throw new Error("Expected a pending organization command");
    }
    const resolve = resolveCommand;
    act(() => resolve());
    await waitFor(() =>
      expect(useEpicCanvasStore.getState().openTabOrder).not.toContain(tabId),
    );
  });

  it("keeps cloud membership when another tab for the same task remains open", async () => {
    const firstTabId = useEpicCanvasStore
      .getState()
      .openEpicTab("epic-duplicate", "First view");
    const secondTabId = useEpicCanvasStore
      .getState()
      .openEpicTab("epic-duplicate", "Second view");
    organizationState.setView(
      organizationView([
        { taskId: "epic-duplicate", groupId: "group-a", position: 0 },
      ]),
    );

    const { result } = renderHook(() => useCloseTabFlow());
    act(() => {
      result.current.requestCloseTab(
        epicHeaderTab("epic-duplicate", firstTabId, "First view"),
      );
    });

    expect(organizationState.command).not.toHaveBeenCalled();
    expect(useEpicCanvasStore.getState().openTabOrder).toEqual([secondTabId]);

    act(() => {
      result.current.requestCloseTab(
        epicHeaderTab("epic-duplicate", secondTabId, "Second view"),
      );
    });
    await waitFor(() =>
      expect(organizationState.command).toHaveBeenCalledOnce(),
    );
    expect(organizationState.command.mock.calls[0]?.[0]).toEqual({
      kind: "groups",
      operations: [{ operation: "removeTask", taskId: "epic-duplicate" }],
    });
    await waitFor(() =>
      expect(useEpicCanvasStore.getState().openTabOrder).toEqual([]),
    );
  });

  it("leaves an individually closed task open when membership removal is rejected", async () => {
    const tabId = useEpicCanvasStore
      .getState()
      .openEpicTab("epic-rejected", "Rejected task");
    organizationState.setView(
      organizationView([
        { taskId: "epic-rejected", groupId: "group-a", position: 0 },
      ]),
    );
    rejectedCommand("membership rejected");

    const { result } = renderHook(() => useCloseTabFlow());
    act(() => {
      result.current.requestCloseTab(
        epicHeaderTab("epic-rejected", tabId, "Rejected task"),
      );
    });
    await commandChainSettled();

    expect(organizationState.command).toHaveBeenCalledOnce();
    expect(useEpicCanvasStore.getState().openTabOrder).toContain(tabId);
  });

  it("holds a grouped task's tab open and says why when the account's organization cannot take the removal", () => {
    const tabId = useEpicCanvasStore
      .getState()
      .openEpicTab("epic-unreachable", "Unreachable task");
    organizationState.setView(
      organizationView([
        { taskId: "epic-unreachable", groupId: "group-a", position: 0 },
      ]),
    );
    organizationState.context.supported = false;
    const errorToast = vi.spyOn(toast, "error").mockReturnValue("toast-id");

    try {
      const { result } = renderHook(() => useCloseTabFlow());
      act(() => {
        result.current.requestCloseTab(
          epicHeaderTab("epic-unreachable", tabId, "Unreachable task"),
        );
      });

      // The refusal and its toast are synchronous in the gesture.
      // Closing anyway would leave the account believing the task is still
      // grouped, so the tab stays and the removal is never attempted.
      expect(organizationState.command).not.toHaveBeenCalled();
      expect(useEpicCanvasStore.getState().openTabOrder).toContain(tabId);
      expect(errorToast).toHaveBeenCalledOnce();
      const [title, options] = errorToast.mock.calls[0] ?? [];
      expect(title).toBe("This tab can't be closed right now");
      expect(typeof options?.description).toBe("string");
    } finally {
      errorToast.mockRestore();
    }
  });

  describe("taking the closed tasks out of their group", () => {
    function removeTask(taskId: string): OrganizationAction {
      return {
        kind: "groups",
        operations: [{ operation: "removeTask", taskId }],
      };
    }

    function removeTasks(taskIds: readonly string[]): OrganizationAction {
      return {
        kind: "groups",
        operations: taskIds.map((taskId) => ({
          operation: "removeTask",
          taskId,
        })),
      };
    }

    it("Close group sends one command removing every member task from the group", async () => {
      const { refC } = seedGroupedTabs();
      organizationState.setView(
        organizationView([
          { taskId: "epic-a", groupId: "group-a", position: 0 },
          { taskId: "epic-b", groupId: "group-a", position: 1 },
        ]),
      );

      const { result } = renderHook(() => useCloseTabFlow());
      act(() => {
        result.current.closeGroup("group-a");
      });

      expect(organizationState.command).toHaveBeenCalledExactlyOnceWith(
        removeTasks(["epic-a", "epic-b"]),
      );
      // The tabs close only once that removal is accepted.
      await waitFor(() =>
        expect(useTabsStore.getState().stripOrder).toEqual([refC]),
      );
    });

    it("Close group keeps a task in its group while another of its tabs stays open", () => {
      const { a } = seedGroupedTabs();
      // A second tab for epic-b that is not part of the group being closed.
      useEpicCanvasStore.getState().openEpicTab("epic-b", "Beta, other view");
      routerState.pathname = `/epics/epic-a/${a}`;
      organizationState.setView(
        organizationView([
          { taskId: "epic-a", groupId: "group-a", position: 0 },
          { taskId: "epic-b", groupId: "group-a", position: 1 },
        ]),
      );

      const { result } = renderHook(() => useCloseTabFlow());
      act(() => {
        result.current.closeGroup("group-a");
      });

      expect(organizationState.command).toHaveBeenCalledExactlyOnceWith(
        removeTask("epic-a"),
      );
    });

    it("Close group keeps a task in its group when its tab is held back by unsynced edits", () => {
      const { b } = seedGroupedTabs();
      mockUnsynced.epicIds.add("epic-b");
      organizationState.setView(
        organizationView([
          { taskId: "epic-a", groupId: "group-a", position: 0 },
          { taskId: "epic-b", groupId: "group-a", position: 1 },
        ]),
      );

      const { result } = renderHook(() => useCloseTabFlow());
      act(() => {
        result.current.closeGroup("group-a");
      });

      expect(organizationState.command).toHaveBeenCalledExactlyOnceWith(
        removeTask("epic-a"),
      );
      expect(useEpicCanvasStore.getState().openTabOrder).toContain(b);
    });

    it("Close other tabs removes only the closed tasks from their group, not the kept tab's", async () => {
      const { a } = seedGroupedTabs();
      organizationState.setView(
        organizationView([
          { taskId: "epic-a", groupId: "group-a", position: 0 },
          { taskId: "epic-b", groupId: "group-a", position: 1 },
        ]),
      );

      const { result } = renderHook(() => useCloseTabFlow());
      act(() => {
        result.current.closeOtherTabs(epicHeaderTab("epic-a", a, "Alpha"));
      });

      expect(organizationState.command).toHaveBeenCalledExactlyOnceWith(
        removeTask("epic-b"),
      );
      await waitFor(() =>
        expect(useEpicCanvasStore.getState().openTabOrder).toEqual([a]),
      );
    });

    describe("until the account has accepted the ungroup", () => {
      function groupedMemberships(): void {
        organizationState.setView(
          organizationView([
            { taskId: "epic-a", groupId: "group-a", position: 0 },
            { taskId: "epic-b", groupId: "group-a", position: 1 },
          ]),
        );
      }

      it("Close group closes no tab while the command is pending, then closes them", async () => {
        const { refA, refB, refC } = seedGroupedTabs();
        groupedMemberships();
        const answerUngroup = holdCommand();

        const { result } = renderHook(() => useCloseTabFlow());
        act(() => {
          result.current.closeGroup("group-a");
        });

        expect(organizationState.command).toHaveBeenCalledOnce();
        expect(useTabsStore.getState().stripOrder).toEqual([refA, refB, refC]);
        expect(useTabRecoveryHistory.getState().entries).toEqual([]);

        answerUngroup();
        await commandChainSettled();
        await waitFor(() =>
          expect(useTabsStore.getState().stripOrder).toEqual([refC]),
        );
      });

      it("Close group closes nothing when the command is rejected", async () => {
        const { a, b, c, refA, refB, refC } = seedGroupedTabs();
        groupedMemberships();
        rejectedCommand("ungroup rejected");

        const { result } = renderHook(() => useCloseTabFlow());
        act(() => {
          result.current.closeGroup("group-a");
        });
        await commandChainSettled();

        expect(organizationState.command).toHaveBeenCalledOnce();
        expect(useTabsStore.getState().stripOrder).toEqual([refA, refB, refC]);
        expect(useEpicCanvasStore.getState().openTabOrder).toEqual([a, b, c]);
        expect(useTabRecoveryHistory.getState().entries).toEqual([]);
      });

      it("Close other tabs closes no tab while the command is pending, then closes them", async () => {
        const { a, b, c } = seedGroupedTabs();
        groupedMemberships();
        const answerUngroup = holdCommand();

        const { result } = renderHook(() => useCloseTabFlow());
        act(() => {
          result.current.closeOtherTabs(epicHeaderTab("epic-a", a, "Alpha"));
        });

        expect(organizationState.command).toHaveBeenCalledOnce();
        expect(useEpicCanvasStore.getState().openTabOrder).toEqual([a, b, c]);

        answerUngroup();
        await commandChainSettled();
        await waitFor(() =>
          expect(useEpicCanvasStore.getState().openTabOrder).toEqual([a]),
        );
      });

      it("Close other tabs closes nothing when the command is rejected", async () => {
        const { a, b, c, refA, refB, refC } = seedGroupedTabs();
        groupedMemberships();
        rejectedCommand("ungroup rejected");

        const { result } = renderHook(() => useCloseTabFlow());
        act(() => {
          result.current.closeOtherTabs(epicHeaderTab("epic-a", a, "Alpha"));
        });
        await commandChainSettled();

        expect(organizationState.command).toHaveBeenCalledOnce();
        expect(useTabsStore.getState().stripOrder).toEqual([refA, refB, refC]);
        expect(useEpicCanvasStore.getState().openTabOrder).toEqual([a, b, c]);
        expect(useTabRecoveryHistory.getState().entries).toEqual([]);
      });
    });

    describe("a tab that gains unsynced edits while the ungroup is in flight", () => {
      function groupedMemberships(): void {
        organizationState.setView(
          organizationView([
            { taskId: "epic-a", groupId: "group-a", position: 0 },
            { taskId: "epic-b", groupId: "group-a", position: 1 },
          ]),
        );
      }

      it("Close other tabs keeps it open and counts it in the toast, while the clean tab closes", async () => {
        const { a, b } = seedGroupedTabs();
        groupedMemberships();
        const warn = vi.spyOn(toast, "warning").mockReturnValue("toast-id");
        const answerUngroup = holdCommand();

        const { result } = renderHook(() => useCloseTabFlow());
        act(() => {
          result.current.closeOtherTabs(epicHeaderTab("epic-a", a, "Alpha"));
        });
        // The user types into Beta while the request is out.
        mockUnsynced.epicIds.add("epic-b");
        answerUngroup();
        await commandChainSettled();

        await waitFor(() =>
          expect(useEpicCanvasStore.getState().openTabOrder).toEqual([a, b]),
        );
        expect(warn.mock.calls.map(([message]) => message)).toEqual([
          'Kept "Beta" open with unsynced edits',
        ]);
      });

      it("Close group keeps it open and counts it in the toast, while the clean tab closes", async () => {
        const { b, c } = seedGroupedTabs();
        groupedMemberships();
        const warn = vi.spyOn(toast, "warning").mockReturnValue("toast-id");
        const answerUngroup = holdCommand();

        const { result } = renderHook(() => useCloseTabFlow());
        act(() => {
          result.current.closeGroup("group-a");
        });
        mockUnsynced.epicIds.add("epic-b");
        answerUngroup();
        await commandChainSettled();

        // Alpha (the active tab) closes with the group; Beta stays.
        await waitFor(() =>
          expect(useEpicCanvasStore.getState().openTabOrder).toEqual([b, c]),
        );
        expect(warn.mock.calls.map(([message]) => message)).toEqual([
          'Kept "Beta" open with unsynced edits',
        ]);
      });

      it("Close group keeps the active tab open and counts it when it was clean at the gesture and gained edits during the wait", async () => {
        const { a, c } = seedGroupedTabs();
        groupedMemberships();
        const warn = vi.spyOn(toast, "warning").mockReturnValue("toast-id");
        const answerUngroup = holdCommand();

        // No dialog: nothing is dirty when the gesture starts.
        const { result } = renderHook(() => useCloseTabFlow());
        act(() => {
          result.current.closeGroup("group-a");
        });
        expect(organizationState.command).toHaveBeenCalledOnce();

        // The user types into the active tab, which nobody asked about.
        mockUnsynced.epicIds.add("epic-a");
        answerUngroup();
        await commandChainSettled();

        // Beta closes; Alpha stays, along with the tab outside the group.
        await waitFor(() =>
          expect(useEpicCanvasStore.getState().openTabOrder).toEqual([a, c]),
        );
        expect(warn.mock.calls.map(([message]) => message)).toEqual([
          'Kept "Alpha" open with unsynced edits',
        ]);
      });

      it("Close tab keeps a grouped task open and says so when it was clean at the gesture and gained edits during the wait", async () => {
        const { a, b, c } = seedGroupedTabs();
        groupedMemberships();
        const warn = vi.spyOn(toast, "warning").mockReturnValue("toast-id");
        const answerUngroup = holdCommand();

        // No dialog: nothing is dirty when the gesture starts.
        const { result } = renderHook(() => useCloseTabFlow());
        act(() => {
          result.current.requestCloseTab(epicHeaderTab("epic-a", a, "Alpha"));
        });
        expect(organizationState.command).toHaveBeenCalledExactlyOnceWith(
          removeTask("epic-a"),
        );

        // The user types into the tab nobody asked about.
        mockUnsynced.epicIds.add("epic-a");
        answerUngroup();
        await commandChainSettled();

        // Waited for the toast first: the tab was open before the close, so
        // "still open" alone would hold for a close that never happened.
        await waitFor(() => expect(warn).toHaveBeenCalledOnce());
        expect(warn.mock.calls.map(([message]) => message)).toEqual([
          'Kept "Alpha" open with unsynced edits',
        ]);
        expect(useEpicCanvasStore.getState().openTabOrder).toEqual([a, b, c]);
      });

      it("Close tab still closes a grouped task whose discard the user confirmed, though it is dirty again when the ungroup lands", async () => {
        const { a, b, c } = seedGroupedTabs();
        groupedMemberships();
        const warn = vi.spyOn(toast, "warning").mockReturnValue("toast-id");
        const answerUngroup = holdCommand();
        // Dirty from the start, so the dialog asks and the user discards.
        mockUnsynced.epicIds.add("epic-a");

        render(<CloseTabHarness tab={epicHeaderTab("epic-a", a, "Alpha")} />);
        fireEvent.click(screen.getByTestId("close-tab"));
        fireEvent.click(screen.getByTestId("epic-tab-unsynced-discard"));
        await waitFor(() =>
          expect(organizationState.command).toHaveBeenCalledOnce(),
        );
        expect(organizationState.command).toHaveBeenCalledExactlyOnceWith(
          removeTask("epic-a"),
        );
        // CONTROL: the tab is still open and still dirty while the request
        // is out, so the close below is the commit and not an early one.
        expect(useEpicCanvasStore.getState().openTabOrder).toEqual([a, b, c]);

        answerUngroup();
        await commandChainSettled();

        // Still dirty at commit, and closed: the user confirmed that.
        await waitFor(() =>
          expect(useEpicCanvasStore.getState().openTabOrder).toEqual([b, c]),
        );
        expect(mockUnsynced.epicIds.has("epic-a")).toBe(true);
        expect(warn).not.toHaveBeenCalled();
      });

      it("Close group still closes the active tab whose discard the user confirmed, while a sibling that went dirty in the wait is kept", async () => {
        const { b, c } = seedGroupedTabs();
        groupedMemberships();
        const warn = vi.spyOn(toast, "warning").mockReturnValue("toast-id");
        const answerUngroup = holdCommand();
        // The active tab is dirty from the start, so the dialog asks.
        mockUnsynced.epicIds.add("epic-a");

        render(<CloseGroupHarness groupId="group-a" unrelatedTab={null} />);
        fireEvent.click(screen.getByTestId("close-group"));
        fireEvent.click(screen.getByTestId("epic-tab-unsynced-discard"));
        await waitFor(() =>
          expect(organizationState.command).toHaveBeenCalledOnce(),
        );

        mockUnsynced.epicIds.add("epic-b");
        answerUngroup();
        await commandChainSettled();

        // Alpha is still dirty, and still closes: the user confirmed that.
        await waitFor(() =>
          expect(useEpicCanvasStore.getState().openTabOrder).toEqual([b, c]),
        );
        expect(warn.mock.calls.map(([message]) => message)).toEqual([
          'Kept "Beta" open with unsynced edits',
        ]);
      });
    });

    it("Close other tabs keeps a task in its group while another of its tabs is the one kept", async () => {
      const keptTab = useEpicCanvasStore
        .getState()
        .openEpicTab("epic-x", "X, first view");
      const closedTab = useEpicCanvasStore
        .getState()
        .openEpicTab("epic-x", "X, second view");
      const otherTask = useEpicCanvasStore
        .getState()
        .openEpicTab("epic-y", "Y");
      const refs = [keptTab, closedTab, otherTask].map((id) => ({
        kind: "epic" as const,
        id,
      }));
      useTabsStore.setState({
        version: 2,
        items: refs.map((ref) => ({
          kind: "tab" as const,
          id: tabItemId(ref),
          ref,
        })),
        activeItemId: tabItemId(refs[0]),
        stripOrder: refs,
        systemTabs: { history: null, settings: null },
      });
      routerState.pathname = `/epics/epic-x/${keptTab}`;
      organizationState.setView(
        organizationView([
          { taskId: "epic-x", groupId: "group-a", position: 0 },
          { taskId: "epic-y", groupId: "group-a", position: 1 },
        ]),
      );

      const { result } = renderHook(() => useCloseTabFlow());
      act(() => {
        result.current.closeOtherTabs(
          epicHeaderTab("epic-x", keptTab, "X, first view"),
        );
      });

      expect(organizationState.command).toHaveBeenCalledExactlyOnceWith(
        removeTask("epic-y"),
      );
      await waitFor(() =>
        expect(useEpicCanvasStore.getState().openTabOrder).toEqual([keptTab]),
      );
    });
  });
});
