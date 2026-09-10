import { cleanup, render, screen } from "@testing-library/react";
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * The splash reads the clock ONCE, at module evaluation, so that it is a launch
 * surface rather than something that replays on every later arrival at the
 * sign-in page. That makes module identity part of the contract under test:
 * each case installs fake timers FIRST and then imports a fresh copy of the
 * graph, so "app start" is the mocked clock and the elapsed time between one
 * test and the next cannot leak in.
 *
 * The auth store is re-imported from that same fresh graph for the same reason.
 * A store read from the outer, already-evaluated copy would be a different
 * module instance, and writing to it would leave the hook looking at an
 * untouched one.
 */
/**
 * Only `matches` is stubbed, because only `matches` is read: the hook asks the
 * media query its answer once per render and never subscribes. Standing up a
 * whole `MediaQueryList` here would mean carrying its deprecated listener pair
 * to satisfy a type nothing under test consults.
 */
function stubMatchMedia(reducedMotion: boolean): void {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: reducedMotion && query === "(prefers-reduced-motion: reduce)",
    media: query,
  }));
}

async function loadSplash(reducedMotion: boolean) {
  vi.resetModules();
  stubMatchMedia(reducedMotion);

  const splash = await import("@/hooks/auth/use-brand-splash-hold");
  const store = await import("@/stores/auth/auth-store");
  return { splash, store };
}

type SplashModule = Awaited<ReturnType<typeof loadSplash>>["splash"];

function renderProbe(splash: SplashModule, enabled: boolean) {
  function Probe() {
    const phase = splash.useBrandSplashHold(enabled);
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

describe("useBrandSplashHold", () => {
  it("is gone by the 2.5s ceiling on a signed-out launch", async () => {
    vi.useFakeTimers();
    const { splash, store } = await loadSplash(false);
    store.useAuthStore.setState({ status: "signed-out" });

    const startTime = Date.now();
    renderProbe(splash, true);
    expect(phase()).toBe("hold");

    // Advanced through both phases, then measured against the wall clock: the
    // assertion that matters is total elapsed time, because the ceiling covers
    // the crossfade too. Each phase is stepped separately so React can commit
    // the exit phase and schedule its own deadline, which is what a real
    // launch does between animation frames.
    act(() => {
      vi.advanceTimersByTime(
        splash.BRAND_SPLASH_MAX_MS - splash.BRAND_SPLASH_EXIT_MS,
      );
    });
    act(() => {
      vi.advanceTimersByTime(splash.BRAND_SPLASH_EXIT_MS);
    });

    expect(phase()).toBe("done");
    expect(Date.now() - startTime).toBe(splash.BRAND_SPLASH_MAX_MS);
    expect(splash.BRAND_SPLASH_MAX_MS).toBeLessThanOrEqual(2500);
  });

  it("crossfades rather than cutting, and the fade fits inside the ceiling", async () => {
    vi.useFakeTimers();
    const { splash, store } = await loadSplash(false);
    store.useAuthStore.setState({ status: "signed-out" });

    renderProbe(splash, true);
    act(() => {
      vi.advanceTimersByTime(
        splash.BRAND_SPLASH_MAX_MS - splash.BRAND_SPLASH_EXIT_MS,
      );
    });

    // Still mounted, now leaving - this is what keeps the mark from blinking
    // out and back as the page beneath it appears.
    expect(phase()).toBe("exit");

    act(() => {
      vi.advanceTimersByTime(splash.BRAND_SPLASH_EXIT_MS);
    });
    expect(phase()).toBe("done");
  });

  it("does not extend when auth resolves LATER than the ceiling", async () => {
    vi.useFakeTimers();
    const { splash, store } = await loadSplash(false);
    // Deliberately unresolved for the whole splash: no verdict has been
    // reached by the time the ceiling arrives.
    store.useAuthStore.setState({ status: "signing-in" });

    const startTime = Date.now();
    renderProbe(splash, true);
    act(() => {
      vi.advanceTimersByTime(
        splash.BRAND_SPLASH_MAX_MS - splash.BRAND_SPLASH_EXIT_MS,
      );
    });
    act(() => {
      vi.advanceTimersByTime(splash.BRAND_SPLASH_EXIT_MS);
    });
    expect(phase()).toBe("done");
    // Gone on the ceiling, with no auth verdict in hand at any point.
    expect(Date.now() - startTime).toBe(splash.BRAND_SPLASH_MAX_MS);

    // The verdict lands well after the splash is over and changes nothing -
    // the splash cannot be restarted or prolonged by it.
    act(() => {
      vi.advanceTimersByTime(5000);
      store.useAuthStore.setState({ status: "signed-out" });
    });
    expect(phase()).toBe("done");
  });

  it("never holds an admitted session, without advancing any timer", async () => {
    vi.useFakeTimers();
    const { splash, store } = await loadSplash(false);
    store.useAuthStore.setState({ status: "signed-in" });

    const startTime = Date.now();
    renderProbe(splash, true);

    // The readiness rule: no timer is consulted at all on this path. If the
    // signed-in launch were gated on the splash clock, this would read "hold"
    // until something advanced it.
    expect(phase()).toBe("done");
    expect(Date.now()).toBe(startTime);
  });

  it("never holds an unverified session either", async () => {
    vi.useFakeTimers();
    const { splash, store } = await loadSplash(false);
    store.useAuthStore.setState({ status: "unverified" });

    renderProbe(splash, true);
    expect(phase()).toBe("done");
  });

  it("goes straight to sign-in under reduced motion", async () => {
    vi.useFakeTimers();
    const { splash, store } = await loadSplash(true);
    store.useAuthStore.setState({ status: "signed-out" });

    renderProbe(splash, true);
    expect(phase()).toBe("done");
  });

  it("stands aside for a refused shell, which is there to be read", async () => {
    vi.useFakeTimers();
    const { splash, store } = await loadSplash(false);
    store.useAuthStore.setState({ status: "signed-out" });

    renderProbe(splash, false);
    expect(phase()).toBe("done");
  });

  it("does not replay on a later arrival at the sign-in page", async () => {
    vi.useFakeTimers();
    const { splash, store } = await loadSplash(false);
    store.useAuthStore.setState({ status: "signed-out" });

    // A whole session goes by - the user signs in, works, signs out - and the
    // sign-in surface mounts again. "App start" is long past.
    act(() => {
      vi.advanceTimersByTime(60_000);
    });

    renderProbe(splash, true);
    expect(phase()).toBe("done");
  });
});
