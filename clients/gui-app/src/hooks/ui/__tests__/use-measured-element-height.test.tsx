import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { StrictMode, type ReactNode } from "react";
import { PaneVisibilityContext } from "@/components/epic-tabs/pane-visibility-context";
import { useMeasuredElementHeight } from "@/hooks/ui/use-measured-element-height";

/**
 * Ticket 18 rider: the chat-tile ResizeObserver->prop contract was previously
 * pinned only via a hand-copied structural twin. This is the SAME hook
 * `chat-tile.tsx` consumes.
 *
 * W2-H2: rewritten from a `getBoundingClientRect` stub to a controllable
 * ResizeObserver, since the hook now measures ONLY from the observer's
 * delivered border-box size for the RO half. `measureOnAttach` adds a second,
 * opt-in path: a synchronous layout-effect `rect()` read, once per attached
 * node while visible - `chat-tile.tsx` needs its inset before first paint
 * (`measureOnAttach={true}`); `history-group-header.tsx` has a CSS fallback
 * and stays observer-only (`measureOnAttach={false}`).
 */
function MeasuredHeightInner(props: {
  readonly mounted: boolean;
  readonly measureOnAttach: boolean;
}): ReactNode {
  const { setElement, element, height } = useMeasuredElementHeight(
    props.measureOnAttach,
  );
  return (
    <div>
      <span data-testid="probe-height">
        {element === null ? "unmounted" : String(height)}
      </span>
      {props.mounted ? (
        <div ref={setElement} data-testid="probe-target" />
      ) : null}
    </div>
  );
}

function MeasuredHeightProbe(props: {
  readonly mounted: boolean;
  readonly measureOnAttach: boolean;
  readonly visible: boolean;
}): ReactNode {
  return (
    <PaneVisibilityContext.Provider value={props.visible}>
      <MeasuredHeightInner
        mounted={props.mounted}
        measureOnAttach={props.measureOnAttach}
      />
    </PaneVisibilityContext.Provider>
  );
}

function borderBoxEntry(
  target: Element,
  blockSize: number,
): ResizeObserverEntry {
  return {
    target,
    contentRect: new DOMRectReadOnly(0, 0, 0, 0),
    borderBoxSize: [{ blockSize, inlineSize: 0 }],
    contentBoxSize: [],
    devicePixelContentBoxSize: [],
  };
}

class ControllableResizeObserver implements ResizeObserver {
  readonly callback: ResizeObserverCallback;
  readonly observed = new Set<Element>();
  readonly observeOptions: (ResizeObserverOptions | undefined)[] = [];

  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
    controllableResizeObservers.push(this);
  }

  observe(target: Element, options: ResizeObserverOptions | undefined): void {
    this.observed.add(target);
    this.observeOptions.push(options);
  }

  unobserve(target: Element): void {
    this.observed.delete(target);
  }

  disconnect(): void {
    this.observed.clear();
  }

  emit(blockSize: number): void {
    const target = this.observed.values().next().value;
    if (!(target instanceof Element)) return;
    this.callback([borderBoxEntry(target, blockSize)], this);
  }
}

let controllableResizeObservers: ControllableResizeObserver[] = [];

function resizeObserverFor(target: Element): ControllableResizeObserver {
  const observer = controllableResizeObservers.find((candidate) =>
    candidate.observed.has(target),
  );
  if (observer === undefined) {
    throw new Error("expected a resize observer for target");
  }
  return observer;
}

