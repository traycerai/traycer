/**
 * What the Activity strip draws on a pane, over the real emphasis store: the
 * hover outline, and the focus flash with its motion and reduced-motion
 * lifetimes. The strip's side of the seam (which row publishes what) is the
 * strip's own suite; where the pane gets its tile from is `tab-group-view`'s.
 */
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PaneEmphasis } from "@/components/epic-canvas/canvas/pane-emphasis";
import {
  clearPaneOutline,
  flashPaneOf,
  outlinePaneOf,
  usePaneEmphasisStore,
} from "@/stores/epics/canvas/pane-emphasis-store";

const motion = vi.hoisted((): { enabled: boolean } => ({ enabled: true }));
vi.mock("@/lib/animation/use-motion-enabled", () => ({
  useMotionEnabled: () => motion.enabled,
}));

function advance(ms: number): void {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
}

describe("<PaneEmphasis />", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    motion.enabled = true;
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    usePaneEmphasisStore.setState({ outlinedInstanceId: null, flash: null });
  });

  it("outlines the pane only while its visible tile is the outlined one", () => {
    render(<PaneEmphasis activeInstanceId="tile-a" />);
    expect(screen.queryByTestId("pane-outline")).toBeNull();

    act(() => {
      outlinePaneOf("tile-b");
    });
    expect(screen.queryByTestId("pane-outline")).toBeNull();

    act(() => {
      outlinePaneOf("tile-a");
    });
    expect(screen.getByTestId("pane-outline")).toBeTruthy();

    act(() => {
      clearPaneOutline("tile-a");
    });
    expect(screen.queryByTestId("pane-outline")).toBeNull();
  });

  it("flashes once with a fade, over 400ms, and only on the pane of the tile it names", () => {
    render(<PaneEmphasis activeInstanceId="tile-a" />);

    act(() => {
      flashPaneOf("tile-b");
    });
    expect(screen.queryByTestId("pane-flash")).toBeNull();

    act(() => {
      flashPaneOf("tile-a");
    });
    expect(
      screen.getByTestId("pane-flash").classList.contains("pane-focus-flash"),
    ).toBe(true);
    advance(399);
    expect(screen.getByTestId("pane-flash")).toBeTruthy();
    advance(1);
    expect(screen.queryByTestId("pane-flash")).toBeNull();
  });

  it("shows the ring without fading for 600ms when there is no motion, then takes it away", () => {
    motion.enabled = false;
    render(<PaneEmphasis activeInstanceId="tile-a" />);

    act(() => {
      flashPaneOf("tile-a");
    });
    expect(
      screen.getByTestId("pane-flash").classList.contains("pane-focus-flash"),
    ).toBe(false);
    advance(599);
    expect(screen.getByTestId("pane-flash")).toBeTruthy();
    advance(1);
    expect(screen.queryByTestId("pane-flash")).toBeNull();
  });

  it("restarts the flash on a repeat instead of cutting the second one short", () => {
    render(<PaneEmphasis activeInstanceId="tile-a" />);

    act(() => {
      flashPaneOf("tile-a");
    });
    advance(300);
    act(() => {
      flashPaneOf("tile-a");
    });
    // 600ms after the first flash began: the second one has run 300ms.
    advance(300);
    expect(screen.getByTestId("pane-flash")).toBeTruthy();
    advance(100);
    expect(screen.queryByTestId("pane-flash")).toBeNull();
  });
});
