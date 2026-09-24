/**
 * `usePinchZoom` drives a two-finger pinch off real `TouchEvent`s, but jsdom
 * implements neither `Touch` nor `TouchList`. The fakes below build the
 * smallest shape the hook actually reads (`length`, `item(index)`, and a
 * numeric index) and hand it to the dispatched event through
 * `Object.defineProperty` - `PropertyDescriptor.value` is already typed `any`
 * in the DOM lib, so this needs no cast on our side.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { useRef } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import {
  pinchGeometry,
  usePinchZoom,
  type PinchFocal,
  type PinchZoomCallbacks,
  type PinchZoomUpdate,
} from "@/hooks/ui/use-pinch-zoom";

interface FakeTouchPoint {
  readonly clientX: number;
  readonly clientY: number;
}

interface FakeTouchList {
  readonly length: number;
  item(index: number): FakeTouchPoint | null;
  readonly [index: number]: FakeTouchPoint;
}

function createTouchList(points: readonly FakeTouchPoint[]): FakeTouchList {
  const indexed: Record<number, FakeTouchPoint> = {};
  points.forEach((point, index) => {
    indexed[index] = point;
  });
  return {
    ...indexed,
    length: points.length,
    item: (index: number): FakeTouchPoint | null => points[index] ?? null,
  };
}

function dispatchTouchEvent(
  element: Element,
  type: string,
  points: readonly FakeTouchPoint[],
  cancelable: boolean,
): Event {
  const event = new Event(type, { cancelable });
  Object.defineProperty(event, "touches", { value: createTouchList(points) });
  element.dispatchEvent(event);
  return event;
}

function createCallbacks() {
  return {
    onPinchStart: vi.fn<(focal: PinchFocal) => void>(),
    onPinchMove: vi.fn<(update: PinchZoomUpdate) => void>(),
    onPinchEnd: vi.fn<() => void>(),
  } satisfies PinchZoomCallbacks;
}

interface ProbeProps {
  readonly callbacks: PinchZoomCallbacks | null;
}

function Probe({ callbacks }: ProbeProps) {
  const ref = useRef<HTMLDivElement>(null);
  usePinchZoom(ref, callbacks);
  return <div ref={ref} data-testid="pinch-target" />;
}

function target(): HTMLElement {
  return screen.getByTestId("pinch-target");
}

afterEach(() => {
  cleanup();
});

describe("pinchGeometry", () => {
  it("returns the Euclidean distance and the midpoint", () => {
    const geometry = pinchGeometry(
      { clientX: 0, clientY: 0 },
      { clientX: 3, clientY: 4 },
    );

    expect(geometry.distance).toBe(5);
    expect(geometry.focal).toEqual({ clientX: 1.5, clientY: 2 });
  });
});

describe("usePinchZoom", () => {
  it("calls onPinchStart once with the midpoint focal for a two-finger touchstart", () => {
    const callbacks = createCallbacks();
    render(<Probe callbacks={callbacks} />);

    dispatchTouchEvent(
      target(),
      "touchstart",
      [
        { clientX: 0, clientY: 0 },
        { clientX: 10, clientY: 0 },
      ],
      true,
    );

    expect(callbacks.onPinchStart).toHaveBeenCalledTimes(1);
    expect(callbacks.onPinchStart).toHaveBeenCalledWith({
      clientX: 5,
      clientY: 0,
    });
  });

  it("calls nothing for a single-finger touchstart", () => {
    const callbacks = createCallbacks();
    render(<Probe callbacks={callbacks} />);

    dispatchTouchEvent(
      target(),
      "touchstart",
      [{ clientX: 0, clientY: 0 }],
      true,
    );

    expect(callbacks.onPinchStart).not.toHaveBeenCalled();
    expect(callbacks.onPinchMove).not.toHaveBeenCalled();
    expect(callbacks.onPinchEnd).not.toHaveBeenCalled();
  });

  it("reports ratio, focal and focal travel across successive touchmoves", () => {
    const callbacks = createCallbacks();
    render(<Probe callbacks={callbacks} />);
    const element = target();

    // Start: distance 10, focal (5, 0).
    dispatchTouchEvent(
      element,
      "touchstart",
      [
        { clientX: 0, clientY: 0 },
        { clientX: 10, clientY: 0 },
      ],
      true,
    );

    // First move: same distance (10), focal shifts to (5, 10).
    dispatchTouchEvent(
      element,
      "touchmove",
      [
        { clientX: 0, clientY: 10 },
        { clientX: 10, clientY: 10 },
      ],
      true,
    );

    expect(callbacks.onPinchMove).toHaveBeenNthCalledWith(1, {
      ratio: 1,
      focal: { clientX: 5, clientY: 10 },
      focalDeltaX: 0,
      focalDeltaY: 10,
    });

    // Second move: distance doubles to 20, focal moves to (10, 20) - measured
    // from the first move's focal, not the original start focal.
    dispatchTouchEvent(
      element,
      "touchmove",
      [
        { clientX: 0, clientY: 20 },
        { clientX: 20, clientY: 20 },
      ],
      true,
    );

    expect(callbacks.onPinchMove).toHaveBeenNthCalledWith(2, {
      ratio: 2,
      focal: { clientX: 10, clientY: 20 },
      focalDeltaX: 5,
      focalDeltaY: 10,
    });
  });

  it("prevents default on a cancelable two-finger touchmove", () => {
    const callbacks = createCallbacks();
    render(<Probe callbacks={callbacks} />);
    const element = target();

    dispatchTouchEvent(
      element,
      "touchstart",
      [
        { clientX: 0, clientY: 0 },
        { clientX: 10, clientY: 0 },
      ],
      true,
    );
    const move = dispatchTouchEvent(
      element,
      "touchmove",
      [
        { clientX: 0, clientY: 1 },
        { clientX: 10, clientY: 1 },
      ],
      true,
    );

    expect(move.defaultPrevented).toBe(true);
  });

  it("does not prevent default when the touchmove was not cancelable", () => {
    const callbacks = createCallbacks();
    render(<Probe callbacks={callbacks} />);
    const element = target();

    dispatchTouchEvent(
      element,
      "touchstart",
      [
        { clientX: 0, clientY: 0 },
        { clientX: 10, clientY: 0 },
      ],
      true,
    );
    const move = dispatchTouchEvent(
      element,
      "touchmove",
      [
        { clientX: 0, clientY: 1 },
        { clientX: 10, clientY: 1 },
      ],
      false,
    );

    expect(move.defaultPrevented).toBe(false);
  });

  it("begins the pinch on a two-finger touchmove with no preceding touchstart", () => {
    const callbacks = createCallbacks();
    render(<Probe callbacks={callbacks} />);

    dispatchTouchEvent(
      target(),
      "touchmove",
      [
        { clientX: 0, clientY: 0 },
        { clientX: 10, clientY: 0 },
      ],
      true,
    );

    expect(callbacks.onPinchStart).toHaveBeenCalledTimes(1);
    expect(callbacks.onPinchStart).toHaveBeenCalledWith({
      clientX: 5,
      clientY: 0,
    });
    expect(callbacks.onPinchMove).toHaveBeenCalledTimes(1);
    const [update] = callbacks.onPinchMove.mock.calls[0];
    expect(update.ratio).toBe(1);
  });

  it("ends the pinch once touchend leaves fewer than two fingers, then calls nothing more", () => {
    const callbacks = createCallbacks();
    render(<Probe callbacks={callbacks} />);
    const element = target();

    dispatchTouchEvent(
      element,
      "touchstart",
      [
        { clientX: 0, clientY: 0 },
        { clientX: 10, clientY: 0 },
      ],
      true,
    );
    dispatchTouchEvent(element, "touchend", [{ clientX: 0, clientY: 0 }], true);

    expect(callbacks.onPinchEnd).toHaveBeenCalledTimes(1);

    dispatchTouchEvent(element, "touchend", [], true);

    expect(callbacks.onPinchEnd).toHaveBeenCalledTimes(1);
  });

  it("ends an active pinch on a three-finger touchstart instead of starting a new one", () => {
    const callbacks = createCallbacks();
    render(<Probe callbacks={callbacks} />);
    const element = target();

    dispatchTouchEvent(
      element,
      "touchstart",
      [
        { clientX: 0, clientY: 0 },
        { clientX: 10, clientY: 0 },
      ],
      true,
    );
    dispatchTouchEvent(
      element,
      "touchstart",
      [
        { clientX: 0, clientY: 0 },
        { clientX: 10, clientY: 0 },
        { clientX: 20, clientY: 0 },
      ],
      true,
    );

    expect(callbacks.onPinchEnd).toHaveBeenCalledTimes(1);
    expect(callbacks.onPinchStart).toHaveBeenCalledTimes(1);
  });

  it("floors the start distance at 1px when both fingers land on the same point", () => {
    const callbacks = createCallbacks();
    render(<Probe callbacks={callbacks} />);
    const element = target();

    dispatchTouchEvent(
      element,
      "touchstart",
      [
        { clientX: 5, clientY: 5 },
        { clientX: 5, clientY: 5 },
      ],
      true,
    );
    dispatchTouchEvent(
      element,
      "touchmove",
      [
        { clientX: 0, clientY: 5 },
        { clientX: 10, clientY: 5 },
      ],
      true,
    );

    expect(callbacks.onPinchMove).toHaveBeenCalledTimes(1);
    const [update] = callbacks.onPinchMove.mock.calls[0];
    expect(update.ratio).toBe(10);
  });

  it("calls nothing on any touch event when callbacks is null, and still renders", () => {
    render(<Probe callbacks={null} />);
    const element = target();

    expect(() => {
      dispatchTouchEvent(
        element,
        "touchstart",
        [
          { clientX: 0, clientY: 0 },
          { clientX: 10, clientY: 0 },
        ],
        true,
      );
      dispatchTouchEvent(
        element,
        "touchmove",
        [
          { clientX: 0, clientY: 10 },
          { clientX: 10, clientY: 10 },
        ],
        true,
      );
      dispatchTouchEvent(element, "touchend", [], true);
    }).not.toThrow();

    expect(document.body.contains(target())).toBe(true);
  });

  it("removes its listeners on unmount", () => {
    const callbacks = createCallbacks();
    const { unmount } = render(<Probe callbacks={callbacks} />);
    const element = target();

    dispatchTouchEvent(
      element,
      "touchstart",
      [
        { clientX: 0, clientY: 0 },
        { clientX: 10, clientY: 0 },
      ],
      true,
    );
    expect(callbacks.onPinchStart).toHaveBeenCalledTimes(1);

    unmount();

    dispatchTouchEvent(
      element,
      "touchmove",
      [
        { clientX: 0, clientY: 10 },
        { clientX: 10, clientY: 10 },
      ],
      true,
    );
    dispatchTouchEvent(element, "touchend", [], true);

    expect(callbacks.onPinchStart).toHaveBeenCalledTimes(1);
    expect(callbacks.onPinchMove).not.toHaveBeenCalled();
    expect(callbacks.onPinchEnd).not.toHaveBeenCalled();
  });
});
