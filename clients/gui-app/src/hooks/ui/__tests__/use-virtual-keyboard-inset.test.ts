import { afterEach, describe, expect, it } from "vitest";
import { act, renderHook } from "@testing-library/react";
import {
  readVirtualKeyboardInset,
  useVirtualKeyboardInset,
} from "@/hooks/ui/use-virtual-keyboard-inset";

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
});

describe("readVirtualKeyboardInset", () => {
  it("is 0 when the browser has no visualViewport", () => {
    installFakeViewport(null);
    expect(readVirtualKeyboardInset()).toBe(0);
  });

  it("is 0 while the visual viewport fills the layout viewport", () => {
    setLayoutViewportHeight(800);
    installFakeViewport(new FakeVisualViewport());
    expect(readVirtualKeyboardInset()).toBe(0);
  });

  it("measures the covered strip when a keyboard overlays", () => {
    setLayoutViewportHeight(800);
    const viewport = new FakeVisualViewport();
    viewport.height = 500;
    installFakeViewport(viewport);
    expect(readVirtualKeyboardInset()).toBe(300);
  });

  it("accounts for iOS shifting the visual viewport down the page", () => {
    setLayoutViewportHeight(800);
    const viewport = new FakeVisualViewport();
    viewport.height = 500;
    viewport.offsetTop = 40;
    installFakeViewport(viewport);
    expect(readVirtualKeyboardInset()).toBe(260);
  });

  it("is 0 during pinch zoom (visual viewport shrinks without a keyboard)", () => {
    setLayoutViewportHeight(800);
    const viewport = new FakeVisualViewport();
    viewport.height = 400;
    viewport.scale = 2;
    installFakeViewport(viewport);
    expect(readVirtualKeyboardInset()).toBe(0);
  });

  it("treats sub-keyboard-height differences as viewport disagreement, not a keyboard", () => {
    // iOS toolbar expand/collapse can leave layout vs visual viewport off by
    // up to ~100px at rest; no soft keyboard is that short.
    setLayoutViewportHeight(800);
    const viewport = new FakeVisualViewport();
    viewport.height = 720;
    installFakeViewport(viewport);
    expect(readVirtualKeyboardInset()).toBe(0);
  });

  it("clamps at 0 when the platform resized the layout itself", () => {
    // Android resizes-content / Capacitor native mode: layout shrinks WITH
    // the visual viewport, so nothing is covered.
    setLayoutViewportHeight(500);
    const viewport = new FakeVisualViewport();
    viewport.height = 500;
    installFakeViewport(viewport);
    expect(readVirtualKeyboardInset()).toBe(0);
  });
});

describe("useVirtualKeyboardInset", () => {
  it("re-reads on visual viewport resize and scroll", () => {
    setLayoutViewportHeight(800);
    const viewport = new FakeVisualViewport();
    installFakeViewport(viewport);
    const { result } = renderHook(() => useVirtualKeyboardInset());
    expect(result.current).toBe(0);

    act(() => {
      viewport.height = 520;
      viewport.dispatchEvent(new Event("resize"));
    });
    expect(result.current).toBe(280);

    act(() => {
      viewport.offsetTop = 30;
      viewport.dispatchEvent(new Event("scroll"));
    });
    expect(result.current).toBe(250);

    act(() => {
      viewport.height = 800;
      viewport.offsetTop = 0;
      viewport.dispatchEvent(new Event("resize"));
    });
    expect(result.current).toBe(0);
  });
});
