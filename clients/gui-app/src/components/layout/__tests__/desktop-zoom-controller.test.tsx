import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { DesktopZoomController } from "@/components/layout/bridges/desktop-zoom-controller";
import { TooltipProvider } from "@/components/ui/tooltip";
import {
  dispatchAction,
  type KeybindingRouter,
} from "@/lib/keybindings/dispatch";
import type { DesktopZoomBridge } from "@/lib/windows/types";

const zoomState: {
  bridge: FakeZoomBridge | null;
} = {
  bridge: null,
};
let queryClient: QueryClient;

vi.mock("@/hooks/runner/use-desktop-zoom-bridge", () => ({
  useDesktopZoomBridge: () => zoomState.bridge,
}));

class FakeZoomBridge implements DesktopZoomBridge {
  readonly ladder = [67, 75, 80, 90, 100, 110, 125, 150];
  readonly stepIn = vi.fn(() => Promise.resolve(110));
  readonly stepOut = vi.fn(() => Promise.resolve(90));
  readonly reset = vi.fn(() => Promise.resolve(100));
  readonly set = vi.fn((percent: number) => Promise.resolve(percent));
  private percent = 100;
  private readonly handlers = new Set<(percent: number) => void>();

  get(): Promise<number> {
    return Promise.resolve(this.percent);
  }

  onChange(handler: (percent: number) => void): { dispose: () => void } {
    this.handlers.add(handler);
    return {
      dispose: () => {
        this.handlers.delete(handler);
      },
    };
  }

  emit(percent: number): void {
    this.percent = percent;
    for (const handler of this.handlers) {
      handler(percent);
    }
  }
}

const router: KeybindingRouter = {
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
};

describe("<DesktopZoomController />", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    zoomState.bridge = new FakeZoomBridge();
    queryClient = createQueryClient();
  });

  afterEach(() => {
    queryClient.clear();
    cleanup();
    vi.useRealTimers();
    zoomState.bridge = null;
  });

  it("registers dynamic zoom keybinding handlers", async () => {
    const bridge = zoomState.bridge;
    renderWithQueryClient(<DesktopZoomController />);

    expect(dispatchAction("app.zoom.in", router)).toBe(true);
    expect(dispatchAction("app.zoom.out", router)).toBe(true);
    expect(dispatchAction("app.zoom.reset", router)).toBe(true);

    await act(async () => {
      await Promise.resolve();
    });

    expect(bridge?.stepIn).toHaveBeenCalledTimes(1);
    expect(bridge?.stepOut).toHaveBeenCalledTimes(1);
    expect(bridge?.reset).toHaveBeenCalledTimes(1);
  });

  it("steps ctrl-wheel gestures through the zoom bridge", async () => {
    const bridge = zoomState.bridge;
    renderWithQueryClient(<DesktopZoomController />);

    fireEvent.wheel(window, { ctrlKey: true, deltaY: -100, deltaMode: 0 });
    fireEvent.wheel(window, { ctrlKey: true, deltaY: 100, deltaMode: 0 });

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(bridge?.stepIn).toHaveBeenCalledTimes(1);
    expect(bridge?.stepOut).toHaveBeenCalledTimes(1);
  });

  it("shows the first observed zoom change", () => {
    const bridge = zoomState.bridge;
    renderWithQueryClient(<DesktopZoomController />);

    act(() => {
      bridge?.emit(125);
    });

    expect(screen.getByTestId("desktop-zoom-percent").textContent).toBe("125%");
  });

  it("shows a transient indicator and reset affordance on user zoom changes", async () => {
    const bridge = zoomState.bridge;
    renderWithQueryClient(<DesktopZoomController />);

    act(() => {
      bridge?.emit(125);
    });

    const indicator = screen.getByTestId("desktop-zoom-indicator");
    const zoomIsland = screen.getByTestId("desktop-zoom-level-island");
    const percent = screen.getByTestId("desktop-zoom-percent");
    const resetButton = screen.getByRole("button", {
      name: /Reset to 100%/i,
    });
    const resetIsland = screen.getByTestId("desktop-zoom-reset-island");
    const zoomInButton = screen.getByRole("button", { name: "Zoom in" });
    const zoomOutButton = screen.getByRole("button", { name: "Zoom out" });

    expect(indicator.contains(zoomIsland)).toBe(true);
    expect(indicator.contains(percent)).toBe(true);
    expect(indicator.contains(resetIsland)).toBe(true);
    expect(resetIsland).toBe(resetButton);
    expect(zoomIsland.contains(percent)).toBe(true);
    expect(zoomIsland.contains(zoomInButton)).toBe(true);
    expect(zoomIsland.contains(zoomOutButton)).toBe(true);
    expect(zoomIsland.contains(resetButton)).toBe(false);
    expect(percent.textContent).toBe("125%");

    fireEvent.click(zoomOutButton);
    fireEvent.click(zoomInButton);
    fireEvent.click(resetButton);
    await act(async () => {
      await Promise.resolve();
    });
    expect(bridge?.stepOut).toHaveBeenCalledTimes(1);
    expect(bridge?.stepIn).toHaveBeenCalledTimes(1);
    expect(bridge?.reset).toHaveBeenCalledTimes(1);

    act(() => {
      vi.advanceTimersByTime(2_000);
    });
    expect(screen.getByTestId("desktop-zoom-indicator")).toBeTruthy();

    act(() => {
      vi.advanceTimersByTime(2_000);
    });
    expect(screen.queryByTestId("desktop-zoom-indicator")).toBeNull();
  });
});

function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
}

function renderWithQueryClient(children: ReactNode): void {
  render(
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>{children}</TooltipProvider>
    </QueryClientProvider>,
  );
}
