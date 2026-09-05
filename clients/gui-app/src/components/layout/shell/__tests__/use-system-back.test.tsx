/**
 * What an OS back request does, in the order Android users expect: an open
 * drawer closes, a covering modal dismisses, otherwise the app's own history
 * steps back through the SAME `goBack` the edge swipe and the desktop arrows
 * call, and with nothing behind the app steps out of the way.
 *
 * The shell is a fake `systemBack` capability; every other piece is real.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  render,
  renderHook,
  waitFor,
} from "@testing-library/react";
import { QueryClient } from "@tanstack/react-query";
import {
  RouterContextProvider,
  createMemoryHistory,
  createRouter,
  type RouterHistory,
} from "@tanstack/react-router";
import type { ISystemBackHost } from "@traycer-clients/shared/platform/runner-host";
import { createFakeRunnerHost } from "../../../../../__tests__/create-fake-runner-host";
import { routeTree } from "@/routeTree.gen";
import type { AppRouter } from "@/router";
import { RunnerHostProvider } from "@/providers/runner-host-provider";
import { useAuthStore } from "@/stores/auth/auth-store";
import { useMobileNavStore } from "@/stores/layout/mobile-nav-store";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { useSystemBack } from "@/components/layout/shell/use-system-back";

class FakeSystemBack implements ISystemBackHost {
  private readonly handlers = new Set<() => void>();
  readonly minimize = vi.fn(async (): Promise<void> => {});

  onBack(handler: () => void): { dispose: () => void } {
    this.handlers.add(handler);
    return { dispose: () => this.handlers.delete(handler) };
  }

  press(): void {
    for (const handler of this.handlers) handler();
  }
}

function makeRouter(history: RouterHistory): AppRouter {
  return createRouter({
    routeTree,
    history,
    context: {
      queryClient: new QueryClient(),
      getAuthSnapshot: () => useAuthStore.getState(),
      getHostClient: () => null,
    },
  });
}

function mount(history: RouterHistory): FakeSystemBack {
  const systemBack = new FakeSystemBack();
  const router = makeRouter(history);
  renderHook(() => useSystemBack(), {
    wrapper: ({ children }) => (
      <RunnerHostProvider runnerHost={createFakeRunnerHost({ systemBack })}>
        <RouterContextProvider router={router}>
          {children}
        </RouterContextProvider>
      </RunnerHostProvider>
    ),
  });
  return systemBack;
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  useMobileNavStore.setState({ open: false });
});

describe("useSystemBack", () => {
  it("steps the app's history back on an OS back press", () => {
    const history = createMemoryHistory({ initialEntries: ["/", "/epics"] });
    const backSpy = vi.spyOn(history, "back");
    const systemBack = mount(history);

    act(() => systemBack.press());

    expect(backSpy).toHaveBeenCalledTimes(1);
    expect(systemBack.minimize).not.toHaveBeenCalled();
  });

  it("closes the navigation drawer instead of navigating", () => {
    const history = createMemoryHistory({ initialEntries: ["/", "/epics"] });
    const backSpy = vi.spyOn(history, "back");
    const systemBack = mount(history);
    useMobileNavStore.setState({ open: true });

    act(() => systemBack.press());

    expect(useMobileNavStore.getState().open).toBe(false);
    expect(backSpy).not.toHaveBeenCalled();
  });

  it("asks the shell to step out of the way when nothing is behind", () => {
    const history = createMemoryHistory({ initialEntries: ["/"] });
    const backSpy = vi.spyOn(history, "back");
    const systemBack = mount(history);

    act(() => systemBack.press());

    expect(backSpy).not.toHaveBeenCalled();
    expect(systemBack.minimize).toHaveBeenCalledTimes(1);
  });

  /**
   * Driven through a REAL sheet, uncontrolled so that the dismissal the press
   * triggers is the primitive's own. Setting the barrier style by hand would
   * pass against a signal no surface ever produces.
   */
  it("dismisses a covering modal rather than navigating beneath it", async () => {
    const history = createMemoryHistory({ initialEntries: ["/", "/epics"] });
    const backSpy = vi.spyOn(history, "back");
    const systemBack = new FakeSystemBack();
    const router = makeRouter(history);
    function UnderSheet() {
      useSystemBack();
      return (
        <Sheet defaultOpen>
          <SheetContent side="bottom">
            <SheetTitle>Confirm</SheetTitle>
          </SheetContent>
        </Sheet>
      );
    }
    const view = render(
      <RunnerHostProvider runnerHost={createFakeRunnerHost({ systemBack })}>
        <RouterContextProvider router={router}>
          <UnderSheet />
        </RouterContextProvider>
      </RunnerHostProvider>,
    );
    await waitFor(() => {
      expect(document.body.style.pointerEvents).toBe("none");
    });

    act(() => systemBack.press());

    await waitFor(() => {
      expect(view.queryByText("Confirm")).toBeNull();
    });
    expect(backSpy).not.toHaveBeenCalled();
    expect(systemBack.minimize).not.toHaveBeenCalled();
  });
});
