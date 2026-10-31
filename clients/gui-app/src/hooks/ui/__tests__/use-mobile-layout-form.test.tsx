import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useMobileLayoutForm } from "@/hooks/ui/use-mobile-layout-form";
import type { MobileTileCount } from "@/lib/layout/mobile-layout-form";
import { useSideTabStripStore } from "@/stores/layout/side-tab-strip-store";

/**
 * The real store and the real inset read; only the browser's measurements are
 * fake. The media query shim evaluates the query the hook actually asked, so
 * the phone-portrait limit is held by what it answers on a viewport.
 */
const resizeObservers = new Set<() => void>();
const viewport = { width: 0, height: 0 };

class FakeResizeObserver implements ResizeObserver {
  private readonly notify: () => void;

  constructor(callback: ResizeObserverCallback) {
    this.notify = () => {
      callback([], this);
    };
  }

  observe(): void {
    resizeObservers.add(this.notify);
  }

  unobserve(): void {}

  disconnect(): void {
    resizeObservers.delete(this.notify);
  }
}

function fakeMatchMedia(
  query: string,
): Pick<
  MediaQueryList,
  "matches" | "addEventListener" | "removeEventListener"
> {
  const limit = /\(width < (\d+)px\)/.exec(query)?.[1];
  return {
    matches:
      query.includes("(orientation: portrait)") &&
      viewport.height >= viewport.width &&
      viewport.width < Number(limit),
    addEventListener: () => {},
    removeEventListener: () => {},
  };
}

const originalMatchMedia = window.matchMedia.bind(window);

function setMatchMedia(value: unknown): void {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value,
  });
}

let root: HTMLElement;

/** The window at a size, with the side inset the OS reserves in that posture. */
function setViewport(
  width: number,
  height: number,
  insets: { readonly left: number; readonly right: number },
): void {
  viewport.width = width;
  viewport.height = height;
  root.getBoundingClientRect = () => new DOMRect(0, 0, width, height);
  const { style } = document.documentElement;
  style.setProperty("--safe-area-inset-left", `${insets.left}px`);
  style.setProperty("--safe-area-inset-right", `${insets.right}px`);
  window.dispatchEvent(new Event("resize"));
}

function fireResizeObservers(): void {
  for (const notify of resizeObservers) notify();
}

function Probe(props: { readonly openTiles: MobileTileCount }) {
  return (
    <output>{JSON.stringify(useMobileLayoutForm(props.openTiles))}</output>
  );
}

function renderedForm(): unknown {
  return JSON.parse(screen.getByRole("status").textContent);
}

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", FakeResizeObserver);
  setMatchMedia(fakeMatchMedia);
  root = document.createElement("div");
  root.id = "root";
  document.body.append(root);
  useSideTabStripStore.setState({ collapsed: false, dragCollapsed: null });
});

afterEach(() => {
  cleanup();
  root.remove();
  resizeObservers.clear();
  document.documentElement.style.removeProperty("--safe-area-inset-left");
  document.documentElement.style.removeProperty("--safe-area-inset-right");
  window.dispatchEvent(new Event("resize"));
  setMatchMedia(originalMatchMedia);
  vi.unstubAllGlobals();
});

describe("useMobileLayoutForm", () => {
  it("answers from the shell's box after the side insets", () => {
    // 874 of window would earn two tiles' threshold; 750 of content does not.
    setViewport(874, 402, { left: 62, right: 62 });
    render(<Probe openTiles={1} />);
    expect(renderedForm()).toEqual({
      level1: "rail",
      level2: { column: 256 },
      tiles: 1,
    });

    setViewport(678, 466, { left: 0, right: 84 });
    act(fireResizeObservers);
    expect(renderedForm()).toEqual({
      level1: "rail",
      level2: "menu",
      tiles: 1,
    });
  });

  it("reads phone portrait off the viewport, not the content box", () => {
    // The widest phone in portrait, its content narrowed further by an inset.
    setViewport(466, 678, { left: 0, right: 84 });
    render(<Probe openTiles={1} />);
    expect(renderedForm()).toEqual({
      level1: "drawer",
      level2: "bar",
      tiles: 1,
    });

    // The narrowest portrait that is not a phone.
    setViewport(669, 951, { left: 0, right: 0 });
    act(fireResizeObservers);
    expect(renderedForm()).toEqual({
      level1: "rail",
      level2: { column: 220 },
      tiles: 1,
    });
  });

  it("re-answers when the person's strip choice changes", () => {
    setViewport(1133, 744, { left: 0, right: 0 });
    render(<Probe openTiles={1} />);
    expect(renderedForm()).toEqual({
      level1: "expanded",
      level2: { column: 256 },
      tiles: 1,
    });

    act(() => {
      useSideTabStripStore.getState().setCollapsed(true);
    });
    expect(renderedForm()).toEqual({
      level1: "rail",
      level2: { column: 256 },
      tiles: 1,
    });
  });

  it("answers for the tiles the caller has open", () => {
    setViewport(832, 402, { left: 0, right: 0 });
    render(<Probe openTiles={2} />);
    expect(renderedForm()).toEqual({
      level1: "rail",
      level2: "menu",
      tiles: 2,
    });
  });
});
