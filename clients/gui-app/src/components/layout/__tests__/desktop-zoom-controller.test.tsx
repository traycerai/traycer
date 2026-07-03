import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DesktopZoomController } from "@/components/layout/bridges/desktop-zoom-controller";
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
  });

  afterEach(() => {
    vi.useRealTimers();
    zoomState.bridge = null;
  });

  it("registers dynamic zoom keybinding handlers", () => {
    const bridge = zoomState.bridge;
    render(<DesktopZoomController />);

    expect(dispatchAction("app.zoom.in", router)).toBe(true);
    expect(dispatchAction("app.zoom.out", router)).toBe(true);
    expect(dispatchAction("app.zoom.reset", router)).toBe(true);

    expect(bridge?.stepIn).toHaveBeenCalledTimes(1);
    expect(bridge?.stepOut).toHaveBeenCalledTimes(1);
    expect(bridge?.reset).toHaveBeenCalledTimes(1);
  });

  it("steps ctrl-wheel gestures through the zoom bridge", async () => {
    const bridge = zoomState.bridge;
    render(<DesktopZoomController />);

    fireEvent.wheel(window, { ctrlKey: true, deltaY: -100, deltaMode: 0 });
    fireEvent.wheel(window, { ctrlKey: true, deltaY: 100, deltaMode: 0 });

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(bridge?.stepIn).toHaveBeenCalledTimes(1);
    expect(bridge?.stepOut).toHaveBeenCalledTimes(1);
  });

  it("suppresses the initial zoom sync indicator", () => {
    const bridge = zoomState.bridge;
    render(<DesktopZoomController />);

    act(() => {
      bridge?.emit(125);
    });

    expect(screen.queryByTestId("desktop-zoom-indicator")).toBeNull();
  });

  it("shows a transient indicator and reset affordance on user zoom changes", () => {
    const bridge = zoomState.bridge;
    render(<DesktopZoomController />);

    act(() => {
      bridge?.emit(100);
      bridge?.emit(125);
    });

    const indicator = screen.getByTestId("desktop-zoom-indicator");
    const percent = screen.getByTestId("desktop-zoom-percent");
    const resetButton = screen.getByRole("button", {
      name: /Reset to 100%/i,
    });

    expect(indicator.contains(percent)).toBe(true);
    expect(indicator.contains(resetButton)).toBe(true);
    expect(percent.textContent).toBe("125%");

    fireEvent.click(resetButton);
    expect(bridge?.reset).toHaveBeenCalledTimes(1);

    act(() => {
      vi.advanceTimersByTime(2_000);
    });

    expect(screen.queryByTestId("desktop-zoom-indicator")).toBeNull();
  });
});
