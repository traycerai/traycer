import { afterEach, describe, expect, it, onTestFinished } from "vitest";
import {
  captureChatTimelineVisibleRows,
  clearChatTimelineVisibleRows,
  PANEL_RESIZE_VISIBLE_ROW_ATTRIBUTE,
} from "@/components/chat/chat-timeline-panel-resize-snapshot";
import {
  beginPanelResizeInteraction,
  registerPanelResizeParticipant,
} from "@/lib/layout/panel-resizing-class";

const PANEL_RESIZING_CLASS = "traycer-panel-resizing";

/** Pure DOM, no LegendList/React involved - deliberately sidesteps the
 *  shared `installLegendListViewportMetrics()` shim, which stubs every
 *  element's `getBoundingClientRect` to the SAME `(0, 0)`-origin rect (see
 *  `legend-list-test-environment.ts`), so it cannot distinguish visible from
 *  off-screen rows. Per-element rect overrides here give each row/scroller a
 *  distinct, real position instead. */
function rectOf(top: number, height: number): DOMRect {
  return {
    top,
    bottom: top + height,
    left: 0,
    right: 100,
    width: 100,
    height,
    x: 0,
    y: top,
    toJSON: () => ({}),
  };
}

function makeRow(id: string, top: number, height: number): HTMLElement {
  const row = document.createElement("div");
  row.setAttribute("data-message-id", id);
  row.getBoundingClientRect = () => rectOf(top, height);
  return row;
}

function makeScroller(viewportHeight: number): HTMLElement {
  const scroller = document.createElement("div");
  scroller.getBoundingClientRect = () => rectOf(0, viewportHeight);
  document.body.appendChild(scroller);
  return scroller;
}

afterEach(() => {
  document.body.replaceChildren();
});

describe("captureChatTimelineVisibleRows", () => {
  it("marks only rows whose rect intersects the scrollable node's viewport, boundary-inclusive", () => {
    const scroller = makeScroller(300); // viewport 0..300
    const above = makeRow("above", -150, 100); // -150..-50, fully above
    const straddleTop = makeRow("straddle-top", -50, 100); // -50..50, straddles top edge
    const visible = makeRow("visible", 100, 80); // 100..180, fully inside
    const straddleBottom = makeRow("straddle-bottom", 280, 100); // 280..380, straddles bottom edge
    const below = makeRow("below", 400, 100); // 400..500, fully below
    for (const row of [above, straddleTop, visible, straddleBottom, below]) {
      scroller.appendChild(row);
    }

    captureChatTimelineVisibleRows(scroller);

    expect(above.hasAttribute(PANEL_RESIZE_VISIBLE_ROW_ATTRIBUTE)).toBe(false);
    expect(straddleTop.hasAttribute(PANEL_RESIZE_VISIBLE_ROW_ATTRIBUTE)).toBe(
      true,
    );
    expect(visible.hasAttribute(PANEL_RESIZE_VISIBLE_ROW_ATTRIBUTE)).toBe(true);
    expect(
      straddleBottom.hasAttribute(PANEL_RESIZE_VISIBLE_ROW_ATTRIBUTE),
    ).toBe(true);
    expect(below.hasAttribute(PANEL_RESIZE_VISIBLE_ROW_ATTRIBUTE)).toBe(false);
  });

  it("only marks rows within the given scrollable node's own subtree", () => {
    const scrollerA = makeScroller(300);
    const scrollerB = makeScroller(300);
    const rowA = makeRow("a", 0, 100);
    const rowB = makeRow("b", 0, 100);
    scrollerA.appendChild(rowA);
    scrollerB.appendChild(rowB);

    captureChatTimelineVisibleRows(scrollerA);

    expect(rowA.hasAttribute(PANEL_RESIZE_VISIBLE_ROW_ATTRIBUTE)).toBe(true);
    expect(rowB.hasAttribute(PANEL_RESIZE_VISIBLE_ROW_ATTRIBUTE)).toBe(false);
  });

  it("is synchronous (no observer/subscription indirection to await)", () => {
    const scroller = makeScroller(300);
    const row = makeRow("sync", 0, 100);
    scroller.appendChild(row);

    captureChatTimelineVisibleRows(scroller);

    // No await/flush between the call above and this assertion - a real
    // subscription (ResizeObserver, rAF, timer) would not have fired yet.
    expect(row.hasAttribute(PANEL_RESIZE_VISIBLE_ROW_ATTRIBUTE)).toBe(true);
  });

  it("is self-healing: a stale marker on a row that has since scrolled offscreen is removed by the next capture, with no clear in between (review F1)", () => {
    const scroller = makeScroller(300); // viewport 0..300
    const row = makeRow("row", 0, 100); // starts visible
    scroller.appendChild(row);

    captureChatTimelineVisibleRows(scroller);
    expect(row.hasAttribute(PANEL_RESIZE_VISIBLE_ROW_ATTRIBUTE)).toBe(true);

    // Row scrolls below the viewport; nothing ever clears its marker.
    row.getBoundingClientRect = () => rectOf(1000, 100);

    captureChatTimelineVisibleRows(scroller);

    expect(row.hasAttribute(PANEL_RESIZE_VISIBLE_ROW_ATTRIBUTE)).toBe(false);
  });
});

