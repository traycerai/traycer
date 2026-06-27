import "../../../../__tests__/test-browser-apis";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { act, cleanup, renderHook } from "@testing-library/react";
import {
  RouterContextProvider,
  createMemoryHistory,
  createRouter,
  type RouterHistory,
} from "@tanstack/react-router";
import { QueryClient } from "@tanstack/react-query";
import { routeTree } from "@/routeTree.gen";
import type { AppRouter } from "@/router";
import { useAuthStore } from "@/stores/auth/auth-store";
import {
  createPersistentMemoryHistory,
  getHistoryController,
} from "@/lib/persistent-history";
import { useHistoryNavAvailable } from "@/lib/history-navigation/use-history-nav-available";
import { useHistoryNavState } from "@/lib/history-navigation/use-history-nav-state";

const WINDOW_ID = "history-nav-test-window";

function storageKey(windowId: string): string {
  return `traycer-gui-app:last-route:${windowId}`;
}

function makeRouter(history: RouterHistory): AppRouter {
  return createRouter({
    routeTree,
    history,
    context: {
      queryClient: new QueryClient(),
      getAuthSnapshot: () => useAuthStore.getState(),
      getActiveHostId: () => null,
      getHostClient: () => null,
    },
  });
}

// Seed a multi-entry persistent stack via localStorage so the history boots with
// the desired entries/index without firing any navigation notification.
function seedPersistentHistory(
  entries: ReadonlyArray<string>,
  index: number,
): RouterHistory {
  window.localStorage.setItem(
    storageKey(WINDOW_ID),
    JSON.stringify({ entries, index }),
  );
  return createPersistentMemoryHistory(null, WINDOW_ID);
}

function wrapperFor(router: AppRouter) {
  return ({ children }: { readonly children: ReactNode }) => (
    <RouterContextProvider router={router}>{children}</RouterContextProvider>
  );
}

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  window.localStorage.clear();
});

describe("useHistoryNavAvailable", () => {
  it("is false under browser/memory history", () => {
    const router = makeRouter(createMemoryHistory({ initialEntries: ["/"] }));
    const { result } = renderHook(() => useHistoryNavAvailable(), {
      wrapper: wrapperFor(router),
    });
    expect(result.current).toBe(false);
  });

  it("is true under persistent (Electron) history", () => {
    const router = makeRouter(seedPersistentHistory(["/epics/e1/t1"], 0));
    const { result } = renderHook(() => useHistoryNavAvailable(), {
      wrapper: wrapperFor(router),
    });
    expect(result.current).toBe(true);
  });
});

describe("useHistoryNavState", () => {
  it("reports disabled state under memory history", () => {
    const router = makeRouter(createMemoryHistory({ initialEntries: ["/"] }));
    const { result } = renderHook(() => useHistoryNavState(), {
      wrapper: wrapperFor(router),
    });
    expect(result.current).toEqual({ canGoBack: false, canGoForward: false });
  });

  it("derives canGoBack/canGoForward from the seeded stack position", () => {
    // Stack of 3 sitting in the middle: can go both ways.
    const router = makeRouter(
      seedPersistentHistory(["/epics/e1/t1", "/draft/d1", "/epics/e1/t2"], 1),
    );
    const { result } = renderHook(() => useHistoryNavState(), {
      wrapper: wrapperFor(router),
    });
    expect(result.current).toEqual({ canGoBack: true, canGoForward: true });
  });

  it("updates on a controller prune WITHOUT forcing a route load", () => {
    const history = seedPersistentHistory(
      ["/epics/e1/t1", "/draft/d1", "/epics/e1/t2"],
      0,
    );
    const router = makeRouter(history);
    const loadSpy = vi.spyOn(router, "load");

    const { result } = renderHook(() => useHistoryNavState(), {
      wrapper: wrapperFor(router),
    });
    // At index 0 of 3: forward only.
    expect(result.current).toEqual({ canGoBack: false, canGoForward: true });

    const controller = getHistoryController(history);
    expect(controller).not.toBeNull();
    if (controller === null) return;

    // Prune both forward entries (everything but the current entry).
    act(() => {
      controller.prune((href) => href !== "/epics/e1/t1");
    });

    // The arrows recompute purely from the controller subscription.
    expect(result.current).toEqual({ canGoBack: false, canGoForward: false });
    // Prune is load-free: it must never drive router.load().
    expect(loadSpy).not.toHaveBeenCalled();
  });
});
