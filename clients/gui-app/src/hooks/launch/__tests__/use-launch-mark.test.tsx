import { cleanup, render, screen } from "@testing-library/react";
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * The launch mark reads the clock ONCE, at module evaluation, so module
 * identity is part of the contract: every case installs fake timers FIRST and
 * then imports a fresh graph, making "app start" the mocked clock. The auth
 * store and the runtime signal are re-imported from that same graph, or writes
 * would land on a different module instance than the hook reads.
 */
async function loadLaunch(reducedMotion: boolean) {
  vi.resetModules();
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: reducedMotion && query === "(prefers-reduced-motion: reduce)",
    media: query,
  }));

  const launch = await import("@/hooks/launch/use-launch-mark");
  const signal = await import("@/lib/launch/launch-runtime-signal");
  const store = await import("@/stores/auth/auth-store");
  signal.resetLaunchRuntimeSignalForTest();
  return { launch, signal, store };
}

type LaunchModule = Awaited<ReturnType<typeof loadLaunch>>["launch"];

function renderProbe(launch: LaunchModule) {
  function Probe() {
    const phase = launch.useLaunchMark();
    return <span data-testid="phase">{phase}</span>;
  }
  render(<Probe />);
}

function phase(): string | null {
  return screen.getByTestId("phase").textContent;
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("useLaunchMark", () => {
  it("holds while auth has not answered, however long that takes", async () => {
    vi.useFakeTimers();
    const { launch } = await loadLaunch(false);

    renderProbe(launch);
    expect(phase()).toBe("hold");

    // Past the signed-out ceiling. The ceiling governs a RESOLVED signed-out
    // launch; it must not hand the window back while auth is still silent,
    // because the surface underneath is the host boot card and its heading
    // would describe host work that has not started.
    act(() => {
      vi.advanceTimersByTime(launch.LAUNCH_MARK_CEILING_MS + 500);
    });
    expect(phase()).toBe("hold");
  });

  it("signed-out: continues to the ceiling, crossfading inside it", async () => {
    vi.useFakeTimers();
    const { launch, signal, store } = await loadLaunch(false);
    store.useAuthStore.setState({ status: "signed-out" });

    renderProbe(launch);
    act(() => {
      signal.markHostRuntimeStarted();
    });
    expect(phase()).toBe("hold");

    const startTime = Date.now();
    act(() => {
      vi.advanceTimersByTime(
        launch.LAUNCH_MARK_CEILING_MS - launch.LAUNCH_MARK_EXIT_MS,
      );
    });
    expect(phase()).toBe("exit");

    act(() => {
      vi.advanceTimersByTime(launch.LAUNCH_MARK_EXIT_MS);
    });
    expect(phase()).toBe("done");
    expect(Date.now() - startTime).toBe(launch.LAUNCH_MARK_CEILING_MS);
    expect(launch.LAUNCH_MARK_CEILING_MS).toBeLessThanOrEqual(2500);
  });

  it("signed-in: yields the moment auth answers, with no timer advanced", async () => {
    vi.useFakeTimers();
    const { launch, signal, store } = await loadLaunch(false);
    store.useAuthStore.setState({ status: "signed-in" });

    renderProbe(launch);
    expect(phase()).toBe("hold");

    const startTime = Date.now();
    act(() => {
      signal.markHostRuntimeStarted();
    });

    // The readiness rule: handing over is a verdict, not a deadline. If this
    // path were gated on the launch clock it would still read "hold" here.
    expect(phase()).toBe("done");
    expect(Date.now()).toBe(startTime);
  });

  it("stalled auth: gives the window back at the slow-start threshold", async () => {
    vi.useFakeTimers();
    const { launch } = await loadLaunch(false);

    renderProbe(launch);
    expect(phase()).toBe("hold");

    // Nothing ever resolves. The real boot card - heading, progress bar and
    // `Open settings` - has to come back, or a stuck launch is a silent logo
    // with no way out.
    act(() => {
      vi.advanceTimersByTime(10_000);
    });
    expect(phase()).toBe("done");
  });

  it("reduced motion: still covers the pre-auth window, but takes no hold", async () => {
    vi.useFakeTimers();
    const { launch, signal, store } = await loadLaunch(true);
    store.useAuthStore.setState({ status: "signed-out" });

    renderProbe(launch);
    // The cover is still the mark, just a static one - every animation on it
    // is declared inside `prefers-reduced-motion: no-preference`.
    expect(phase()).toBe("hold");

    act(() => {
      signal.markHostRuntimeStarted();
    });
    expect(phase()).toBe("done");
  });

  it("refused shell: an unverified session is never held", async () => {
    vi.useFakeTimers();
    const { launch, signal, store } = await loadLaunch(false);
    store.useAuthStore.setState({ status: "unverified" });

    renderProbe(launch);
    act(() => {
      signal.markHostRuntimeStarted();
    });
    // The refusal sentence is the whole point of that surface; a brand
    // animation in front of it delays the only thing it exists to say.
    expect(phase()).toBe("done");
  });

  it("warm reopen: a mount past the ceiling gets nothing", async () => {
    vi.useFakeTimers();
    const { launch, signal, store } = await loadLaunch(false);
    store.useAuthStore.setState({ status: "signed-out" });

    act(() => {
      vi.advanceTimersByTime(60_000);
      signal.markHostRuntimeStarted();
    });

    renderProbe(launch);
    expect(phase()).toBe("done");
  });

  it("a bypass consumes the mark, so it cannot come back within the ceiling", async () => {
    vi.useFakeTimers();
    const { launch, signal, store } = await loadLaunch(false);
    store.useAuthStore.setState({ status: "signed-in" });

    renderProbe(launch);
    act(() => {
      signal.markHostRuntimeStarted();
    });
    expect(phase()).toBe("done");

    // Signing out inside the launch window must not resurrect it: the bypass
    // settled the machine rather than merely overriding what it returned.
    act(() => {
      store.useAuthStore.setState({ status: "signed-out" });
    });
    expect(phase()).toBe("done");
  });
});
