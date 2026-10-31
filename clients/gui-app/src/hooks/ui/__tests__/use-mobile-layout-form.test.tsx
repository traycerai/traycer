import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useMobileLayoutForm } from "@/hooks/ui/use-mobile-layout-form";
import type { MobileTileCount } from "@/lib/layout/mobile-layout-form";
import { useSideTabStripStore } from "@/stores/layout/side-tab-strip-store";

/**
 * The real store and the real inset read; only the browser's measurements are
 * fake. The media query shim evaluates the query the hook actually asked, so
 * the phone-portrait limit is held by what it answers on a viewport, and the
 * viewport and the screen move independently, as they do under a keyboard.
 */
const resizeObservers = new Set<() => void>();
const orientationListeners = new Set<() => void>();
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
  const limit = /^\(width < (\d+)px\)$/.exec(query)?.[1];
  return {
    matches: viewport.width < Number(limit),
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

function setScreenOrientation(type: OrientationType): void {
  Object.defineProperty(window.screen, "orientation", {
    configurable: true,
    value: {
      type,
      addEventListener: (_: string, listener: () => void) => {
        orientationListeners.add(listener);
      },
      removeEventListener: (_: string, listener: () => void) => {
        orientationListeners.delete(listener);
      },
    },
  });
}

/** Only the screen turning, with nothing from the viewport to re-ask on. */
function rotateScreen(type: OrientationType): void {
  setScreenOrientation(type);
  act(() => {
    for (const listener of orientationListeners) listener();
  });
}

/** A browser with no `screen.orientation`, left with the screen's dimensions. */
function setScreenWithoutOrientation(width: number, height: number): void {
  Reflect.deleteProperty(window.screen, "orientation");
  Object.defineProperty(window.screen, "width", {
    configurable: true,
    value: width,
  });
  Object.defineProperty(window.screen, "height", {
    configurable: true,
    value: height,
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
  act(() => {
    window.dispatchEvent(new Event("resize"));
  });
}

const PHONE_PORTRAIT = { level1: "drawer", level2: "bar", tiles: 1 };
const RAIL_AND_MENU = { level1: "rail", level2: "menu", tiles: 1 };

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
  setScreenOrientation("landscape-primary");
  root = document.createElement("div");
  root.id = "root";
  document.body.append(root);
  useSideTabStripStore.setState({ collapsed: false, dragCollapsed: null });
});

afterEach(() => {
  cleanup();
  root.remove();
  resizeObservers.clear();
  orientationListeners.clear();
  Reflect.deleteProperty(window.screen, "orientation");
  Reflect.deleteProperty(window.screen, "width");
  Reflect.deleteProperty(window.screen, "height");
  document.documentElement.style.removeProperty("--safe-area-inset-left");
  document.documentElement.style.removeProperty("--safe-area-inset-right");
  window.dispatchEvent(new Event("resize"));
  setMatchMedia(originalMatchMedia);
  vi.unstubAllGlobals();
});

describe("useMobileLayoutForm", () => {
  it("answers from the shell's box after both side insets", () => {
    // 760 of window would earn column 256, and 698 after one inset column 220.
    setViewport(760, 402, { left: 62, right: 62 });
    render(<Probe openTiles={1} />);
    expect(renderedForm()).toEqual(RAIL_AND_MENU);
  });

  it("re-measures when only the shell's box moves", () => {
    setViewport(760, 402, { left: 0, right: 0 });
    render(<Probe openTiles={1} />);
    expect(renderedForm()).toEqual({
      level1: "rail",
      level2: { column: 256 },
      tiles: 1,
    });

    root.getBoundingClientRect = () => new DOMRect(0, 0, 594, 402);
    act(fireResizeObservers);
    expect(renderedForm()).toEqual(RAIL_AND_MENU);
  });

  // Every width here is in the band where only phone portrait answers the bar:
  // under it the resolver answers the bar whatever the orientation.
  it("answers the bar at the viewport limit only on a screen in portrait", () => {
    setScreenOrientation("portrait-primary");
    setViewport(466, 800, { left: 0, right: 0 });
    render(<Probe openTiles={1} />);
    expect(renderedForm()).toEqual(PHONE_PORTRAIT);

    setViewport(467, 800, { left: 0, right: 0 });
    expect(renderedForm()).toEqual(RAIL_AND_MENU);
  });

  it("keeps the bar when a keyboard shortens the viewport past its width", () => {
    setScreenOrientation("portrait-primary");
    setViewport(450, 800, { left: 0, right: 0 });
    render(<Probe openTiles={1} />);
    expect(renderedForm()).toEqual(PHONE_PORTRAIT);

    setViewport(450, 400, { left: 0, right: 0 });
    expect(renderedForm()).toEqual(PHONE_PORTRAIT);
  });

  it("re-answers when the screen turns, at the same width", () => {
    setScreenOrientation("portrait-primary");
    setViewport(450, 800, { left: 0, right: 0 });
    render(<Probe openTiles={1} />);
    expect(renderedForm()).toEqual(PHONE_PORTRAIT);

    rotateScreen("landscape-primary");
    expect(renderedForm()).toEqual(RAIL_AND_MENU);
  });

  it("applies the limit to the viewport, not the content box", () => {
    // 446 of content is under the limit; the 530 viewport around it is not.
    setScreenOrientation("portrait-primary");
    setViewport(530, 800, { left: 0, right: 84 });
    render(<Probe openTiles={1} />);
    expect(renderedForm()).toEqual(RAIL_AND_MENU);
  });

  it("falls back to the screen's dimensions without screen.orientation", () => {
    setScreenWithoutOrientation(450, 800);
    setViewport(450, 800, { left: 0, right: 0 });
    render(<Probe openTiles={1} />);
    expect(renderedForm()).toEqual(PHONE_PORTRAIT);

    setScreenWithoutOrientation(800, 450);
    setViewport(450, 400, { left: 0, right: 0 });
    expect(renderedForm()).toEqual(RAIL_AND_MENU);
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
