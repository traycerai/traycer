import "../../../../__tests__/test-browser-apis";
import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  pickNeighborForClose,
  useNeighborTabPicker,
} from "@/components/layout/tabs/use-neighbor-tab-picker";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { useLandingDraftStore } from "@/stores/home/landing-draft-store";
import { useTabsStore } from "@/stores/tabs/store";
import { installTabSyncCoordinator } from "@/lib/tab-sync/tab-sync-coordinator";
import * as TabNav from "@/lib/tab-navigation";
import type { HeaderTab } from "@/stores/tabs/types";

installTabSyncCoordinator({ readyPromise: Promise.resolve() });

const routerState = vi.hoisted(() => ({ pathname: "/" }));
const navigateSpy = vi.hoisted(() => vi.fn());

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

function resetStores(): void {
  useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
  useLandingDraftStore.setState({ drafts: [], activeDraftId: null });
  useTabsStore.setState({
    stripOrder: [],
    systemTabs: { history: null, settings: null },
  });
}

function epicHeaderTab(tabId: string, epicId: string, name: string): HeaderTab {
  return {
    kind: "epic",
    id: tabId,
    epicId,
    name,
    route: `/epics/${epicId}/${tabId}`,
    icon: null,
    canDuplicate: true,
    canOpenInNewWindow: true,
  };
}

describe("useNeighborTabPicker", () => {
  beforeEach(() => {
    routerState.pathname = "/";
    navigateSpy.mockReset();
    resetStores();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    resetStores();
  });

  it("captures wasActive=true and the previous tab when closing the active tab", () => {
    const a = useEpicCanvasStore.getState().openEpicTab("epic-a", "Alpha");
    const b = useEpicCanvasStore.getState().openEpicTab("epic-b", "Beta");
    useEpicCanvasStore.getState().openEpicTab("epic-c", "Gamma");
    routerState.pathname = `/epics/epic-b/${b}`;

    const { result } = renderHook(() => useNeighborTabPicker());
    const captured = result.current.capture(epicHeaderTab(b, "epic-b", "Beta"));
    expect(captured.wasActive).toBe(true);
    expect(captured.neighbor).toEqual(epicHeaderTab(a, "epic-a", "Alpha"));
    // closing the leftmost tab focuses the new leftmost
    expect(pickNeighborForClose(epicHeaderTab(a, "epic-a", "Alpha"))).toEqual(
      epicHeaderTab(b, "epic-b", "Beta"),
    );
  });

  it("captures wasActive=false and neighbor=null when closing a non-active tab", () => {
    const a = useEpicCanvasStore.getState().openEpicTab("epic-a", "Alpha");
    const b = useEpicCanvasStore.getState().openEpicTab("epic-b", "Beta");
    routerState.pathname = `/epics/epic-a/${a}`;

    const { result } = renderHook(() => useNeighborTabPicker());
    const captured = result.current.capture(epicHeaderTab(b, "epic-b", "Beta"));
    expect(captured.wasActive).toBe(false);
    expect(captured.neighbor).toBeNull();
  });

  it("navigateToCaptured routes through navigateToTabIntent for the neighbor", () => {
    const a = useEpicCanvasStore.getState().openEpicTab("epic-a", "Alpha");
    const b = useEpicCanvasStore.getState().openEpicTab("epic-b", "Beta");
    const spy = vi.spyOn(TabNav, "navigateToTabIntent").mockReturnValue();
    routerState.pathname = `/epics/epic-b/${b}`;

    const { result } = renderHook(() => useNeighborTabPicker());
    const captured = result.current.capture(epicHeaderTab(b, "epic-b", "Beta"));
    result.current.navigateToCaptured(captured);

    expect(spy).toHaveBeenCalledTimes(1);
    const [, intent] = spy.mock.calls[0];
    expect(intent).toMatchObject({ kind: "epic", tabId: a, epicId: "epic-a" });
  });

  it("navigateToCaptured is a no-op when the closing tab was not active", () => {
    const a = useEpicCanvasStore.getState().openEpicTab("epic-a", "Alpha");
    const b = useEpicCanvasStore.getState().openEpicTab("epic-b", "Beta");
    const spy = vi.spyOn(TabNav, "navigateToTabIntent").mockReturnValue();
    routerState.pathname = `/epics/epic-a/${a}`;

    const { result } = renderHook(() => useNeighborTabPicker());
    const captured = result.current.capture(epicHeaderTab(b, "epic-b", "Beta"));
    result.current.navigateToCaptured(captured);

    expect(spy).not.toHaveBeenCalled();
  });
});
