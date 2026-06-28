import "../../../__tests__/test-browser-apis";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import {
  createMemoryHistory,
  createRouter,
  type RouterHistory,
} from "@tanstack/react-router";
import { QueryClient } from "@tanstack/react-query";
import { routeTree } from "@/routeTree.gen";
import type { AppRouter } from "@/router";
import { useAuthStore } from "@/stores/auth/auth-store";
import { createPersistentMemoryHistory } from "@/lib/persistent-history";
import { getDefaultBindings } from "@/lib/keybindings/actions";
import { useKeybindingStore } from "@/stores/settings/keybinding-store";
import { KeybindingProvider } from "@/providers/keybinding-provider";

const WINDOW_ID = "history-nav-input-window";

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

// A branded (Electron persistent) history with a mid-stack index so both
// directions are navigable.
function brandedHistory(): RouterHistory {
  window.localStorage.setItem(
    storageKey(WINDOW_ID),
    JSON.stringify({ entries: ["/", "/epics", "/settings/general"], index: 1 }),
  );
  return createPersistentMemoryHistory(null, WINDOW_ID);
}

function renderProviderWith(history: RouterHistory): AppRouter {
  const router = makeRouter(history);
  render(
    <KeybindingProvider router={router}>
      <span />
    </KeybindingProvider>,
  );
  return router;
}

beforeEach(() => {
  window.localStorage.clear();
  useKeybindingStore.setState({ bindings: getDefaultBindings() });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  window.localStorage.clear();
});

// In-app back/forward has NO keyboard chord (mod/alt+Arrow collide with native
// caret movement in the chat composer). Mouse buttons 3/4 remain a non-
// conflicting explicit affordance, alongside the header arrows + palette rows.
describe("KeybindingProvider in-app back/forward — mouse buttons 3/4", () => {
  it("navigates via go(±1) on a desktop (branded) history", () => {
    const router = renderProviderWith(brandedHistory());
    const goSpy = vi.spyOn(router.history, "go").mockImplementation(() => {});

    const back = new MouseEvent("auxclick", {
      button: 3,
      bubbles: true,
      cancelable: true,
    });
    window.dispatchEvent(back);
    expect(back.defaultPrevented).toBe(true);
    expect(goSpy).toHaveBeenNthCalledWith(1, -1);

    const forward = new MouseEvent("auxclick", {
      button: 4,
      bubbles: true,
      cancelable: true,
    });
    window.dispatchEvent(forward);
    expect(forward.defaultPrevented).toBe(true);
    expect(goSpy).toHaveBeenNthCalledWith(2, 1);
  });

  it("ignores mouse buttons 3/4 on a browser/memory history", () => {
    const router = renderProviderWith(createMemoryHistory());
    const goSpy = vi.spyOn(router.history, "go").mockImplementation(() => {});

    const back = new MouseEvent("auxclick", {
      button: 3,
      bubbles: true,
      cancelable: true,
    });
    window.dispatchEvent(back);

    expect(back.defaultPrevented).toBe(false);
    expect(goSpy).not.toHaveBeenCalled();
  });
});
