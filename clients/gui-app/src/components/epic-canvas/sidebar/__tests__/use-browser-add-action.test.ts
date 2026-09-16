import "../../../../../__tests__/test-browser-apis";
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
import type { ReactNode } from "react";
import { createElement } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { toast } from "sonner";
import { BrowserSessionsContext } from "@/components/epic-canvas/renderers/browser-sessions-context";
import type { BrowserSessionsState } from "@/components/epic-canvas/renderers/browser-sessions-context";
import { useAddBrowserAction } from "@/components/epic-canvas/sidebar/use-browser-add-action";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { getPipSnapshot, pipStore } from "@/lib/browser-view/pip/pip-store";
import {
  fakePrepareOpenTab,
  independentScope,
} from "@/lib/browser-view/sessions/__tests__/browser-session-test-kit";

const VIEW_TAB_ID = "view-tab-1";
const HOST_ID = "host-1";

const navigateNested = vi.fn(
  (_epicId: string, _tabId: string, prepare: () => unknown) => prepare(),
);

vi.mock("@/hooks/epic/use-epic-nested-focus-navigation", () => ({
  useEpicNestedFocusNavigation: () => navigateNested,
}));

vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));

const settingsState = vi.hoisted(() => ({
  browserPlacement: "split" as "split" | "pip",
}));

vi.mock("@/stores/settings/settings-store", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/stores/settings/settings-store")>();
  return {
    ...actual,
    useSettingsStore: Object.assign(vi.fn(), {
      getState: () => ({
        tilePlacement: {
          ...actual.DEFAULT_TILE_PLACEMENT_SETTINGS,
          default: "per-category",
          browser: settingsState.browserPlacement,
        },
      }),
    }),
  };
});

function seedCanvasTab(): void {
  useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
  useEpicCanvasStore.setState({
    tabsById: {
      [VIEW_TAB_ID]: { tabId: VIEW_TAB_ID, epicId: "epic-1", name: "Epic 1" },
    },
    openTabOrder: [VIEW_TAB_ID],
  });
}

function openBrowserTiles() {
  const canvas = useEpicCanvasStore.getState().canvasByTabId[VIEW_TAB_ID];
  if (canvas === undefined) return [];
  return Object.values(canvas.tilesByInstanceId).flatMap((tile) =>
    tile === undefined || tile.type !== "browser-session" ? [] : [tile],
  );
}

function deferredOpenTab(): {
  readonly openTab: BrowserSessionsState["openTab"];
  readonly resolve: (opened: {
    readonly sessionId: string;
    readonly tabId: string;
  }) => void;
  readonly reject: (error: Error) => void;
} {
  let resolve: ((opened: { sessionId: string; tabId: string }) => void) | null =
    null;
  let reject: ((error: Error) => void) | null = null;
  const promise = new Promise<{
    readonly sessionId: string;
    readonly tabId: string;
    readonly handoffToken: null;
  }>((res, rej) => {
    resolve = (opened) => res({ ...opened, handoffToken: null });
    reject = rej;
  });
  return {
    openTab: () => promise,
    resolve: (opened) => resolve?.(opened),
    reject: (error) => reject?.(error),
  };
}

function sessionsValue(
  openTab: BrowserSessionsState["openTab"],
): BrowserSessionsState {
  return {
    hostId: HOST_ID,
    lifecycle: "live",
    inventoryReady: true,
    canMaterializeElectron: false,
    connectionGeneration: 0,
    items: [],
    viewports: {},
    setViewport: () => Promise.reject(new Error("not used in this test")),
    reportViewport: () => undefined,
    errorMessage: null,
    retry: () => undefined,
    openTab,
    prepareOpenTab: fakePrepareOpenTab({
      hostId: () => HOST_ID,
      scope: independentScope(),
      openTab,
    }),
    closeTab: () => Promise.resolve(),
    attachTab: () => Promise.reject(new Error("not used in this test")),
    moveTab: () => Promise.reject(new Error("not used in this test")),
  };
}

function renderAddAction(
  sessions: BrowserSessionsState,
  onOpened: (() => void) | null,
) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  function Wrapper(props: { readonly children: ReactNode }) {
    return createElement(
      QueryClientProvider,
      { client: queryClient },
      createElement(
        BrowserSessionsContext.Provider,
        { value: sessions },
        props.children,
      ),
    );
  }
  const hook = renderHook(() => useAddBrowserAction(VIEW_TAB_ID, onOpened), {
    wrapper: Wrapper,
  });
  return { ...hook, queryClient };
}

