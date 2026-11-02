/**
 * `useWheelZoom` decides what a wheel event means from `event.timeStamp`
 * (gestures are runs of events with small gaps). jsdom stamps `timeStamp` at
 * construction from a real clock, so each test pins it with
 * `Object.defineProperty` before dispatch; that makes every gap exact.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { useRef } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { useWheelZoom } from "@/hooks/ui/use-wheel-zoom";

interface WheelInput {
  readonly deltaY: number;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly timeStamp: number;
}

interface ProbeProps {
  readonly zoomBy: (factor: number) => void;
}

function Probe({ zoomBy }: ProbeProps) {
  const ref = useRef<HTMLDivElement>(null);
  useWheelZoom(ref, zoomBy);
  return <div ref={ref} data-testid="wheel-zone" />;
}

function mountProbe() {
  const zoomBy = vi.fn<(factor: number) => void>();
  const view = render(<Probe zoomBy={zoomBy} />);
  return { zoomBy, unmount: view.unmount };
}

function dispatchWheel(input: WheelInput): WheelEvent {
  const event = new WheelEvent("wheel", {
    deltaY: input.deltaY,
    ctrlKey: input.ctrlKey,
    metaKey: input.metaKey,
    cancelable: true,
  });
  Object.defineProperty(event, "timeStamp", { value: input.timeStamp });
  screen.getByTestId("wheel-zone").dispatchEvent(event);
  return event;
}

function plainWheel(timeStamp: number): WheelInput {
  return { deltaY: 40, ctrlKey: false, metaKey: false, timeStamp };
}

function commandWheel(timeStamp: number, deltaY: number): WheelInput {
  return { deltaY, ctrlKey: false, metaKey: true, timeStamp };
}

function ctrlWheel(timeStamp: number, deltaY: number): WheelInput {
  return { deltaY, ctrlKey: true, metaKey: false, timeStamp };
}

function pressControl(type: "keydown" | "keyup"): void {
  window.dispatchEvent(new KeyboardEvent(type, { key: "Control" }));
}

afterEach(() => {
  cleanup();
});

describe("useWheelZoom", () => {
  it("zooms by exp(-deltaY / 500) for command + wheel and prevents the browser default", () => {
    const { zoomBy } = mountProbe();

    const event = dispatchWheel(commandWheel(1000, 100));

    expect(zoomBy).toHaveBeenCalledTimes(1);
    expect(zoomBy.mock.calls[0]?.[0]).toBeCloseTo(Math.exp(-100 / 500), 10);
    expect(event.defaultPrevented).toBe(true);
  });

  it("converts a wheel reported in lines to pixels before zooming", () => {
    const { zoomBy } = mountProbe();
    const event = new WheelEvent("wheel", {
      deltaY: 3,
      deltaMode: WheelEvent.DOM_DELTA_LINE,
      metaKey: true,
      cancelable: true,
    });

    screen.getByTestId("wheel-zone").dispatchEvent(event);

    expect(zoomBy.mock.calls[0]?.[0]).toBeCloseTo(Math.exp(-120 / 500), 10);
  });

  it("leaves a coasting scroll alone when a modifier is pressed mid-gesture, then zooms after a pause", () => {
    const { zoomBy } = mountProbe();

    dispatchWheel(plainWheel(1000));
    dispatchWheel(plainWheel(1050));
    const coastingEvent = dispatchWheel(ctrlWheel(1100, 40));

    expect(zoomBy).not.toHaveBeenCalled();
    expect(coastingEvent.defaultPrevented).toBe(false);

    const afterPauseEvent = dispatchWheel(commandWheel(1400, 100));

    expect(zoomBy).toHaveBeenCalledTimes(1);
    expect(afterPauseEvent.defaultPrevented).toBe(true);
  });

  it("keeps zooming through the rest of a zoom gesture after the modifier is released", () => {
    const { zoomBy } = mountProbe();

    dispatchWheel(commandWheel(1000, 100));
    const trailingEvent = dispatchWheel({ ...plainWheel(1050), deltaY: 50 });

    expect(zoomBy).toHaveBeenCalledTimes(2);
    expect(zoomBy.mock.calls[1]?.[0]).toBeCloseTo(Math.exp(-50 / 500), 10);
    expect(trailingEvent.defaultPrevented).toBe(true);
  });

  it("zooms a trackpad pinch (ctrl without a Control keydown) at exp(-deltaY / 100) and a held Control at exp(-deltaY / 500), until keyup", () => {
    const { zoomBy } = mountProbe();

    dispatchWheel(ctrlWheel(1000, 100));
    expect(zoomBy.mock.calls[0]?.[0]).toBeCloseTo(Math.exp(-100 / 100), 10);

    pressControl("keydown");
    dispatchWheel(ctrlWheel(2000, 100));
    expect(zoomBy.mock.calls[1]?.[0]).toBeCloseTo(Math.exp(-100 / 500), 10);

    pressControl("keyup");
    dispatchWheel(ctrlWheel(3000, 100));
    expect(zoomBy.mock.calls[2]?.[0]).toBeCloseTo(Math.exp(-100 / 100), 10);
  });

  it("returns to the pinch rate when the window loses focus while Control is held", () => {
    const { zoomBy } = mountProbe();

    pressControl("keydown");
    dispatchWheel(ctrlWheel(1000, 100));
    expect(zoomBy.mock.calls[0]?.[0]).toBeCloseTo(Math.exp(-100 / 500), 10);

    window.dispatchEvent(new Event("blur"));
    dispatchWheel(ctrlWheel(2000, 100));
    expect(zoomBy.mock.calls[1]?.[0]).toBeCloseTo(Math.exp(-100 / 100), 10);
  });

  it("stops listening once unmounted", () => {
    const { zoomBy, unmount } = mountProbe();
    const zone = screen.getByTestId("wheel-zone");
    unmount();

    const event = new WheelEvent("wheel", {
      deltaY: 100,
      metaKey: true,
      cancelable: true,
    });
    zone.dispatchEvent(event);

    expect(zoomBy).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
  });
});
