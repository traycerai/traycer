/**
 * `ReadingsLine` measures via `getBoundingClientRect`, which jsdom always
 * reports as an all-zero rect - every reading trivially "fits" inside a
 * zero-sized line under jsdom's real geometry, so the fallback path (a first
 * reading wider than the line) is only reachable by stubbing the rects the
 * component reads.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { ReadingsLine } from "@/components/layout/readings-line";

const PROBE_CHILD_TESTID = "readings-probe-child";

function rectFrom(
  left: number,
  top: number,
  right: number,
  bottom: number,
): DOMRect {
  return {
    left,
    top,
    right,
    bottom,
    width: right - left,
    height: bottom - top,
    x: left,
    y: top,
    toJSON() {
      return this;
    },
  };
}

const LINE_RECT = rectFrom(0, 0, 100, 16);

// Every element gets the line's own rect except the one reading child this
// suite probes with, which the test itself sizes to fit or overflow that
// line - so the line's own measurement never has to be identified by
// structure, only the one node under test.
function stubProbeChildRect(childRect: DOMRect): void {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
    function (this: HTMLElement) {
      return this.getAttribute("data-testid") === PROBE_CHILD_TESTID
        ? childRect
        : LINE_RECT;
    },
  );
}

function renderLine() {
  return render(
    <ReadingsLine
      align="start"
      tone="default"
      lead={null}
      fallback={<span data-testid="fallback-content">Fallback</span>}
    >
      <span data-testid={PROBE_CHILD_TESTID}>Reading</span>
    </ReadingsLine>,
  );
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("<ReadingsLine />", () => {
  it("shows the fallback and hides the line when the first reading is wider than the line", () => {
    stubProbeChildRect(rectFrom(0, 0, 500, 16));
    renderLine();

    expect(screen.getByTestId("fallback-content")).toBeTruthy();
    const line = screen.getByTestId(PROBE_CHILD_TESTID).parentElement;
    expect(line?.className).toContain("invisible");
  });

  it("hides the fallback and shows the line when the reading fits", () => {
    stubProbeChildRect(rectFrom(0, 0, 100, 16));
    renderLine();

    expect(screen.queryByTestId("fallback-content")).toBeNull();
    const line = screen.getByTestId(PROBE_CHILD_TESTID).parentElement;
    expect(line?.className).not.toContain("invisible");
  });
});
