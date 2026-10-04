import { describe, expect, it } from "vitest";
import {
  HORIZONTAL_STRIP_AXIS,
  VERTICAL_STRIP_AXIS,
  contentDirectionOf,
  pulledOutOfStrip,
  revealMemberAlongAxis,
  stripAxisOf,
  type StripAxis,
} from "@/components/epic-canvas/dnd/strip-axis";

const RECT = { left: 10, top: 20, width: 100, height: 40 };
const POINT = { x: 7, y: 11 };

function element(offsetLeft: number, offsetTop: number): HTMLElement {
  const el = document.createElement("div");
  Object.defineProperty(el, "offsetLeft", { value: offsetLeft });
  Object.defineProperty(el, "offsetTop", { value: offsetTop });
  return el;
}

function boxed(box: {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}): HTMLElement {
  const el = document.createElement("div");
  el.getBoundingClientRect = () => ({
    ...box,
    x: box.left,
    y: box.top,
    right: box.left + box.width,
    bottom: box.top + box.height,
    toJSON: () => ({}),
  });
  return el;
}

describe("strip axes", () => {
  it("maps every accessor onto x for the horizontal axis", () => {
    const axis = HORIZONTAL_STRIP_AXIS;
    expect(axis.id).toBe("x");
    expect(axis.mainStart(RECT)).toBe(10);
    expect(axis.mainEnd(RECT)).toBe(110);
    expect(axis.mainExtent(RECT)).toBe(100);
    expect(axis.crossStart(RECT)).toBe(20);
    expect(axis.crossEnd(RECT)).toBe(60);
    expect(axis.pointerMain(POINT)).toBe(7);
    expect(axis.pointerCross(POINT)).toBe(11);
    expect(axis.layoutOffset(element(3, 5))).toBe(3);
    const scroller = document.createElement("div");
    scroller.scrollLeft = 4;
    scroller.scrollTop = 9;
    expect(axis.scrollOffset(scroller)).toBe(4);
    axis.scrollBy(scroller, 6);
    expect(scroller.scrollLeft).toBe(10);
    expect(scroller.scrollTop).toBe(9);
  });

  it("maps every accessor onto y for the vertical axis", () => {
    const axis = VERTICAL_STRIP_AXIS;
    expect(axis.id).toBe("y");
    expect(axis.mainStart(RECT)).toBe(20);
    expect(axis.mainEnd(RECT)).toBe(60);
    expect(axis.mainExtent(RECT)).toBe(40);
    expect(axis.crossStart(RECT)).toBe(10);
    expect(axis.crossEnd(RECT)).toBe(110);
    expect(axis.pointerMain(POINT)).toBe(11);
    expect(axis.pointerCross(POINT)).toBe(7);
    expect(axis.layoutOffset(element(3, 5))).toBe(5);
    const scroller = document.createElement("div");
    scroller.scrollLeft = 4;
    scroller.scrollTop = 9;
    expect(axis.scrollOffset(scroller)).toBe(9);
    axis.scrollBy(scroller, -6);
    expect(scroller.scrollTop).toBe(3);
    expect(scroller.scrollLeft).toBe(4);
  });

  it("resolves an axis by id", () => {
    expect(stripAxisOf("x")).toBe(HORIZONTAL_STRIP_AXIS);
    expect(stripAxisOf("y")).toBe(VERTICAL_STRIP_AXIS);
  });

  it("puts the content after a top or left strip and before a right strip", () => {
    expect(contentDirectionOf("top")).toBe(1);
    expect(contentDirectionOf("left")).toBe(1);
    expect(contentDirectionOf("right")).toBe(-1);
  });
});

