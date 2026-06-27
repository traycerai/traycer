import "../../../../__tests__/test-browser-apis";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
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
import { CommandPaletteProvider } from "@/providers/command-palette-provider";
import { useCommandPaletteRouter } from "@/components/command-palette/command-palette-context";
import { historyNavigationSource } from "@/lib/commands/sources/history-navigation.source";
import type { KeybindingRouter } from "@/lib/keybindings/dispatch";
import type { CommandContext, CommandItem } from "@/lib/commands/types";

const WINDOW_ID = "history-nav-source-test-window";

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

// A full `KeybindingRouter` fake. The source only reads the history-navigation
// seam (`isHistoryNavAvailable` + `goBack` / `goForward`); the rest are inert.
function fakeRouter(overrides: Partial<KeybindingRouter>): KeybindingRouter {
  return {
    getPathname: () => "/",
    navigateHome: () => undefined,
    navigateSettings: () => undefined,
    navigateToEpic: () => undefined,
    navigateToEpicTab: () => undefined,
    navigateToEpicList: () => undefined,
    navigateSettingsSection: () => undefined,
    navigateToTabIntent: () => undefined,
    goBack: () => undefined,
    goForward: () => undefined,
    isHistoryNavAvailable: () => false,
    canGoBack: () => false,
    canGoForward: () => false,
    ...overrides,
  };
}

function ctxWith(router: KeybindingRouter): CommandContext {
  return {
    pathname: "/",
    router,
    activeTabId: null,
    activeEpicId: null,
    focusedComposerKind: null,
    targetGroupId: null,
  };
}

// Drive the source hook with a plain `ctx` - no TanStack router context, which
// is the whole point: the source reads `ctx.router`, never `useRouter()`.
function captureFromCtx(ctx: CommandContext): ReadonlyArray<CommandItem> {
  let captured: ReadonlyArray<CommandItem> = [];
  function Probe() {
    captured = historyNavigationSource.useItems(ctx);
    return null;
  }
  render(<Probe />);
  return captured;
}

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  window.localStorage.clear();
});

describe("historyNavigationSource", () => {
  it("emits no items when history nav is unavailable (browser/web build)", () => {
    const items = captureFromCtx(
      ctxWith(fakeRouter({ isHistoryNavAvailable: () => false })),
    );
    expect(items).toEqual([]);
  });

  it("emits Go back / Go forward when history nav is available (desktop)", () => {
    const items = captureFromCtx(
      ctxWith(fakeRouter({ isHistoryNavAvailable: () => true })),
    );
    expect(items.map((item) => item.id)).toEqual([
      "history:back",
      "history:forward",
    ]);
    expect(items.map((item) => item.label)).toEqual(["Go back", "Go forward"]);
  });

  it("rows delegate to ctx.router.goBack / goForward (the live-router seam)", () => {
    const goBack = vi.fn();
    const goForward = vi.fn();
    const ctx = ctxWith(
      fakeRouter({ isHistoryNavAvailable: () => true, goBack, goForward }),
    );

    const items = captureFromCtx(ctx);
    const back = items.find((item) => item.id === "history:back");
    const forward = items.find((item) => item.id === "history:forward");
    expect(back).toBeDefined();
    expect(forward).toBeDefined();
    if (back === undefined || forward === undefined) return;

    void back.run(ctx);
    void forward.run(ctx);

    expect(goBack).toHaveBeenCalledTimes(1);
    expect(goForward).toHaveBeenCalledTimes(1);
  });

  // Regression guard for the crash this fixup addresses: the production palette
  // mounts ABOVE `<RouterProvider>`, so there is no TanStack router context.
  // `CommandPaletteProvider` builds the adapter via `routerAdapterFor(router)`
  // (its real production path) and publishes it on `CommandPaletteRouterContext`.
  // Evaluating the source through that adapter - with NO `RouterContextProvider`
  // in the tree - must not crash, and must surface rows for a branded history.
  it("evaluates via CommandPaletteProvider's adapter with no router context - no crash, rows present", () => {
    const router = makeRouter(seedPersistentHistory(["/epics/e1/t1"], 0));

    let captured: ReadonlyArray<CommandItem> = [];
    function Probe() {
      const adapter = useCommandPaletteRouter();
      captured = historyNavigationSource.useItems(ctxWith(adapter));
      return null;
    }
    function Tree({ children }: { readonly children: ReactNode }) {
      return (
        <CommandPaletteProvider router={router}>
          {children}
        </CommandPaletteProvider>
      );
    }

    expect(() =>
      render(
        <Tree>
          <Probe />
        </Tree>,
      ),
    ).not.toThrow();

    expect(captured.map((item) => item.id)).toEqual([
      "history:back",
      "history:forward",
    ]);
  });

  it("emits no rows via the adapter under browser/memory history (no crash)", () => {
    const router = makeRouter(createMemoryHistory({ initialEntries: ["/"] }));

    let captured: ReadonlyArray<CommandItem> = [];
    function Probe() {
      const adapter = useCommandPaletteRouter();
      captured = historyNavigationSource.useItems(ctxWith(adapter));
      return null;
    }

    expect(() =>
      render(
        <CommandPaletteProvider router={router}>
          <Probe />
        </CommandPaletteProvider>,
      ),
    ).not.toThrow();

    expect(captured).toEqual([]);
  });
});
