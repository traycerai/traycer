import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HostContextFrame } from "@/components/layout-editor/region-depiction-frame";

/**
 * The clip fade's own contract (L-45), separate from `region-depiction-frame-parity.test.tsx`'s
 * class-string parity: that `data-clipped` actually tracks real overflow
 * (both on a content change and on a real resize), and that the fade the
 * frame ships only ever applies in the clipped state.
 *
 * jsdom computes no layout, so `mask-image` never actually paints; what a
 * suite here CAN assert is the two things production code controls directly:
 * the `data-clipped` attribute (driven by the real `scrollWidth`/`clientWidth`
 * read) and the `data-[clipped=true]:` conditional on the mask classes.
 */

const CLIPPED = "data-[clipped=true]:";

/** Fires only for the frame under test, never a stray ancestor/descendant. */
function stubOverflow(scrollWidth: number, clientWidth: number): () => void {
  const scroll = vi
    .spyOn(Element.prototype, "scrollWidth", "get")
    .mockImplementation(function (this: Element) {
      return this.hasAttribute("data-layout-depiction") ? scrollWidth : 0;
    });
  const client = vi
    .spyOn(Element.prototype, "clientWidth", "get")
    .mockImplementation(function (this: Element) {
      return this.hasAttribute("data-layout-depiction") ? clientWidth : 0;
    });
  return () => {
    scroll.mockRestore();
    client.mockRestore();
  };
}

/**
 * A controllable stand-in for the suite-wide `MockResizeObserver`
 * (`__tests__/test-browser-apis.ts`), whose `observe()` is deliberately inert
 * so an unrelated suite never gets a surprise callback. This one records the
 * observed element and lets a test fire its own callback, which is the only
 * way to prove the frame's resize path - not just its content-change path -
 * actually re-measures.
 */
class ControllableResizeObserver implements ResizeObserver {
  static readonly instances: ControllableResizeObserver[] = [];
  private readonly callback: ResizeObserverCallback;
  private target: Element | null = null;

  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
    ControllableResizeObserver.instances.push(this);
  }

  observe(target: Element): void {
    this.target = target;
  }

  unobserve(): void {
    this.target = null;
  }

  disconnect(): void {
    this.target = null;
  }

  fire(): void {
    if (this.target === null) return;
    this.callback([], this);
  }
}

function frame(): HTMLElement {
  const node = document.querySelector("[data-layout-depiction]");
  if (!(node instanceof HTMLElement)) throw new Error("no such frame");
  return node;
}

describe("HostContextFrame's clip fade (L-45)", () => {
  let originalResizeObserver: typeof ResizeObserver = globalThis.ResizeObserver;

  beforeEach(() => {
    originalResizeObserver = globalThis.ResizeObserver;
    globalThis.ResizeObserver = ControllableResizeObserver;
    ControllableResizeObserver.instances.length = 0;
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    globalThis.ResizeObserver = originalResizeObserver;
  });

  it("ships the fade only as a clipped-state class, in both the standard and WebKit mask properties", () => {
    // No overflow stub needed: Tailwind's `data-[clipped=true]:` variant is a
    // static class in the DOM's class list either way - the CSS engine, not
    // JS, decides whether it applies. An unconditional mask would fade a
    // full-width dock row whose right edge nothing was hiding.
    render(<HostContextFrame host="toolbar">short</HostContextFrame>);
    const masks = frame()
      .className.split(/\s+/)
      .filter((name) => name.includes("mask-image"));
    expect(masks.filter((name) => !name.startsWith(CLIPPED))).toEqual([]);
    expect(
      masks.some((name) => name.startsWith(`${CLIPPED}[mask-image:`)),
    ).toBe(true);
    expect(
      masks.some((name) => name.startsWith(`${CLIPPED}[-webkit-mask-image:`)),
    ).toBe(true);
    // Each is a FADE (L-45): opaque content, then a real run of fading, ending
    // transparent before the right edge. An opaque gradient, or stops that
    // meet or cross (which CSS clamps into a hard cut), would leave the
    // clipped picture meeting a hard boundary.
    for (const mask of masks) {
      const stops =
        /linear-gradient\(to_right,black_calc\(100%-(\d+)px\),transparent_calc\(100%-(\d+)px\)\)\]$/.exec(
          mask,
        );
      expect(stops, mask).not.toBeNull();
      const blackInset = Number(stops?.[1]);
      const transparentInset = Number(stops?.[2]);
      expect(transparentInset, mask).toBeGreaterThan(0);
      expect(blackInset, mask).toBeGreaterThan(transparentInset);
    }
  });

  it("does not mark itself clipped when the content fits", () => {
    const restore = stubOverflow(100, 100);
    render(<HostContextFrame host="toolbar">fits</HostContextFrame>);
    expect(frame().getAttribute("data-clipped")).toBe("false");
    restore();
  });

  it("marks itself clipped once content overflows its box", () => {
    const restore = stubOverflow(200, 100);
    render(<HostContextFrame host="toolbar">overflowing</HostContextFrame>);
    expect(frame().getAttribute("data-clipped")).toBe("true");
    restore();
  });

  it("re-measures on a CONTENT change at the same width, clipped to fitting", () => {
    const restoreClipped = stubOverflow(200, 100);
    const { rerender } = render(
      <HostContextFrame host="toolbar">a much longer reading</HostContextFrame>,
    );
    expect(frame().getAttribute("data-clipped")).toBe("true");
    restoreClipped();

    const restoreFits = stubOverflow(100, 100);
    act(() => {
      rerender(<HostContextFrame host="toolbar">short</HostContextFrame>);
    });
    expect(frame().getAttribute("data-clipped")).toBe("false");
    restoreFits();
  });

  it("re-measures on a REAL RESIZE with unchanged content, fitting to clipped", () => {
    const restoreFits = stubOverflow(100, 100);
    render(<HostContextFrame host="toolbar">unchanged</HostContextFrame>);
    expect(frame().getAttribute("data-clipped")).toBe("false");
    restoreFits();

    const restoreClipped = stubOverflow(200, 100);
    expect(ControllableResizeObserver.instances).toHaveLength(1);
    act(() => {
      ControllableResizeObserver.instances[0]?.fire();
    });
    expect(frame().getAttribute("data-clipped")).toBe("true");
    restoreClipped();
  });
});
