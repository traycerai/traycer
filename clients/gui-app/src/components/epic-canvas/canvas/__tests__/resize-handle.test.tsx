import "../../../../../__tests__/test-browser-apis";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { SplitResizeHandle } from "@/components/epic-canvas/canvas/resize-handle";
import { pointerEvent } from "./test-pointer-events";

const GROUP_ID = "group-1";
const CONTAINER_WIDTH = 1000;

function renderHandle(
  sizes: ReadonlyArray<number>,
  onCommitSizes: (groupId: string, sizes: ReadonlyArray<number>) => void,
) {
  render(
    <div data-testid="split-container" className="flex">
      <div
        data-split-child
        data-testid="child-left"
        style={{ flexGrow: sizes[0] }}
      />
      <SplitResizeHandle
        groupId={GROUP_ID}
        index={0}
        direction="horizontal"
        sizes={sizes}
        minChildPx={100}
        className={undefined}
        onCommitSizes={onCommitSizes}
      />
      <div
        data-split-child
        data-testid="child-right"
        style={{ flexGrow: sizes[1] }}
      />
    </div>,
  );
  vi.spyOn(
    screen.getByTestId("split-container"),
    "getBoundingClientRect",
  ).mockReturnValue(new DOMRect(0, 0, CONTAINER_WIDTH, 600));
  return {
    handle: screen.getByRole("slider", { name: "Resize pane" }),
    left: screen.getByTestId("child-left"),
    right: screen.getByTestId("child-right"),
  };
}

function renderTwoHandles(
  onCommitSizes: (groupId: string, sizes: ReadonlyArray<number>) => void,
) {
  render(
    <div>
      <div data-testid="split-container-a" className="flex">
        <div data-split-child style={{ flexGrow: 0.5 }} />
        <SplitResizeHandle
          groupId="group-a"
          index={0}
          direction="horizontal"
          sizes={[0.5, 0.5]}
          minChildPx={100}
          className={undefined}
          onCommitSizes={onCommitSizes}
        />
        <div data-split-child style={{ flexGrow: 0.5 }} />
      </div>
      <div data-testid="split-container-b" className="flex">
        <div data-split-child style={{ flexGrow: 0.5 }} />
        <SplitResizeHandle
          groupId="group-b"
          index={0}
          direction="horizontal"
          sizes={[0.5, 0.5]}
          minChildPx={100}
          className={undefined}
          onCommitSizes={onCommitSizes}
        />
        <div data-split-child style={{ flexGrow: 0.5 }} />
      </div>
    </div>,
  );
  vi.spyOn(
    screen.getByTestId("split-container-a"),
    "getBoundingClientRect",
  ).mockReturnValue(new DOMRect(0, 0, CONTAINER_WIDTH, 600));
  vi.spyOn(
    screen.getByTestId("split-container-b"),
    "getBoundingClientRect",
  ).mockReturnValue(new DOMRect(0, 0, CONTAINER_WIDTH, 600));
  const handles = screen.getAllByRole("slider", { name: "Resize pane" });
  expect(handles).toHaveLength(2);
  return { first: handles[0], second: handles[1] };
}

function flexGrowOf(element: HTMLElement): number {
  return Number.parseFloat(element.style.flexGrow);
}

