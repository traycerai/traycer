import { afterEach, describe, expect, it } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useSoftwareKeyboardOpen } from "@/hooks/ui/use-software-keyboard-open";
import { setNativeKeyboardState } from "@/lib/native-keyboard";

/**
 * The union of the two signals, and the point of the hook: each shell has
 * exactly one of them live, so a surface reading either alone is correct in
 * one shell and silently wrong in the other.
 */
class FakeVisualViewport extends EventTarget {
  height = 800;
  offsetTop = 0;
  scale = 1;
}

function installFakeViewport(viewport: FakeVisualViewport | null): void {
  Object.defineProperty(window, "visualViewport", {
    value: viewport,
    configurable: true,
  });
}

function setLayoutViewportHeight(height: number): void {
  Object.defineProperty(document.documentElement, "clientHeight", {
    value: height,
    configurable: true,
  });
}

afterEach(() => {
  installFakeViewport(null);
  setNativeKeyboardState({ open: false, transitioning: false });
});

describe("useSoftwareKeyboardOpen", () => {
  it("is false on a shell with neither signal", () => {
    installFakeViewport(null);
    const { result } = renderHook(() => useSoftwareKeyboardOpen());
    expect(result.current).toBe(false);
  });

  it("follows the browser's measured inset", () => {
    // The mobile-browser shell: iOS Safari overlays the keyboard rather than
    // resizing the page, so the covered strip is the only evidence there is.
    setLayoutViewportHeight(800);
    const viewport = new FakeVisualViewport();
    installFakeViewport(viewport);
    const { result } = renderHook(() => useSoftwareKeyboardOpen());
    expect(result.current).toBe(false);

    act(() => {
      viewport.height = 500;
      viewport.dispatchEvent(new Event("resize"));
    });
    expect(result.current).toBe(true);

    act(() => {
      viewport.height = 800;
      viewport.dispatchEvent(new Event("resize"));
    });
    expect(result.current).toBe(false);
  });

  it("follows the native shell's plugin events with nothing to measure", () => {
    // The installed app: overlay mode (`resize: none`) leaves the visual
    // viewport untouched, so the inset reads 0 for the whole time the keyboard
    // is up and only the plugin can answer.
    setLayoutViewportHeight(800);
    installFakeViewport(new FakeVisualViewport());
    const { result } = renderHook(() => useSoftwareKeyboardOpen());
    expect(result.current).toBe(false);

    act(() => {
      setNativeKeyboardState({ open: true, transitioning: true });
    });
    expect(result.current).toBe(true);

    act(() => {
      setNativeKeyboardState({ open: false, transitioning: true });
    });
    expect(result.current).toBe(false);
  });

  it("stays open while either signal still says so", () => {
    // Neither is authoritative for the other, so the union only clears when
    // both do - a shell that produced both must not flicker as they settle at
    // different moments.
    setLayoutViewportHeight(800);
    const viewport = new FakeVisualViewport();
    viewport.height = 500;
    installFakeViewport(viewport);
    const { result } = renderHook(() => useSoftwareKeyboardOpen());
    act(() => {
      setNativeKeyboardState({ open: true, transitioning: false });
    });
    expect(result.current).toBe(true);

    act(() => {
      setNativeKeyboardState({ open: false, transitioning: false });
    });
    expect(result.current).toBe(true);

    act(() => {
      viewport.height = 800;
      viewport.dispatchEvent(new Event("resize"));
    });
    expect(result.current).toBe(false);
  });
});
