import { describe, expect, it } from "vitest";
import {
  collectFeedRowMetrics,
  computeScrollAnchorCorrectionPx,
  findFirstVisibleAnchor,
} from "@/hooks/notifications/use-notification-center-scroll-anchor";

function makeRect(input: {
  readonly top: number;
  readonly height: number;
  readonly left: number;
}): DOMRect {
  return {
    x: input.left,
    y: input.top,
    width: 320,
    height: input.height,
    top: input.top,
    left: input.left,
    right: input.left + 320,
    bottom: input.top + input.height,
    toJSON: () => ({}),
  };
}

function makeRow(feedId: string, top: number, height: number): HTMLElement {
  const row = document.createElement("div");
  row.setAttribute("data-notification-id", feedId);
  row.getBoundingClientRect = () => makeRect({ top, height, left: 0 });
  return row;
}

function makeScrollEl(
  rows: ReadonlyArray<{
    readonly feedId: string;
    readonly top: number;
    readonly height: number;
  }>,
  scrollTop: number,
): HTMLDivElement {
  const scrollEl = document.createElement("div");
  scrollEl.scrollTop = scrollTop;
  scrollEl.getBoundingClientRect = () =>
    makeRect({ top: 0, height: 400, left: 0 });
  for (const row of rows) {
    scrollEl.appendChild(makeRow(row.feedId, row.top, row.height));
  }
  return scrollEl;
}

describe("collectFeedRowMetrics", () => {
  it("reads every data-notification-id row relative to the scrollport once", () => {
    const scrollEl = makeScrollEl(
      [
        { feedId: "host:a", top: -20, height: 40 },
        { feedId: "host:b", top: 20, height: 40 },
        { feedId: "global:c", top: 60, height: 40 },
      ],
      40,
    );

    const metrics = collectFeedRowMetrics(scrollEl);

    expect([...metrics.keys()]).toEqual(["host:a", "host:b", "global:c"]);
    expect(metrics.get("host:a")).toEqual({ offsetTopPx: -20, heightPx: 40 });
    expect(metrics.get("host:b")).toEqual({ offsetTopPx: 20, heightPx: 40 });
    expect(metrics.get("global:c")).toEqual({ offsetTopPx: 60, heightPx: 40 });
  });

  it("skips descendants that lack a data-notification-id attribute", () => {
    const scrollEl = document.createElement("div");
    scrollEl.getBoundingClientRect = () =>
      makeRect({ top: 0, height: 400, left: 0 });
    const missing = document.createElement("div");
    missing.getBoundingClientRect = () =>
      makeRect({ top: 30, height: 20, left: 0 });
    scrollEl.appendChild(missing);
    scrollEl.appendChild(makeRow("host:kept", 50, 20));

    const metrics = collectFeedRowMetrics(scrollEl);
    expect([...metrics.keys()]).toEqual(["host:kept"]);
  });
});

describe("findFirstVisibleAnchor", () => {
  it("returns the first ordered row that is at least partially below the top edge", () => {
    const metrics = new Map([
      ["host:above", { offsetTopPx: -40, heightPx: 30 }],
      ["host:straddling", { offsetTopPx: -10, heightPx: 40 }],
      ["host:below", { offsetTopPx: 30, heightPx: 40 }],
    ]);

    expect(
      findFirstVisibleAnchor(
        ["host:above", "host:straddling", "host:below"],
        metrics,
      ),
    ).toEqual({ feedId: "host:straddling", offsetTopPx: -10 });
  });

  it("skips rows missing from metrics and returns null when nothing is visible", () => {
    const metrics = new Map([
      ["host:above", { offsetTopPx: -50, heightPx: 20 }],
    ]);
    expect(
      findFirstVisibleAnchor(["host:missing", "host:above"], metrics),
    ).toBeNull();
  });
});