describe("useMeasuredElementHeight", () => {
  beforeEach(() => {
    controllableResizeObservers = [];
    vi.stubGlobal("ResizeObserver", ControllableResizeObserver);
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("reports 'unmounted' (via the null element) before the ref attaches", () => {
    render(
      <MeasuredHeightProbe mounted={false} measureOnAttach={false} visible />,
    );
    expect(screen.getByTestId("probe-height").textContent).toBe("unmounted");
  });

  it("observer-only (measureOnAttach=false): never reads getBoundingClientRect - height comes only from the observer's delivery", () => {
    const rectSpy = vi.spyOn(Element.prototype, "getBoundingClientRect");
    render(<MeasuredHeightProbe mounted measureOnAttach={false} visible />);
    const target = screen.getByTestId("probe-target");
    act(() => {
      resizeObserverFor(target).emit(119.4);
    });
    expect(screen.getByTestId("probe-height").textContent).toBe("120");
    // Falsification: a regressed hook that still measures via `rect()` on
    // mount or inside the observer callback would show up here.
    expect(rectSpy).not.toHaveBeenCalled();
  });

  it("observes with the border-box box option, and ceils a fractional border-box size up", () => {
    render(<MeasuredHeightProbe mounted measureOnAttach={false} visible />);
    const target = screen.getByTestId("probe-target");
    const observer = resizeObserverFor(target);
    // Falsification: dropping `{ box: "border-box" }` reads content-box sizes
    // instead, silently excluding padding.
    expect(observer.observeOptions.at(-1)?.box).toBe("border-box");

    act(() => {
      observer.emit(150.2);
    });
    expect(screen.getByTestId("probe-height").textContent).toBe("151");
  });

  it("ignores a non-positive delivered size and keeps the last known height", () => {
    render(<MeasuredHeightProbe mounted measureOnAttach={false} visible />);
    const target = screen.getByTestId("probe-target");
    act(() => {
      resizeObserverFor(target).emit(150);
    });
    expect(screen.getByTestId("probe-height").textContent).toBe("150");

    // Falsification: `nextHeight <= 0` no longer bailing collapses reserved
    // layout space to "0" instead of keeping 150.
    act(() => {
      resizeObserverFor(target).emit(0);
    });
    expect(screen.getByTestId("probe-height").textContent).toBe("150");
  });

  it("re-measures via the observer after the element unmounts and a new one attaches", () => {
    const { rerender } = render(
      <MeasuredHeightProbe mounted measureOnAttach={false} visible />,
    );
    const firstTarget = screen.getByTestId("probe-target");
    act(() => {
      resizeObserverFor(firstTarget).emit(80);
    });
    expect(screen.getByTestId("probe-height").textContent).toBe("80");

    act(() => {
      rerender(
        <MeasuredHeightProbe mounted={false} measureOnAttach={false} visible />,
      );
    });
    act(() => {
      rerender(<MeasuredHeightProbe mounted measureOnAttach={false} visible />);
    });
    const secondTarget = screen.getByTestId("probe-target");
    act(() => {
      resizeObserverFor(secondTarget).emit(210);
    });
    expect(screen.getByTestId("probe-height").textContent).toBe("210");
  });

  it("measureOnAttach=true: reads the rect synchronously before the observer ever delivers anything", () => {
    const rectSpy = vi
      .spyOn(Element.prototype, "getBoundingClientRect")
      .mockReturnValue(new DOMRect(0, 0, 0, 119.4));
    render(<MeasuredHeightProbe mounted measureOnAttach visible />);
    // No RO `emit(...)` anywhere in this test - the value must already be
    // here from the synchronous layout-effect read, before first paint.
    expect(screen.getByTestId("probe-height").textContent).toBe("120");
    expect(rectSpy).toHaveBeenCalledTimes(1);
  });

  it("measureOnAttach=true: does not re-read the rect on a later rerender, and the observer keeps delivering afterward", () => {
    const rectSpy = vi
      .spyOn(Element.prototype, "getBoundingClientRect")
      .mockReturnValue(new DOMRect(0, 0, 0, 100));
    const { rerender } = render(
      <MeasuredHeightProbe mounted measureOnAttach visible />,
    );
    expect(rectSpy).toHaveBeenCalledTimes(1);

    act(() => {
      rerender(<MeasuredHeightProbe mounted measureOnAttach visible />);
    });
    // Falsification: an effect guarded only by `!element` (dropping the
    // WeakSet check) re-reads the rect on every rerender of the same node.
    expect(rectSpy).toHaveBeenCalledTimes(1);

    const target = screen.getByTestId("probe-target");
    act(() => {
      resizeObserverFor(target).emit(150);
    });
    // The observer path is untouched by the WeakSet guard - it keeps
    // delivering normally, and does not trigger a second `rect()` read.
    expect(screen.getByTestId("probe-height").textContent).toBe("150");
    expect(rectSpy).toHaveBeenCalledTimes(1);
  });

  it("measureOnAttach=true: skips the initial read while hidden, and reads exactly once on first reveal", () => {
    const rectSpy = vi
      .spyOn(Element.prototype, "getBoundingClientRect")
      .mockReturnValue(new DOMRect(0, 0, 0, 140));
    const { rerender } = render(
      <MeasuredHeightProbe mounted measureOnAttach visible={false} />,
    );
    expect(screen.getByTestId("probe-height").textContent).toBe("0");
    expect(rectSpy).not.toHaveBeenCalled();

    act(() => {
      rerender(<MeasuredHeightProbe mounted measureOnAttach visible />);
    });
    // Falsification: an effect that ignores `visible` would have already
    // read on the hidden mount above.
    expect(rectSpy).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("probe-height").textContent).toBe("140");

    // Hiding and revealing again must not read a second time - the node is
    // already in the WeakSet once measured.
    act(() => {
      rerender(<MeasuredHeightProbe mounted measureOnAttach visible={false} />);
    });
    act(() => {
      rerender(<MeasuredHeightProbe mounted measureOnAttach visible />);
    });
    expect(rectSpy).toHaveBeenCalledTimes(1);
  });

  it("measureOnAttach=true: reads again for a newly attached node after remount", () => {
    const rectSpy = vi
      .spyOn(Element.prototype, "getBoundingClientRect")
      .mockReturnValue(new DOMRect(0, 0, 0, 80));
    const { rerender } = render(
      <MeasuredHeightProbe mounted measureOnAttach visible />,
    );
    expect(screen.getByTestId("probe-height").textContent).toBe("80");
    expect(rectSpy).toHaveBeenCalledTimes(1);

    act(() => {
      rerender(<MeasuredHeightProbe mounted={false} measureOnAttach visible />);
    });
    rectSpy.mockReturnValue(new DOMRect(0, 0, 0, 210));
    act(() => {
      rerender(<MeasuredHeightProbe mounted measureOnAttach visible />);
    });
    // Falsification: a WeakSet that is never scoped to the actual DOM node
    // (e.g. a module-level flag) would skip this second, distinct node and
    // leave probe-height at "80".
    expect(screen.getByTestId("probe-height").textContent).toBe("210");
    expect(rectSpy).toHaveBeenCalledTimes(2);
  });

  it("measureOnAttach=true: reads the rect only once under StrictMode's double effect invocation", () => {
    const rectSpy = vi
      .spyOn(Element.prototype, "getBoundingClientRect")
      .mockReturnValue(new DOMRect(0, 0, 0, 64));
    render(
      <StrictMode>
        <MeasuredHeightProbe mounted measureOnAttach visible />
      </StrictMode>,
    );
    // Falsification: clearing the WeakSet entry in a layout-effect cleanup
    // (there is none in production, but a regressed hook that added one)
    // would let StrictMode's synchronous mount->cleanup->remount replay
    // this read a second time.
    expect(rectSpy).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("probe-height").textContent).toBe("64");
  });
});