describe("clearChatTimelineVisibleRows", () => {
  it("removes every marker set within the node's subtree, nothing more", () => {
    const scroller = makeScroller(300);
    const marked1 = makeRow("m1", 0, 100);
    const marked2 = makeRow("m2", 50, 100);
    scroller.appendChild(marked1);
    scroller.appendChild(marked2);
    captureChatTimelineVisibleRows(scroller);
    expect(marked1.hasAttribute(PANEL_RESIZE_VISIBLE_ROW_ATTRIBUTE)).toBe(true);
    expect(marked2.hasAttribute(PANEL_RESIZE_VISIBLE_ROW_ATTRIBUTE)).toBe(true);

    clearChatTimelineVisibleRows(scroller);

    expect(marked1.hasAttribute(PANEL_RESIZE_VISIBLE_ROW_ATTRIBUTE)).toBe(
      false,
    );
    expect(marked2.hasAttribute(PANEL_RESIZE_VISIBLE_ROW_ATTRIBUTE)).toBe(
      false,
    );
  });

  it("does not touch markers outside the given scrollable node", () => {
    const scrollerA = makeScroller(300);
    const scrollerB = makeScroller(300);
    const rowA = makeRow("a", 0, 100);
    const rowB = makeRow("b", 0, 100);
    scrollerA.appendChild(rowA);
    scrollerB.appendChild(rowB);
    captureChatTimelineVisibleRows(scrollerA);
    captureChatTimelineVisibleRows(scrollerB);

    clearChatTimelineVisibleRows(scrollerA);

    expect(rowA.hasAttribute(PANEL_RESIZE_VISIBLE_ROW_ATTRIBUTE)).toBe(false);
    expect(rowB.hasAttribute(PANEL_RESIZE_VISIBLE_ROW_ATTRIBUTE)).toBe(true);
  });
});

describe("end-to-end recovery through the real registry (review F1)", () => {
  afterEach(() => {
    document.documentElement.classList.remove(PANEL_RESIZING_CLASS);
  });

  it("a marker surviving a participant's thrown clear does not survive the NEXT capture", () => {
    const scroller = makeScroller(300); // viewport 0..300
    const row = makeRow("row", 0, 100); // starts visible
    scroller.appendChild(row);

    let clearCallCount = 0;
    const unregister = registerPanelResizeParticipant({
      capture: () => captureChatTimelineVisibleRows(scroller),
      clear: () => {
        clearCallCount += 1;
        if (clearCallCount === 1) {
          // Simulates the exact failure the registry is designed to
          // isolate - this drag's clear never actually runs.
          throw new Error("clear boom (simulated failure)");
        }
        clearChatTimelineVisibleRows(scroller);
      },
    });
    onTestFinished(unregister);

    // Drag 1: row visible -> marked. Its clear() throws; the registry
    // isolates the failure (class lifecycle still completes normally, per
    // the existing isolation pins) but the marker is never actually
    // cleared as a side effect.
    const stop1 = beginPanelResizeInteraction(1, () => undefined);
    expect(row.hasAttribute(PANEL_RESIZE_VISIBLE_ROW_ATTRIBUTE)).toBe(true);
    stop1();
    expect(row.hasAttribute(PANEL_RESIZE_VISIBLE_ROW_ATTRIBUTE)).toBe(true);

    // Row scrolls below the viewport before the next drag starts.
    row.getBoundingClientRect = () => rectOf(1000, 100);

    // Drag 2: recapture. The stale marker must not survive into this
    // drag's freeze - self-healing capture removes it even though nothing
    // ever successfully cleared it.
    const stop2 = beginPanelResizeInteraction(2, () => undefined);
    expect(row.hasAttribute(PANEL_RESIZE_VISIBLE_ROW_ATTRIBUTE)).toBe(false);
    stop2();
  });
});
