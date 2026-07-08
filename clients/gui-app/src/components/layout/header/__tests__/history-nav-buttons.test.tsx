import "../../../../../__tests__/test-browser-apis";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
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
import { TooltipProvider } from "@/components/ui/tooltip";
import { createPersistentMemoryHistory } from "@/lib/persistent-history";
import { HistoryNavButtons } from "@/components/layout/header/history-nav-buttons";

const WINDOW_ID = "history-nav-buttons-test-window";

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

function renderButtons(router: AppRouter) {
  return render(
    <RouterContextProvider router={router}>
      <TooltipProvider>
        <HistoryNavButtons />
      </TooltipProvider>
    </RouterContextProvider>,
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

describe("HistoryNavButtons", () => {
  it("exposes back and forward buttons by accessible name", () => {
    renderButtons(
      makeRouter(seedPersistentHistory(["/draft/d1", "/epics/e1/t2"], 1)),
    );
    expect(screen.getByRole("button", { name: "Go back" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Go forward" })).toBeTruthy();
  });

  it("reflects canGoBack/canGoForward in the disabled state", () => {
    // Index 0 of 2: only forward is navigable.
    renderButtons(
      makeRouter(seedPersistentHistory(["/draft/d1", "/epics/e1/t2"], 0)),
    );
    expect(
      screen.getByRole("button", { name: "Go back" }).hasAttribute("disabled"),
    ).toBe(true);
    expect(
      screen
        .getByRole("button", { name: "Go forward" })
        .hasAttribute("disabled"),
    ).toBe(false);
  });

  it("renders nothing under memory/browser history (feature inert outside Electron)", () => {
    renderButtons(makeRouter(createMemoryHistory({ initialEntries: ["/"] })));
    expect(screen.queryByRole("button", { name: "Go back" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Go forward" })).toBeNull();
  });

  it("steps the current router history back when the enabled back arrow is clicked", () => {
    const history = seedPersistentHistory(["/draft/d1", "/epics/e1/t2"], 1);
    const router = makeRouter(history);
    const goSpy = vi.spyOn(history, "go").mockImplementation(() => {});
    renderButtons(router);

    fireEvent.click(screen.getByRole("button", { name: "Go back" }));

    expect(goSpy).toHaveBeenCalledWith(-1);
  });

  it("steps the current router history forward when the enabled forward arrow is clicked", () => {
    const history = seedPersistentHistory(["/draft/d1", "/epics/e1/t2"], 0);
    const router = makeRouter(history);
    const goSpy = vi.spyOn(history, "go").mockImplementation(() => {});
    renderButtons(router);

    fireEvent.click(screen.getByRole("button", { name: "Go forward" }));

    expect(goSpy).toHaveBeenCalledWith(1);
  });
});