describe("revealMemberAlongAxis", () => {
  const cases: ReadonlyArray<{
    readonly axis: StripAxis;
    readonly view: { left: number; top: number; width: number; height: number };
    readonly place: (
      start: number,
      extent: number,
    ) => { left: number; top: number; width: number; height: number };
    readonly offset: (scroller: HTMLElement) => number;
  }> = [
    {
      axis: HORIZONTAL_STRIP_AXIS,
      view: { left: 100, top: 0, width: 200, height: 36 },
      place: (start, extent) => ({
        left: start,
        top: 0,
        width: extent,
        height: 36,
      }),
      offset: (scroller) => scroller.scrollLeft,
    },
    {
      axis: VERTICAL_STRIP_AXIS,
      view: { left: 0, top: 100, width: 240, height: 200 },
      place: (start, extent) => ({
        left: 0,
        top: start,
        width: 240,
        height: extent,
      }),
      offset: (scroller) => scroller.scrollTop,
    },
  ];

  for (const { axis, view, place, offset } of cases) {
    describe(`on the ${axis.id} axis`, () => {
      it("scrolls a member clipped at the end forward by the overflow", () => {
        const scroller = boxed(view);
        revealMemberAlongAxis(scroller, boxed(place(250, 80)), axis, 0);
        expect(offset(scroller)).toBe(30);
      });

      it("scrolls a member clipped at the start back by the overflow", () => {
        const scroller = boxed(view);
        if (axis.id === "x") scroller.scrollLeft = 50;
        else scroller.scrollTop = 50;
        revealMemberAlongAxis(scroller, boxed(place(80, 60)), axis, 0);
        expect(offset(scroller)).toBe(30);
      });

      it("reveals the end edge first when the member overflows both edges", () => {
        const scroller = boxed(view);
        revealMemberAlongAxis(scroller, boxed(place(90, 240)), axis, 0);
        expect(offset(scroller)).toBe(30);
      });

      it("leaves a fully visible member alone", () => {
        const scroller = boxed(view);
        revealMemberAlongAxis(scroller, boxed(place(120, 60)), axis, 0);
        expect(offset(scroller)).toBe(0);
      });

      // Something covers 30 at the start and 20 at the end of the scrollport.
      const padded = (): HTMLElement => {
        const scroller = boxed(view);
        for (const [side, px] of [
          ["left", 30],
          ["top", 30],
          ["right", 20],
          ["bottom", 20],
        ] as const) {
          scroller.style.setProperty(`scroll-padding-${side}`, `${px}px`);
        }
        return scroller;
      };

      it("keeps a member clipped at the end clear of the scroll-padding", () => {
        const scroller = padded();
        revealMemberAlongAxis(scroller, boxed(place(250, 80)), axis, 0);
        expect(offset(scroller)).toBe(50);
      });

      it("keeps a member clipped at the start clear of the scroll-padding", () => {
        const scroller = padded();
        if (axis.id === "x") scroller.scrollLeft = 50;
        else scroller.scrollTop = 50;
        revealMemberAlongAxis(scroller, boxed(place(110, 60)), axis, 0);
        expect(offset(scroller)).toBe(30);
      });
    });
  }
});

describe("pulledOutOfStrip", () => {
  const THRESHOLD = 24;

  it("tears off below a top strip only past the threshold", () => {
    const base = {
      bandStart: 0,
      bandEnd: 40,
      contentDirection: 1,
      axis: HORIZONTAL_STRIP_AXIS,
      thresholdPx: THRESHOLD,
    } as const;
    expect(pulledOutOfStrip({ ...base, point: { x: 300, y: 65 } })).toBe(true);
    expect(pulledOutOfStrip({ ...base, point: { x: 300, y: 64 } })).toBe(false);
    expect(pulledOutOfStrip({ ...base, point: { x: 300, y: 20 } })).toBe(false);
    expect(pulledOutOfStrip({ ...base, point: { x: 300, y: -100 } })).toBe(
      false,
    );
  });

  it("tears off to the right of a left strip only past the threshold", () => {
    const base = {
      bandStart: 0,
      bandEnd: 240,
      contentDirection: 1,
      axis: VERTICAL_STRIP_AXIS,
      thresholdPx: THRESHOLD,
    } as const;
    expect(pulledOutOfStrip({ ...base, point: { x: 265, y: 300 } })).toBe(true);
    expect(pulledOutOfStrip({ ...base, point: { x: 264, y: 300 } })).toBe(
      false,
    );
    expect(pulledOutOfStrip({ ...base, point: { x: 120, y: 300 } })).toBe(
      false,
    );
  });

  it("tears off to the left of a right strip only past the threshold", () => {
    const base = {
      bandStart: 760,
      bandEnd: 1000,
      contentDirection: -1,
      axis: VERTICAL_STRIP_AXIS,
      thresholdPx: THRESHOLD,
    } as const;
    expect(pulledOutOfStrip({ ...base, point: { x: 735, y: 300 } })).toBe(true);
    expect(pulledOutOfStrip({ ...base, point: { x: 736, y: 300 } })).toBe(
      false,
    );
    expect(pulledOutOfStrip({ ...base, point: { x: 900, y: 300 } })).toBe(
      false,
    );
    // The far side of a right strip is between it and the window edge.
    expect(pulledOutOfStrip({ ...base, point: { x: 1100, y: 300 } })).toBe(
      false,
    );
  });

  it("never tears off without a point", () => {
    expect(
      pulledOutOfStrip({
        point: null,
        bandStart: 0,
        bandEnd: 40,
        contentDirection: 1,
        axis: HORIZONTAL_STRIP_AXIS,
        thresholdPx: THRESHOLD,
      }),
    ).toBe(false);
  });
});