describe("useAddBrowserAction", () => {
  beforeEach(() => {
    seedCanvasTab();
    navigateNested.mockClear();
    settingsState.browserPlacement = "split";
    vi.mocked(toast.error).mockClear();
    pipStore.setState({ snapshotByEpicId: {} });
  });

  afterEach(() => {
    cleanup();
    useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
    pipStore.setState({ snapshotByEpicId: {} });
  });

  it("commits a pending tile synchronously at click, before the host answers", () => {
    const deferred = deferredOpenTab();
    const { result } = renderAddAction(sessionsValue(deferred.openTab), null);

    act(() => {
      result.current.add();
    });

    // Synchronous with the call - no await, no microtask - since the tile
    // must be on screen the instant the reader clicks.
    expect(openBrowserTiles()).toMatchObject([
      { hostId: HOST_ID, sessionId: null, tabId: null },
    ]);
    expect(navigateNested).toHaveBeenCalledOnce();
  });

  it("calls onOpened synchronously at click on the pending path, and never again on success", async () => {
    const deferred = deferredOpenTab();
    const onOpened = vi.fn();
    const { result } = renderAddAction(
      sessionsValue(deferred.openTab),
      onOpened,
    );

    act(() => {
      result.current.add();
    });

    // Synchronous with the click - the pending tile is already committed, so
    // a surface that dismisses itself on "opened" (a mobile sheet) can do so
    // right away rather than waiting on the host round-trip.
    expect(onOpened).toHaveBeenCalledOnce();

    act(() => {
      deferred.resolve({ sessionId: "sess-1", tabId: "tab-1" });
    });
    await waitFor(() => {
      expect(openBrowserTiles()).toMatchObject([
        { sessionId: "sess-1", tabId: "tab-1" },
      ]);
    });

    // onSuccess returns early for a rebind (`opened.pending`) - it must not
    // fire onOpened a second time.
    expect(onOpened).toHaveBeenCalledOnce();
  });

  it("rebinds the same tile in place once the host answers, opening no second tile", async () => {
    const deferred = deferredOpenTab();
    const { result } = renderAddAction(sessionsValue(deferred.openTab), null);

    act(() => {
      result.current.add();
    });
    const pendingInstanceId = openBrowserTiles()[0]?.instanceId;

    await act(async () => {
      deferred.resolve({ sessionId: "sess-1", tabId: "tab-1" });
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(openBrowserTiles()).toMatchObject([
        { sessionId: "sess-1", tabId: "tab-1" },
      ]);
    });
    expect(openBrowserTiles()[0]?.instanceId).toBe(pendingInstanceId);
    // Exactly one navigation commit for the whole flow - the pending open,
    // never a second one on success.
    expect(navigateNested).toHaveBeenCalledOnce();
  });

  it("removes the pending tile and toasts when the host refuses", async () => {
    const deferred = deferredOpenTab();
    const { result } = renderAddAction(sessionsValue(deferred.openTab), null);

    act(() => {
      result.current.add();
    });
    expect(openBrowserTiles()).toHaveLength(1);

    await act(async () => {
      deferred.reject(new Error("device refused"));
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(openBrowserTiles()).toHaveLength(0);
    });
    expect(toast.error).toHaveBeenCalledWith("device refused");
  });

  it("re-checking add() while a request is in flight opens nothing a second time", () => {
    const deferred = deferredOpenTab();
    const { result } = renderAddAction(sessionsValue(deferred.openTab), null);

    act(() => {
      result.current.add();
      result.current.add();
    });

    expect(openBrowserTiles()).toHaveLength(1);
    expect(navigateNested).toHaveBeenCalledOnce();
  });

  it("a pip placement opens no pending tile, converts to pip only on the exact resolved tab, and calls onOpened only after", async () => {
    settingsState.browserPlacement = "pip";
    const deferred = deferredOpenTab();
    const openTabSpy = vi.fn(deferred.openTab);
    const prepareOpenTabSpy = vi.fn(() => {
      throw new Error(
        "prepareOpenTab must never be called on the pip placement path",
      );
    });
    const sessions: BrowserSessionsState = {
      ...sessionsValue(openTabSpy),
      prepareOpenTab: prepareOpenTabSpy,
    };
    const onOpened = vi.fn();
    const { result } = renderAddAction(sessions, onOpened);

    act(() => {
      result.current.add();
    });

    // Nothing on the canvas yet - the pip path never reserves a placeholder,
    // and it never touches `prepareOpenTab` at all (see R8/out-of-scope note:
    // pip keeps the pre-ticket openTab-then-onSuccess flow verbatim). Nor has
    // anything converted to pip yet, and `onOpened` has not fired - unlike the
    // pending/split path, this path only calls it after the host answers.
    expect(openBrowserTiles()).toHaveLength(0);
    expect(prepareOpenTabSpy).not.toHaveBeenCalled();
    expect(getPipSnapshot("epic-1").pendingTarget).toBeNull();
    expect(onOpened).not.toHaveBeenCalled();

    await waitFor(() => {
      expect(openTabSpy).toHaveBeenCalledWith(null, expect.any(String));
    });
    expect(onOpened).not.toHaveBeenCalled();

    act(() => {
      deferred.resolve({ sessionId: "sess-1", tabId: "tab-1" });
    });

    await waitFor(() => {
      expect(result.current.isAdding).toBe(false);
    });
    // Still no canvas tile: with `browser: "pip"` the resolved tab is
    // presented through the pip surface, not a canvas placement.
    expect(openBrowserTiles()).toHaveLength(0);
    expect(prepareOpenTabSpy).not.toHaveBeenCalled();
    // `onSuccess` really did convert-to-pip on the EXACT tab the host
    // answered with, on the epic the view tab belongs to - not a no-op that
    // merely stopped opening anything.
    expect(getPipSnapshot("epic-1").pendingTarget).toMatchObject({
      hostId: HOST_ID,
      sessionId: "sess-1",
      tabId: "tab-1",
    });
    expect(onOpened).toHaveBeenCalledOnce();
  });

  describe("render cost of a real click, flushSync scope included", () => {
    function renderClickHarness(
      openTab: BrowserSessionsState["openTab"],
      onOpened: () => void,
    ): { readonly counts: { addButton: number; canvasSubscriber: number } } {
      const counts = { addButton: 0, canvasSubscriber: 0 };
      const queryClient = new QueryClient({
        defaultOptions: {
          queries: { retry: false },
          mutations: { retry: false },
        },
      });
      function AddButton() {
        counts.addButton += 1;
        const { add } = useAddBrowserAction(VIEW_TAB_ID, onOpened);
        return createElement("button", { onClick: add }, "Add browser");
      }
      // Stands in for the mounted sidebar/inventory rows this hook shares a
      // render tree with - the flushSync's own justification ("commit the
      // new stream consumer before a mobile sheet releases its own") is a
      // claim about what these consumers see by the end of the click.
      function CanvasInventoryPlaceholder() {
        counts.canvasSubscriber += 1;
        const tileCount = useEpicCanvasStore(
          (state) =>
            Object.keys(
              state.canvasByTabId[VIEW_TAB_ID]?.tilesByInstanceId ?? {},
            ).length,
        );
        return createElement(
          "div",
          { "data-testid": "inventory-count" },
          String(tileCount),
        );
      }
      render(
        createElement(
          QueryClientProvider,
          { client: queryClient },
          createElement(
            BrowserSessionsContext.Provider,
            { value: sessionsValue(openTab) },
            createElement(AddButton),
            createElement(CanvasInventoryPlaceholder),
          ),
        ),
      );
      return { counts };
    }

    it("baseline: the placeholder is visible and onOpened has fired by the end of the click's own synchronous scope, with one commit each", () => {
      const deferred = deferredOpenTab();
      const onOpened = vi.fn();
      const { counts } = renderClickHarness(deferred.openTab, onOpened);
      const before = { ...counts };

      fireEvent.click(screen.getByRole("button", { name: "Add browser" }));

      // Everything below is asserted with NO await/microtask in between -
      // still inside the click's own call stack.
      expect(screen.getByTestId("inventory-count").textContent).toBe("1");
      expect(onOpened).toHaveBeenCalledOnce();

      // Baseline: the add button itself does not re-render on this click, and
      // the canvas subscriber renders exactly once - the flushSync-wrapped
      // commit, not a scheduled render plus a forced one.
      expect(counts.addButton - before.addButton).toBe(0);
      expect(counts.canvasSubscriber - before.canvasSubscriber).toBe(1);
    });

    it("a same-tick host answer still finds the pending tile already committed - `send()`'s own microtask, not the click, is what resolves it", async () => {
      // `openTab`/`send()` always resolves through a microtask even when the
      // underlying promise is already settled (Promise semantics), so this
      // proves ordering, not synchronous completion: the placeholder must
      // already be in the canvas by the time that microtask's `.then` runs,
      // which is what `flushSync` (commit before `observe()`/`mutate()`) is
      // actually for.
      const openTab: BrowserSessionsState["openTab"] = () =>
        Promise.resolve({
          sessionId: "sess-1",
          tabId: "tab-1",
          handoffToken: null,
        });
      const onOpened = vi.fn();
      renderClickHarness(openTab, onOpened);

      fireEvent.click(screen.getByRole("button", { name: "Add browser" }));

      // Still inside the click: the placeholder is pending, not yet resolved.
      expect(screen.getByTestId("inventory-count").textContent).toBe("1");

      await waitFor(() => {
        expect(openBrowserTiles()).toMatchObject([
          { sessionId: "sess-1", tabId: "tab-1" },
        ]);
      });
      // Rebinds the SAME tile in place - never a second one alongside it.
      expect(openBrowserTiles()).toMatchObject([
        { sessionId: "sess-1", tabId: "tab-1" },
      ]);
      expect(onOpened).toHaveBeenCalledOnce();
    });
  });
});
