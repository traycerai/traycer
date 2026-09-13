import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { usePanelAnimationDuration } from "@/hooks/use-panel-animation-duration";
import { useThemeLibraryStore } from "@/stores/settings/theme-library-store";

let reducedMotion = false;
const listeners = new Set<() => void>();
const nativeMatchMedia = window.matchMedia;

function installMatchMedia(): void {
  vi.stubGlobal("matchMedia", (query: string) => ({
    get matches(): boolean {
      return query === "(prefers-reduced-motion: reduce)" && reducedMotion;
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

function resetPreferences(): void {
  reducedMotion = false;
  listeners.clear();
  window.localStorage.clear();
  useThemeLibraryStore.setState({
    panelAnimationDuration: 350,
    panelAnimations: true,
  });
}

beforeEach(() => {
  installMatchMedia();
  resetPreferences();
});
afterEach(() => {
  vi.stubGlobal("matchMedia", nativeMatchMedia);
  resetPreferences();
});

describe("usePanelAnimationDuration", () => {
  it("tracks live panel preferences and the OS reduced-motion change", () => {
    const { result } = renderHook(() => usePanelAnimationDuration());
    expect(result.current).toBe(350);

    act(() => {
      useThemeLibraryStore.getState().setAppearancePreference({
        panelAnimations: false,
      });
    });
    expect(result.current).toBe(0);

    act(() => {
      useThemeLibraryStore.getState().setAppearancePreference({
        panelAnimations: true,
        panelAnimationDuration: 0,
      });
    });
    expect(result.current).toBe(0);

    act(() => {
      useThemeLibraryStore.getState().setAppearancePreference({
        panelAnimationDuration: 350,
      });
      reducedMotion = true;
      for (const listener of listeners) listener();
    });
    expect(result.current).toBe(0);

    act(() => {
      reducedMotion = false;
      for (const listener of listeners) listener();
    });
    expect(result.current).toBe(350);
  });
});
