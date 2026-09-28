import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { PaneVisibilityContext } from "@/components/epic-tabs/pane-visibility-context";
import { useMotionEnabled } from "@/lib/animation/use-motion-enabled";
import { useThemeLibraryStore } from "@/stores/settings/theme-library-store";

/**
 * The three gates this hook exists to combine, each proved to flip the answer
 * ON ITS OWN - which is what "no second source of truth" has to mean here.
 * The middle one, the app's own "Panel animations" switch, is the case that
 * had no coverage anywhere: `motion/react`'s `useReducedMotion` cannot see it,
 * which is why the context-usage number still animated with it off.
 */

const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

let reducedMotion = false;
const listeners = new Set<() => void>();
const nativeMatchMedia = window.matchMedia;

function installMatchMedia(): void {
  vi.stubGlobal("matchMedia", (query: string) => ({
    get matches(): boolean {
      return query === REDUCED_MOTION_QUERY && reducedMotion;
    },
    media: query,
    onchange: null,
    addEventListener: (type: string, listener: () => void) => {
      if (type === "change") listeners.add(listener);
    },
    removeEventListener: (type: string, listener: () => void) => {
      if (type === "change") listeners.delete(listener);
    },
    dispatchEvent: () => false,
  }));
}

function announceReducedMotion(next: boolean): void {
  act(() => {
    reducedMotion = next;
    for (const listener of listeners) listener();
  });
}

function setPanelAnimations(enabled: boolean): void {
  act(() => {
    useThemeLibraryStore
      .getState()
      .setAppearancePreference({ panelAnimations: enabled });
  });
}

function paneWrapper(visible: boolean) {
  return function Wrapper({ children }: { readonly children: ReactNode }) {
    return (
      <PaneVisibilityContext.Provider value={visible}>
        {children}
      </PaneVisibilityContext.Provider>
    );
  };
}

function reset(): void {
  window.localStorage.clear();
  useThemeLibraryStore.setState({ panelAnimations: true });
  if (reducedMotion) announceReducedMotion(false);
}

/**
 * Installed once for the file, not per test. `status-animation-clock` attaches
 * its `change` listener to the FIRST `MediaQueryList` it is handed and keeps
 * it forever (`attachListenersOnce`), so a per-test stub - or a per-test
 * `listeners.clear()` - silently unsubscribes the clock and every later
 * assertion about the OS query passes vacuously.
 */
beforeAll(() => {
  installMatchMedia();
});

afterAll(() => {
  vi.stubGlobal("matchMedia", nativeMatchMedia);
});

beforeEach(reset);
afterEach(reset);

describe("useMotionEnabled", () => {
  it("is true only with the OS query clear, the switch on and the pane visible", () => {
    const { result } = renderHook(() => useMotionEnabled(), {
      wrapper: paneWrapper(true),
    });

    expect(result.current).toBe(true);
  });

  it("follows the OS query live, without a remount", () => {
    const { result } = renderHook(() => useMotionEnabled(), {
      wrapper: paneWrapper(true),
    });

    announceReducedMotion(true);
    expect(result.current).toBe(false);

    announceReducedMotion(false);
    expect(result.current).toBe(true);
  });

  it("follows the app's own Panel animations switch live", () => {
    const { result } = renderHook(() => useMotionEnabled(), {
      wrapper: paneWrapper(true),
    });

    setPanelAnimations(false);
    expect(result.current).toBe(false);

    setPanelAnimations(true);
    expect(result.current).toBe(true);
  });

  it("is false in a pane that is mounted but not the visible one", () => {
    const { result } = renderHook(() => useMotionEnabled(), {
      wrapper: paneWrapper(false),
    });

    expect(result.current).toBe(false);
  });

  it("defaults to visible outside a pane provider, so isolated surfaces animate", () => {
    const { result } = renderHook(() => useMotionEnabled());

    expect(result.current).toBe(true);
  });
});
