import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
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
import { isMac } from "@/lib/keybindings/platform";

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
      <input aria-label="Editor" />
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

describe("KeybindingProvider in-app back/forward", () => {
  it("preserves native caret movement for mod+Arrow inside editable fields", () => {
    useKeybindingStore.setState({
      bindings: {
        ...getDefaultBindings(),
        "nav.back": "mod+arrowleft",
      },
    });
    const router = renderProviderWith(brandedHistory());
    const goSpy = vi.spyOn(router.history, "go").mockImplementation(() => {});
    const input = screen.getByRole("textbox", { name: "Editor" });
    const modifier = isMac() ? { metaKey: true } : { ctrlKey: true };
    const event = new KeyboardEvent("keydown", {
      code: "ArrowLeft",
      key: "ArrowLeft",
      ...modifier,
      bubbles: true,
      cancelable: true,
    });

    input.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(false);
    expect(goSpy).not.toHaveBeenCalled();
  });

  it("dispatches the default mod+shift+, history navigation", () => {
    const router = renderProviderWith(brandedHistory());
    const goSpy = vi.spyOn(router.history, "go").mockImplementation(() => {});
    const modifier = isMac() ? { metaKey: true } : { ctrlKey: true };
    const event = new KeyboardEvent("keydown", {
      code: "Comma",
      key: ",",
      shiftKey: true,
      ...modifier,
      bubbles: true,
      cancelable: true,
    });

    window.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    expect(goSpy).toHaveBeenCalledWith(-1);
  });

  it("dispatches mod+Arrow history navigation outside editable fields", () => {
    useKeybindingStore.setState({
      bindings: {
        ...getDefaultBindings(),
        "nav.back": "mod+arrowleft",
      },
    });
    const router = renderProviderWith(brandedHistory());
    const goSpy = vi.spyOn(router.history, "go").mockImplementation(() => {});
    const modifier = isMac() ? { metaKey: true } : { ctrlKey: true };
    const event = new KeyboardEvent("keydown", {
      code: "ArrowLeft",
      key: "ArrowLeft",
      ...modifier,
      bubbles: true,
      cancelable: true,
    });

    window.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    expect(goSpy).toHaveBeenCalledWith(-1);
  });

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
