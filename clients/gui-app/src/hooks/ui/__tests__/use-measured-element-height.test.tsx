import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { useMeasuredElementHeight } from "@/hooks/ui/use-measured-element-height";

/**
 * Ticket 18 rider (review finding: the chat-tile ResizeObserver->prop
 * contract was previously pinned only via a hand-copied structural twin,
 * which could not fail for a real production lifecycle defect). This is the
 * SAME hook `chat-tile.tsx` consumes - not a duplicate re-implementation.
 */
function MeasuredHeightProbe(props: { readonly mounted: boolean }): ReactNode {
  const { setElement, element, height } = useMeasuredElementHeight();
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

function stubHeight(heightPx: number): () => void {
  const spy = vi
    .spyOn(Element.prototype, "getBoundingClientRect")
    .mockImplementation(function (this: Element) {
      const targeted = this.getAttribute("data-testid") === "probe-target";
      return {
        x: 0,
        y: 0,
        width: 0,
        height: targeted ? heightPx : 0,
        top: 0,
        left: 0,
        right: 0,
        bottom: targeted ? heightPx : 0,
        toJSON: () => ({}),
      };
    });
  return () => spy.mockRestore();
}

describe("useMeasuredElementHeight", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("reports 'unmounted' (via the null element) before the ref attaches", () => {
    render(<MeasuredHeightProbe mounted={false} />);
    expect(screen.getByTestId("probe-height").textContent).toBe("unmounted");
  });

  it("measures and rounds up the attached element's height", () => {
    const restore = stubHeight(119.4);
    render(<MeasuredHeightProbe mounted />);
    expect(screen.getByTestId("probe-height").textContent).toBe("120");
    restore();
  });

  it("ignores a non-positive reading and keeps the last known height", () => {
    const restore = stubHeight(150);
    const { rerender } = render(<MeasuredHeightProbe mounted />);
    expect(screen.getByTestId("probe-height").textContent).toBe("150");
    restore();

    // `height` state is independent of element identity - it survives the
    // target unmounting. jsdom's ResizeObserver does not fire on a bare
    // `getBoundingClientRect` change, so toggle the target off and back on
    // (SAME hook instance, not a fresh render) to force the layout effect's
    // initial measurement to re-run against the now-zero stub - the real
    // regression this guards is `nextHeight <= 0` collapsing reserved
    // layout space to zero instead of keeping the prior value.
    const restoreZero = stubHeight(0);
    act(() => {
      rerender(<MeasuredHeightProbe mounted={false} />);
    });
    act(() => {
      rerender(<MeasuredHeightProbe mounted />);
    });
    expect(screen.getByTestId("probe-height").textContent).toBe("150");
    restoreZero();
  });

  it("re-measures after the element unmounts and a new one attaches", () => {
    const restore = stubHeight(80);
    const { rerender } = render(<MeasuredHeightProbe mounted />);
    expect(screen.getByTestId("probe-height").textContent).toBe("80");

    act(() => {
      rerender(<MeasuredHeightProbe mounted={false} />);
    });
    restore();

    const restoreNext = stubHeight(210);
    act(() => {
      rerender(<MeasuredHeightProbe mounted />);
    });
    expect(screen.getByTestId("probe-height").textContent).toBe("210");
    restoreNext();
  });
});
