import { renderHook, act } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useCloseTabFlow } from "@/components/layout/dialogs/use-close-tab-flow";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { useLandingDraftStore } from "@/stores/home/landing-draft-store";
import { useTabsStore } from "@/stores/tabs/store";
import { selectHostFocusedRef } from "@/stores/tabs/selectors";
import { executeTabSplitCommand } from "@/stores/tabs/tab-split-commands";
import { installTabSyncCoordinator } from "@/lib/tab-sync/tab-sync-coordinator";
import * as TabNav from "@/lib/tab-navigation";
import type { HeaderTab } from "@/stores/tabs/types";

installTabSyncCoordinator({ readyPromise: Promise.resolve() });

const routerState = vi.hoisted(() => ({ pathname: "/" }));
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
  epicHasUnsyncedEdits: () => false,
  releaseOpenEpicSessionIfUnused: () => undefined,
  getOpenEpicRegistry: () => ({
    subscribe: () => () => undefined,
    peek: () => null,
  }),
  getEpicSessionHandleHostId: () => null,
}));

function resetStores(): void {
  useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
  useLandingDraftStore.setState({ drafts: [], activeDraftId: null });
  useTabsStore.setState({
    stripOrder: [],
    systemTabs: { history: null, settings: null },
  });
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
  };
}

describe("useCloseTabFlow", () => {
  beforeEach(() => {
    routerState.pathname = "/";
    navigateSpy.mockReset();
    requestCloseWindowSpy.mockClear();
    windowsBridgeState.bridge = null;
    resetStores();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    resetStores();
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
    expect(useLandingDraftStore.getState().drafts).toHaveLength(0);
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
    expect(useLandingDraftStore.getState().drafts).toHaveLength(0);
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
      });
    });

    expect(useEpicCanvasStore.getState().openTabOrder).toEqual([a, b]);
    expect(useTabsStore.getState().items).toEqual([
      expect.objectContaining({ id: "split-ab", kind: "split" }),
    ]);
    expect(spy).toHaveBeenCalledTimes(1);
  });
});