describe("computeScrollAnchorCorrectionPx", () => {
  const ordered = ["host:a", "host:b", "host:c", "host:d"] as const;

  it("preserves the exact anchor row's offset across a prepend (positive delta)", () => {
    // Prepend pushed the anchored row from 40px → 100px; correction is +60.
    const correction = computeScrollAnchorCorrectionPx({
      previousAnchor: { feedId: "host:b", offsetTopPx: 40 },
      previousOrderedFeedIds: ordered,
      previousScrollTop: 40,
      currentScrollTop: 40,
      currentMetrics: new Map([
        ["host:new", { offsetTopPx: -20, heightPx: 60 }],
        ["host:a", { offsetTopPx: 40, heightPx: 40 }],
        ["host:b", { offsetTopPx: 100, heightPx: 40 }],
        ["host:c", { offsetTopPx: 140, heightPx: 40 }],
        ["host:d", { offsetTopPx: 180, heightPx: 40 }],
      ]),
    });
    expect(correction).toBe(60);
  });

  it("returns 0 when the anchor did not move (pagination appends below)", () => {
    const metrics = new Map([
      ["host:a", { offsetTopPx: -80, heightPx: 40 }],
      ["host:b", { offsetTopPx: 40, heightPx: 40 }],
      ["host:c", { offsetTopPx: 80, heightPx: 40 }],
      ["host:d", { offsetTopPx: 120, heightPx: 40 }],
      ["host:older", { offsetTopPx: 160, heightPx: 40 }],
    ]);
    expect(
      computeScrollAnchorCorrectionPx({
        previousAnchor: { feedId: "host:b", offsetTopPx: 40 },
        previousOrderedFeedIds: ordered,
        previousScrollTop: 40,
        currentScrollTop: 40,
        currentMetrics: metrics,
      }),
    ).toBe(0);
  });

  it("falls back to the nearest surviving successor when the anchor is removed", () => {
    // Anchor host:b gone; successor host:c is at 50. Prior offset was 40 → +10.
    const correction = computeScrollAnchorCorrectionPx({
      previousAnchor: { feedId: "host:b", offsetTopPx: 40 },
      previousOrderedFeedIds: ordered,
      previousScrollTop: 40,
      currentScrollTop: 40,
      currentMetrics: new Map([
        ["host:a", { offsetTopPx: -20, heightPx: 40 }],
        ["host:c", { offsetTopPx: 50, heightPx: 40 }],
        ["host:d", { offsetTopPx: 90, heightPx: 40 }],
      ]),
    });
    expect(correction).toBe(10);
  });

  it("falls back to the nearest surviving predecessor when no successor survives", () => {
    // Anchor host:d gone and no later rows; predecessor host:c is at 30.
    const correction = computeScrollAnchorCorrectionPx({
      previousAnchor: { feedId: "host:d", offsetTopPx: 70 },
      previousOrderedFeedIds: ordered,
      previousScrollTop: 70,
      currentScrollTop: 70,
      currentMetrics: new Map([
        ["host:a", { offsetTopPx: -50, heightPx: 40 }],
        ["host:c", { offsetTopPx: 30, heightPx: 40 }],
      ]),
    });
    expect(correction).toBe(-40);
  });

  it("returns null when nothing from the prior order survives", () => {
    expect(
      computeScrollAnchorCorrectionPx({
        previousAnchor: { feedId: "host:b", offsetTopPx: 40 },
        previousOrderedFeedIds: ordered,
        previousScrollTop: 40,
        currentScrollTop: 40,
        currentMetrics: new Map([
          ["host:totally-new", { offsetTopPx: 10, heightPx: 40 }],
        ]),
      }),
    ).toBeNull();
  });

  it("returns null when the previous anchor id was not in previousOrderedFeedIds", () => {
    expect(
      computeScrollAnchorCorrectionPx({
        previousAnchor: { feedId: "host:ghost", offsetTopPx: 40 },
        previousOrderedFeedIds: ordered,
        previousScrollTop: 40,
        currentScrollTop: 40,
        currentMetrics: new Map([["host:a", { offsetTopPx: 0, heightPx: 40 }]]),
      }),
    ).toBeNull();
  });

  it("keeps the visual offset stable across a lifecycle reorder of the same feedId", () => {
    // host:b moved from Recent mid-list into Attention top; DOM order
    // changes but the same feedId still has a measured position.
    const correction = computeScrollAnchorCorrectionPx({
      previousAnchor: { feedId: "host:b", offsetTopPx: 80 },
      previousOrderedFeedIds: ["host:a", "host:b", "host:c"],
      previousScrollTop: 80,
      currentScrollTop: 80,
      currentMetrics: new Map([
        ["host:b", { offsetTopPx: 20, heightPx: 40 }],
        ["host:a", { offsetTopPx: 60, heightPx: 40 }],
        ["host:c", { offsetTopPx: 100, heightPx: 40 }],
      ]),
    });
    // scrollTop += (20 - 80) = -60 restores the prior 80px visual offset.
    expect(correction).toBe(-60);
  });

  // Content shift is +50; user scroll of +300 must not be undone (pre-fix would yield -250).
  it("folds user scrollTop delta into the correction so mid-scroll is not undone", () => {
    const correction = computeScrollAnchorCorrectionPx({
      previousAnchor: { feedId: "host:b", offsetTopPx: 100 },
      previousOrderedFeedIds: ordered,
      previousScrollTop: 500,
      currentScrollTop: 800,
      currentMetrics: new Map([
        ["host:new", { offsetTopPx: -200, heightPx: 50 }],
        ["host:a", { offsetTopPx: -190, heightPx: 40 }],
        ["host:b", { offsetTopPx: -150, heightPx: 40 }],
        ["host:c", { offsetTopPx: -110, heightPx: 40 }],
        ["host:d", { offsetTopPx: -70, heightPx: 40 }],
      ]),
    });
    expect(correction).toBe(50);
  });
});
