import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useHorizontalWheelScroll } from "@/hooks/use-horizontal-wheel-scroll";

function WheelHarness() {
  const handleWheel = useHorizontalWheelScroll();
  return <div data-testid="scroller" onWheel={handleWheel} />;
}

function renderScroller(input: {
  readonly clientWidth: number;
  readonly clientHeight: number;
  readonly scrollWidth: number;
  readonly scrollLeft: number;
}) {
  render(<WheelHarness />);
  const scroller = screen.getByTestId("scroller");
  Object.defineProperties(scroller, {
    clientWidth: { configurable: true, value: input.clientWidth },
    clientHeight: { configurable: true, value: input.clientHeight },
    scrollWidth: { configurable: true, value: input.scrollWidth },
  });
  scroller.scrollLeft = input.scrollLeft;
  return scroller;
}

describe("useHorizontalWheelScroll", () => {
  afterEach(() => {
    cleanup();
  });

  it("does nothing when the element does not overflow", () => {
    const scroller = renderScroller({
      clientWidth: 100,
      clientHeight: 40,
      scrollWidth: 100,
      scrollLeft: 0,
    });

    fireEvent.wheel(scroller, { deltaY: 80, deltaMode: 0 });

    expect(scroller.scrollLeft).toBe(0);
  });

  it("maps vertical wheel movement to horizontal scroll", () => {
    const scroller = renderScroller({
      clientWidth: 100,
      clientHeight: 40,
      scrollWidth: 400,
      scrollLeft: 0,
    });

    fireEvent.wheel(scroller, { deltaY: 80, deltaMode: 0 });

    expect(scroller.scrollLeft).toBe(80);
  });

  it("keeps horizontal trackpad movement horizontal", () => {
    const scroller = renderScroller({
      clientWidth: 100,
      clientHeight: 40,
      scrollWidth: 400,
      scrollLeft: 0,
    });

    fireEvent.wheel(scroller, { deltaX: 64, deltaY: 12, deltaMode: 0 });

    expect(scroller.scrollLeft).toBe(64);
  });

  it("scrolls left on negative wheel movement", () => {
    const scroller = renderScroller({
      clientWidth: 100,
      clientHeight: 40,
      scrollWidth: 400,
      scrollLeft: 120,
    });

    fireEvent.wheel(scroller, { deltaY: -40, deltaMode: 0 });

    expect(scroller.scrollLeft).toBe(80);
  });

  it("clamps at the scroll edges", () => {
    const scroller = renderScroller({
      clientWidth: 100,
      clientHeight: 40,
      scrollWidth: 400,
      scrollLeft: 280,
    });

    fireEvent.wheel(scroller, { deltaY: 80, deltaMode: 0 });
    expect(scroller.scrollLeft).toBe(300);

    fireEvent.wheel(scroller, { deltaY: 80, deltaMode: 0 });
    expect(scroller.scrollLeft).toBe(300);
  });

  it("normalizes line and page wheel deltas to the scroller size", () => {
    const scroller = renderScroller({
      clientWidth: 100,
      clientHeight: 40,
      scrollWidth: 500,
      scrollLeft: 0,
    });

    fireEvent.wheel(scroller, { deltaY: 2, deltaMode: 1 });
    expect(scroller.scrollLeft).toBe(80);

    fireEvent.wheel(scroller, { deltaY: 1, deltaMode: 2 });
    expect(scroller.scrollLeft).toBe(180);
  });
});
