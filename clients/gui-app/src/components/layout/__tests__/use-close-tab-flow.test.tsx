import "../../../../__tests__/test-browser-apis";
import { renderHook, act } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useCloseTabFlow } from "@/components/layout/dialogs/use-close-tab-flow";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { useLandingDraftStore } from "@/stores/home/landing-draft-store";
import { useTabsStore } from "@/stores/tabs/store";
import { installTabSyncCoordinator } from "@/lib/tab-sync/tab-sync-coordinator";
import * as TabNav from "@/lib/tab-navigation";

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

vi.mock("@/lib/registries/epic-session-registry", () => ({
  epicHasUnsyncedEdits: () => false,
  releaseOpenEpicSessionIfUnused: () => undefined,
  getOpenEpicRegistry: () => ({ subscribe: () => () => undefined }),
}));

function resetStores(): void {
  useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
  useLandingDraftStore.setState({ drafts: [], activeDraftId: null });
  useTabsStore.setState({
    stripOrder: [],
    systemTabs: { history: null, settings: null },
  });
}

describe("useCloseTabFlow", () => {
  beforeEach(() => {
    routerState.pathname = "/";
    navigateSpy.mockReset();
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
        name: "Beta",
        route: `/epics/epic-b/${b}`,
        icon: null,
        canDuplicate: true,
        canOpenInNewWindow: true,
      });
    });

    expect(useEpicCanvasStore.getState().openTabOrder).not.toContain(b);
    expect(spy).not.toHaveBeenCalled();
  });
});
