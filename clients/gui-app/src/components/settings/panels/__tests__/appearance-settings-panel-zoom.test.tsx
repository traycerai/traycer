import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppearanceSettingsPanel } from "@/components/settings/panels/appearance-settings-panel";
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

describe("<AppearanceSettingsPanel /> zoom control", () => {
  beforeEach(() => {
    zoomState.bridge = new FakeZoomBridge();
  });

  afterEach(() => {
    cleanup();
    zoomState.bridge = null;
  });

  it("renders the desktop Display zoom row and reflects live changes", async () => {
    const bridge = zoomState.bridge;
    render(<AppearanceSettingsPanel />);

    expect(await screen.findByText("100%")).toBeTruthy();

    act(() => {
      bridge?.emit(125);
    });

    expect(screen.getByText("125%")).toBeTruthy();
  });

  it("hides the Display zoom row without the desktop bridge", () => {
    zoomState.bridge = null;
    render(<AppearanceSettingsPanel />);

    expect(screen.queryByLabelText("Display zoom")).toBeNull();
  });
});
