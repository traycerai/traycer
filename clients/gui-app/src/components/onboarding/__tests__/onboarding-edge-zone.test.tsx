import { useRef } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { MotionValue } from "motion/react";
import { useOnboardingHorizontalDrag } from "@/components/onboarding/use-onboarding-swipe";
import { setSystemGestureInsets } from "@/lib/system-gesture-insets";

/**
 * The tour's act layer reaches the screen edges, so it leaves the strips the
 * platform and the navigation swipe own. That strip starts past the OS's own
 * gesture strip, so where a touch lands decides whether the tour follows it.
 * A nested pager's edges are not the screen's and never yield. Driven with
 * real pointer events through the real hook; the surface following the finger
 * is the observable.
 */
function Surface(props: {
  readonly respectsEdgeZones: boolean;
  readonly capture: (offset: MotionValue<number>) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  props.capture(
    useOnboardingHorizontalDrag(ref, {
      enabled: true,
      canCommit: () => true,
      onCommit: () => {},
      onRefused: () => {},
      respectsEdgeZones: props.respectsEdgeZones,
      yieldsToNestedPager: false,
    }),
  );
  return <div ref={ref} data-testid="surface" />;
}

/** Where the surface sits after a leftward drag of 80px from `from`. */
function dragLeftFrom(options: {
  readonly from: number;
  readonly respectsEdgeZones: boolean;
}): number {
  const captured: MotionValue<number>[] = [];
  render(
    <Surface
      respectsEdgeZones={options.respectsEdgeZones}
      capture={(value) => {
        captured[0] = value;
      }}
    />,
  );
  const touch = { isPrimary: true, pointerId: 1, pointerType: "touch" };
  fireEvent.pointerDown(screen.getByTestId("surface"), {
    ...touch,
    clientX: options.from,
    clientY: 300,
  });
  fireEvent.pointerMove(window, {
    ...touch,
    clientX: options.from - 80,
    clientY: 300,
  });
  const offset = captured.at(0);
  if (offset === undefined) throw new Error("the hook never ran");
  return offset.get();
}

describe("the tour's drag and the trailing edge strip", () => {
  beforeEach(() => {
    Object.defineProperty(window, "innerWidth", {
      value: 400,
      configurable: true,
    });
  });
  afterEach(() => {
    cleanup();
    setSystemGestureInsets({ left: 0, right: 0 });
  });

  it("follows a drag that starts past the band", () => {
    expect(dragLeftFrom({ from: 350, respectsEdgeZones: true })).toBeLessThan(
      0,
    );
  });

  it("yields a drag that starts inside the band the OS strip pushed inboard", () => {
    setSystemGestureInsets({ left: 0, right: 40 });

    expect(dragLeftFrom({ from: 350, respectsEdgeZones: true })).toBe(0);
  });

  it("yields the whole viewport when system insets cross", () => {
    setSystemGestureInsets({ left: 250, right: 250 });

    expect(dragLeftFrom({ from: 200, respectsEdgeZones: true })).toBe(0);
  });

  it("keeps a nested pager's drag at the same place, since its edges are not the screen's", () => {
    setSystemGestureInsets({ left: 0, right: 40 });

    expect(dragLeftFrom({ from: 350, respectsEdgeZones: false })).toBeLessThan(
      0,
    );
  });
});