describe("<SplitResizeHandle />", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("mutates the adjacent pair's flexGrow per frame and commits once on release", () => {
    const onCommitSizes =
      vi.fn<(groupId: string, sizes: ReadonlyArray<number>) => void>();
    const { handle, left, right } = renderHandle([0.5, 0.5], onCommitSizes);

    fireEvent(
      handle,
      pointerEvent("pointerdown", {
        pointerId: 5,
        clientX: 500,
        clientY: 10,
        button: 0,
      }),
    );
    fireEvent(
      handle,
      pointerEvent("pointermove", {
        pointerId: 5,
        clientX: 600,
        clientY: 10,
        button: 0,
      }),
    );

    // Per-frame DOM mutation, zero commits while the pointer moves.
    expect(flexGrowOf(left)).toBeCloseTo(0.6, 10);
    expect(flexGrowOf(right)).toBeCloseTo(0.4, 10);
    expect(onCommitSizes).not.toHaveBeenCalled();

    fireEvent(
      handle,
      pointerEvent("pointerup", {
        pointerId: 5,
        clientX: 600,
        clientY: 10,
        button: 0,
      }),
    );
    expect(onCommitSizes).toHaveBeenCalledTimes(1);
    const [groupId, committed] = onCommitSizes.mock.calls[0];
    expect(groupId).toBe(GROUP_ID);
    expect(committed[0]).toBeCloseTo(0.6, 10);
    expect(committed[1]).toBeCloseTo(0.4, 10);
  });

  it("restores instead of committing when the drag returns to the starting fractions", () => {
    const onCommitSizes =
      vi.fn<(groupId: string, sizes: ReadonlyArray<number>) => void>();
    const { handle, left, right } = renderHandle([0.5, 0.5], onCommitSizes);

    fireEvent(
      handle,
      pointerEvent("pointerdown", {
        pointerId: 5,
        clientX: 500,
        clientY: 10,
        button: 0,
      }),
    );
    fireEvent(
      handle,
      pointerEvent("pointermove", {
        pointerId: 5,
        clientX: 500,
        clientY: 10,
        button: 0,
      }),
    );
    fireEvent(
      handle,
      pointerEvent("pointerup", {
        pointerId: 5,
        clientX: 500,
        clientY: 10,
        button: 0,
      }),
    );

    expect(onCommitSizes).not.toHaveBeenCalled();
    expect(flexGrowOf(left)).toBeCloseTo(0.5, 10);
    expect(flexGrowOf(right)).toBeCloseTo(0.5, 10);
  });

  it("serializes concurrent pointer resizes so only one handle can commit", () => {
    const onCommitSizes =
      vi.fn<(groupId: string, sizes: ReadonlyArray<number>) => void>();
    const { first, second } = renderTwoHandles(onCommitSizes);

    fireEvent(
      first,
      pointerEvent("pointerdown", {
        pointerId: 5,
        clientX: 500,
        clientY: 10,
        button: 0,
      }),
    );
    fireEvent(
      second,
      pointerEvent("pointerdown", {
        pointerId: 9,
        clientX: 500,
        clientY: 10,
        button: 0,
      }),
    );
    fireEvent(
      second,
      pointerEvent("pointermove", {
        pointerId: 9,
        clientX: 650,
        clientY: 10,
        button: 0,
      }),
    );
    fireEvent(
      second,
      pointerEvent("pointerup", {
        pointerId: 9,
        clientX: 650,
        clientY: 10,
        button: 0,
      }),
    );

    expect(onCommitSizes).not.toHaveBeenCalled();

    fireEvent(
      first,
      pointerEvent("pointermove", {
        pointerId: 5,
        clientX: 600,
        clientY: 10,
        button: 0,
      }),
    );
    fireEvent(
      first,
      pointerEvent("pointerup", {
        pointerId: 5,
        clientX: 600,
        clientY: 10,
        button: 0,
      }),
    );

    expect(onCommitSizes).toHaveBeenCalledTimes(1);
    expect(onCommitSizes.mock.calls[0][0]).toBe("group-a");
  });

  it("clamps the drag at the px-floor-derived minimum fraction", () => {
    const onCommitSizes =
      vi.fn<(groupId: string, sizes: ReadonlyArray<number>) => void>();
    const { handle, left, right } = renderHandle([0.5, 0.5], onCommitSizes);

    fireEvent(
      handle,
      pointerEvent("pointerdown", {
        pointerId: 5,
        clientX: 500,
        clientY: 10,
        button: 0,
      }),
    );
    // minChildPx 100 over a 1000px container -> 0.1 fraction floor; a drag
    // far past the edge pins the pair at [0.9, 0.1] / [0.1, 0.9].
    fireEvent(
      handle,
      pointerEvent("pointermove", {
        pointerId: 5,
        clientX: 5000,
        clientY: 10,
        button: 0,
      }),
    );
    expect(flexGrowOf(left)).toBeCloseTo(0.9, 10);
    expect(flexGrowOf(right)).toBeCloseTo(0.1, 10);

    fireEvent(
      handle,
      pointerEvent("pointermove", {
        pointerId: 5,
        clientX: -5000,
        clientY: 10,
        button: 0,
      }),
    );
    expect(flexGrowOf(left)).toBeCloseTo(0.1, 10);
    expect(flexGrowOf(right)).toBeCloseTo(0.9, 10);
    fireEvent(
      handle,
      pointerEvent("pointercancel", {
        pointerId: 5,
        clientX: -5000,
        clientY: 10,
        button: 0,
      }),
    );
  });

  it("restores the committed fractions on pointer-cancel without committing", () => {
    const onCommitSizes =
      vi.fn<(groupId: string, sizes: ReadonlyArray<number>) => void>();
    const { handle, left, right } = renderHandle([0.5, 0.5], onCommitSizes);

    fireEvent(
      handle,
      pointerEvent("pointerdown", {
        pointerId: 5,
        clientX: 500,
        clientY: 10,
        button: 0,
      }),
    );
    fireEvent(
      handle,
      pointerEvent("pointermove", {
        pointerId: 5,
        clientX: 700,
        clientY: 10,
        button: 0,
      }),
    );
    expect(flexGrowOf(left)).toBeCloseTo(0.7, 10);

    fireEvent(
      handle,
      pointerEvent("pointercancel", {
        pointerId: 5,
        clientX: 700,
        clientY: 10,
        button: 0,
      }),
    );
    expect(flexGrowOf(left)).toBeCloseTo(0.5, 10);
    expect(flexGrowOf(right)).toBeCloseTo(0.5, 10);
    expect(onCommitSizes).not.toHaveBeenCalled();
  });

  it("ignores pointer events whose pointerId does not match the captured drag", () => {
    const onCommitSizes =
      vi.fn<(groupId: string, sizes: ReadonlyArray<number>) => void>();
    const { handle, left } = renderHandle([0.5, 0.5], onCommitSizes);

    fireEvent(
      handle,
      pointerEvent("pointerdown", {
        pointerId: 5,
        clientX: 500,
        clientY: 10,
        button: 0,
      }),
    );
    fireEvent(
      handle,
      pointerEvent("pointermove", {
        pointerId: 9,
        clientX: 900,
        clientY: 10,
        button: 0,
      }),
    );
    // Foreign pointer: no frame applied.
    expect(left.style.flexGrow).toBe("0.5");
    fireEvent(
      handle,
      pointerEvent("pointerup", {
        pointerId: 9,
        clientX: 900,
        clientY: 10,
        button: 0,
      }),
    );
    expect(onCommitSizes).not.toHaveBeenCalled();
  });

  it("commits an even split on double-click", () => {
    const onCommitSizes =
      vi.fn<(groupId: string, sizes: ReadonlyArray<number>) => void>();
    const { handle } = renderHandle([0.7, 0.3], onCommitSizes);

    fireEvent.doubleClick(handle);
    expect(onCommitSizes).toHaveBeenCalledWith(GROUP_ID, [0.5, 0.5]);
  });

  it("commits a 5% nudge per arrow-key press", () => {
    const onCommitSizes =
      vi.fn<(groupId: string, sizes: ReadonlyArray<number>) => void>();
    const { handle } = renderHandle([0.5, 0.5], onCommitSizes);

    fireEvent.keyDown(handle, { key: "ArrowRight" });
    expect(onCommitSizes).toHaveBeenCalledTimes(1);
    const [, grown] = onCommitSizes.mock.calls[0];
    expect(grown[0]).toBeCloseTo(0.55, 10);
    expect(grown[1]).toBeCloseTo(0.45, 10);

    fireEvent.keyDown(handle, { key: "ArrowLeft" });
    const [, shrunk] = onCommitSizes.mock.calls[1];
    expect(shrunk[0]).toBeCloseTo(0.45, 10);
    expect(shrunk[1]).toBeCloseTo(0.55, 10);

    // Cross-axis keys are ignored for a horizontal handle.
    fireEvent.keyDown(handle, { key: "ArrowUp" });
    fireEvent.keyDown(handle, { key: "ArrowDown" });
    expect(onCommitSizes).toHaveBeenCalledTimes(2);
  });

  it("exposes the slider ARIA contract", () => {
    const onCommitSizes =
      vi.fn<(groupId: string, sizes: ReadonlyArray<number>) => void>();
    const { handle } = renderHandle([0.7, 0.3], onCommitSizes);

    expect(handle.getAttribute("aria-orientation")).toBe("vertical");
    expect(handle.getAttribute("aria-valuenow")).toBe("70");
    expect(handle.getAttribute("aria-valuemin")).toBe("0");
    expect(handle.getAttribute("aria-valuemax")).toBe("100");
    expect(handle.tabIndex).toBe(0);
  });

  it("tags its group id on data-resize-group-id, never data-group-id", () => {
    const onCommitSizes =
      vi.fn<(groupId: string, sizes: ReadonlyArray<number>) => void>();
    const { handle } = renderHandle([0.5, 0.5], onCommitSizes);

    // The handle carries the split GROUP id, but NOT under `data-group-id` -
    // that attribute marks tab-group panes and is collected by the canvas
    // focus-navigation `readTileRects`. A handle on `data-group-id` would win
    // the spatial neighbour search and break cross-split focus navigation.
    expect(handle.getAttribute("data-resize-group-id")).toBe(GROUP_ID);
    expect(handle.hasAttribute("data-group-id")).toBe(false);
  });
});
