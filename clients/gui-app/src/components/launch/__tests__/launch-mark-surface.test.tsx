import { cleanup, render, screen } from "@testing-library/react";
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

async function loadSurface() {
  vi.resetModules();
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: false,
    media: query,
  }));

  const surface = await import("@/components/launch/launch-mark-surface");
  const launch = await import("@/hooks/launch/use-launch-mark");
  const signal = await import("@/lib/launch/launch-runtime-signal");
  const store = await import("@/stores/auth/auth-store");
  signal.resetLaunchRuntimeSignalForTest();
  return { surface, launch, signal, store };
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("<LaunchMarkSurface />", () => {
  it("is the SAME element across the swaps underneath it", async () => {
    vi.useFakeTimers();
    const { surface, launch, signal, store } = await loadSurface();
    store.useAuthStore.setState({ status: "signed-out" });

    // Stands in for the two remounts a launch really performs underneath the
    // mark: `HostRuntimeProvider` replacing its fallback with its children, and
    // the router then mounting the sign-in page. The mark is a SIBLING of both,
    // which is the whole reason it can survive them.
    function Launch(props: { readonly stage: number }) {
      return (
        <>
          <surface.LaunchMarkSurface />
          <div key={props.stage} data-testid="beneath">
            stage {props.stage}
          </div>
        </>
      );
    }

    const view = render(<Launch stage={0} />);
    const first = screen.getByTestId("launch-mark-surface");
    const firstBeneath = screen.getByTestId("beneath");

    act(() => {
      signal.markHostRuntimeStarted();
    });
    view.rerender(<Launch stage={1} />);
    act(() => {
      vi.advanceTimersByTime(500);
    });
    view.rerender(<Launch stage={2} />);

    const later = screen.getByTestId("launch-mark-surface");
    const laterBeneath = screen.getByTestId("beneath");

    // The identity claim: the node is the very same object, not an equal one.
    expect(later).toBe(first);
    // The control. Without it the assertion above could pass on a tree where
    // nothing remounted at all, proving nothing about surviving a swap.
    expect(laterBeneath).not.toBe(firstBeneath);

    // Stepped through the hold and then the crossfade: React commits the exit
    // phase between them and schedules its own deadline there, which is what a
    // real launch does between animation frames.
    act(() => {
      vi.advanceTimersByTime(launch.LAUNCH_MARK_CEILING_MS);
    });
    act(() => {
      vi.advanceTimersByTime(launch.LAUNCH_MARK_EXIT_MS);
    });
    expect(screen.queryByTestId("launch-mark-surface")).toBeNull();
  });

  it("swallows taps while it covers, and lets them through as it leaves", async () => {
    vi.useFakeTimers();
    const { surface, launch, signal, store } = await loadSurface();
    store.useAuthStore.setState({ status: "signed-out" });

    render(<surface.LaunchMarkSurface />);
    act(() => {
      signal.markHostRuntimeStarted();
    });

    // Holding: the page beneath is invisible, so a tap that fell through would
    // fire a control the user cannot see.
    const holding = screen.getByTestId("launch-mark-surface");
    expect(holding.dataset["phase"]).toBe("hold");
    expect(holding.className).not.toContain("pointer-events-none");

    act(() => {
      vi.advanceTimersByTime(
        launch.LAUNCH_MARK_CEILING_MS - launch.LAUNCH_MARK_EXIT_MS,
      );
    });

    // Leaving: the sign-in page is visibly arriving, so intercepting its first
    // tap is the wrong half of the trade.
    const leaving = screen.getByTestId("launch-mark-surface");
    expect(leaving.dataset["phase"]).toBe("exit");
    expect(leaving.className).toContain("pointer-events-none");
  });

  it("renders no text in any phase", async () => {
    vi.useFakeTimers();
    const { surface, signal, store } = await loadSurface();
    store.useAuthStore.setState({ status: "signed-out" });

    const view = render(<surface.LaunchMarkSurface />);
    expect(view.container.textContent).toBe("");

    act(() => {
      signal.markHostRuntimeStarted();
    });
    expect(view.container.textContent).toBe("");
    expect(view.container.textContent).not.toContain("Starting Traycer");
  });
});
