import { describe, expect, it } from "vitest";
import {
  ghostSlotKey,
  ghostsForClose,
  measureStripGeometry,
  type StripExitGhost,
  type StripGeometry,
} from "@/components/layout/tabs/strip-exit-ghosts";

type SlotSpan = readonly [key: string, span: number];

/** Lays the slots out end to end, so each one's span is the number given. */
function stripOf(spans: ReadonlyArray<SlotSpan>): StripGeometry {
  let start = 0;
  const slots = spans.map(([key, span]) => {
    const slot = { key, start };
    start += span;
    return slot;
  });
  return { slots, end: start, scrollLeft: 0 };
}

function sequentialKeys(): () => string {
  let count = 0;
  return () => {
    count += 1;
    return `ghost-${count}`;
  };
}

function closeGhosts(input: {
  readonly before: ReadonlyArray<SlotSpan>;
  readonly after: ReadonlyArray<SlotSpan>;
  readonly current: ReadonlyArray<StripExitGhost>;
}): ReadonlyArray<StripExitGhost> {
  return ghostsForClose({
    before: stripOf(input.before),
    after: stripOf(input.after),
    current: input.current,
    nextKey: sequentialKeys(),
  });
}

describe("ghostSlotKey", () => {
  it("names a spacer's slot apart from any member's", () => {
    expect(ghostSlotKey("strip-exit-ghost-1")).toBe("ghost:strip-exit-ghost-1");
  });
});

describe("ghostsForClose", () => {
  it("holds a closed item's width right before the next surviving slot", () => {
    const ghosts = closeGhosts({
      before: [
        ["item:a", 100],
        ["item:b", 120],
        ["item:c", 100],
      ],
      after: [
        ["item:a", 100],
        ["item:c", 100],
      ],
      current: [],
    });

    expect(ghosts).toEqual([
      { key: "ghost-1", beforeAnchor: "item:c", width: 120 },
    ]);
  });

  it("holds a run of closed items as one ghost as wide as all of them", () => {
    const ghosts = closeGhosts({
      before: [
        ["item:a", 100],
        ["item:b", 90],
        ["item:c", 110],
        ["item:d", 100],
      ],
      after: [
        ["item:a", 100],
        ["item:d", 100],
      ],
      current: [],
    });

    expect(ghosts).toEqual([
      { key: "ghost-1", beforeAnchor: "item:d", width: 200 },
    ]);
  });

  it("holds each separate closed run as its own ghost", () => {
    const ghosts = closeGhosts({
      before: [
        ["item:a", 100],
        ["item:b", 80],
        ["item:c", 100],
        ["item:d", 70],
        ["item:e", 100],
      ],
      after: [
        ["item:a", 100],
        ["item:c", 100],
        ["item:e", 100],
      ],
      current: [],
    });

    expect(ghosts).toEqual([
      { key: "ghost-1", beforeAnchor: "item:c", width: 80 },
      { key: "ghost-2", beforeAnchor: "item:e", width: 70 },
    ]);
  });

  it("holds a closed last item with a trailing ghost", () => {
    const ghosts = closeGhosts({
      before: [
        ["item:a", 100],
        ["item:b", 100],
      ],
      after: [["item:a", 100]],
      current: [],
    });

    expect(ghosts).toEqual([
      { key: "ghost-1", beforeAnchor: null, width: 100 },
    ]);
  });

  it("holds a whole closed group, chip included, before the next survivor", () => {
    const ghosts = closeGhosts({
      before: [
        ["item:a", 100],
        ["chip:group-1", 64],
        ["item:member-1", 100],
        ["item:member-2", 100],
        ["item:z", 100],
      ],
      after: [
        ["item:a", 100],
        ["item:z", 100],
      ],
      current: [],
    });

    expect(ghosts).toEqual([
      { key: "ghost-1", beforeAnchor: "item:z", width: 264 },
    ]);
  });

  it("sits before the next member, not the chip, when a surviving group loses its first member", () => {
    const ghosts = closeGhosts({
      before: [
        ["item:a", 100],
        ["chip:group-1", 64],
        ["item:member-1", 110],
        ["item:member-2", 100],
        ["item:z", 100],
      ],
      after: [
        ["item:a", 100],
        ["chip:group-1", 64],
        ["item:member-2", 100],
        ["item:z", 100],
      ],
      current: [],
    });

    expect(ghosts).toEqual([
      { key: "ghost-1", beforeAnchor: "item:member-2", width: 110 },
    ]);
  });

  it("ignores a tab that opened, since it closed no slot", () => {
    const ghosts = closeGhosts({
      before: [
        ["item:a", 100],
        ["item:b", 100],
      ],
      after: [
        ["item:a", 100],
        ["item:opened", 100],
        ["item:b", 100],
      ],
      current: [],
    });

    expect(ghosts).toEqual([]);
  });

  it("holds only the difference when closing one side of a split leaves a lone tab in its place", () => {
    const ghosts = closeGhosts({
      before: [
        ["item:a", 100],
        ["item:split", 400],
        ["item:c", 100],
      ],
      after: [
        ["item:a", 100],
        ["item:b-new", 200],
        ["item:c", 100],
      ],
      current: [],
    });

    expect(ghosts).toEqual([
      { key: "ghost-1", beforeAnchor: "item:c", width: 200 },
    ]);
  });

  it("holds nothing when what took a closed slot's place is wider than it", () => {
    const ghosts = closeGhosts({
      before: [
        ["item:a", 100],
        ["item:split", 400],
        ["item:c", 100],
      ],
      after: [
        ["item:a", 100],
        ["item:b-new", 500],
        ["item:c", 100],
      ],
      current: [],
    });

    expect(ghosts).toEqual([]);
  });

  it("takes a new tab after the last survivor off the trailing ghost", () => {
    const ghosts = closeGhosts({
      before: [
        ["item:a", 100],
        ["item:b", 100],
        ["item:c", 100],
      ],
      after: [
        ["item:a", 100],
        ["item:new", 60],
      ],
      current: [],
    });

    expect(ghosts).toEqual([
      { key: "ghost-1", beforeAnchor: null, width: 140 },
    ]);
  });

  it("takes a new tab off only the stretch it opened in", () => {
    const ghosts = closeGhosts({
      before: [
        ["item:a", 100],
        ["item:b", 100],
        ["item:c", 100],
        ["item:d", 100],
      ],
      after: [
        ["item:a", 100],
        ["item:c", 100],
        ["item:new", 50],
        ["item:d", 100],
      ],
      current: [],
    });

    expect(ghosts).toEqual([
      { key: "ghost-1", beforeAnchor: "item:c", width: 100 },
    ]);
  });

  it("ignores a closed run of half a pixel or less", () => {
    const ghosts = closeGhosts({
      before: [
        ["item:a", 100],
        ["item:b", 0.5],
        ["item:c", 100],
      ],
      after: [
        ["item:a", 100],
        ["item:c", 100],
      ],
      current: [],
    });

    expect(ghosts).toEqual([]);
  });

  it("holds a closed run over half a pixel", () => {
    const ghosts = closeGhosts({
      before: [
        ["item:a", 100],
        ["item:b", 0.75],
        ["item:c", 100],
      ],
      after: [
        ["item:a", 100],
        ["item:c", 100],
      ],
      current: [],
    });

    expect(ghosts).toEqual([
      { key: "ghost-1", beforeAnchor: "item:c", width: 0.75 },
    ]);
  });

  describe("with a spacer still closing", () => {
    const closing: StripExitGhost = {
      key: "closing",
      beforeAnchor: "item:c",
      width: 80,
    };

    it("keeps a spacer no close touched exactly as it was", () => {
      const ghosts = closeGhosts({
        before: [
          ["item:a", 100],
          [ghostSlotKey("closing"), 40],
          ["item:c", 100],
        ],
        after: [
          ["item:a", 100],
          [ghostSlotKey("closing"), 35],
          ["item:c", 100],
        ],
        current: [closing],
      });

      expect(ghosts).toEqual([closing]);
    });

    it("merges a new gap right before it into one ghost, sized by the spacer's current span", () => {
      const ghosts = closeGhosts({
        before: [
          ["item:a", 100],
          ["item:b", 100],
          [ghostSlotKey("closing"), 40],
          ["item:c", 100],
        ],
        // The spacer has shrunk to 30px by the time the strip is measured again.
        after: [
          ["item:a", 100],
          [ghostSlotKey("closing"), 30],
          ["item:c", 100],
        ],
        current: [closing],
      });

      expect(ghosts).toEqual([
        { key: "ghost-1", beforeAnchor: "item:c", width: 130 },
      ]);
    });

    it("merges a newly closed last item into a spacer already trailing the strip", () => {
      const trailing: StripExitGhost = {
        key: "trailing",
        beforeAnchor: null,
        width: 90,
      };
      const ghosts = closeGhosts({
        before: [
          ["item:a", 100],
          ["item:b", 100],
          [ghostSlotKey("trailing"), 50],
        ],
        after: [
          ["item:a", 100],
          [ghostSlotKey("trailing"), 45],
        ],
        current: [trailing],
      });

      expect(ghosts).toEqual([
        { key: "ghost-1", beforeAnchor: null, width: 145 },
      ]);
    });

    it("drops a spacer that is no longer rendered and folds its remaining width into the new gap", () => {
      // The spacer sat before `item:b`, which has now closed, so it is gone
      // from the strip too.
      const beforeClosed: StripExitGhost = {
        key: "closing",
        beforeAnchor: "item:b",
        width: 80,
      };
      const ghosts = closeGhosts({
        before: [
          ["item:a", 100],
          [ghostSlotKey("closing"), 40],
          ["item:b", 100],
          ["item:c", 100],
        ],
        after: [
          ["item:a", 100],
          ["item:c", 100],
        ],
        current: [beforeClosed],
      });

      expect(ghosts).toEqual([
        { key: "ghost-1", beforeAnchor: "item:c", width: 140 },
      ]);
    });
  });
});

describe("measureStripGeometry", () => {
  function rect(left: number, right: number): DOMRect {
    return {
      x: left,
      y: 0,
      width: right - left,
      height: 32,
      top: 0,
      right,
      bottom: 32,
      left,
      toJSON: () => ({}),
    };
  }

  function child(input: {
    readonly dataset: Readonly<Record<string, string>>;
    readonly box: DOMRect;
    readonly marginLeft: string;
    readonly marginRight: string;
  }): HTMLElement {
    const element = document.createElement("div");
    Object.assign(element.dataset, input.dataset);
    element.style.marginLeft = input.marginLeft;
    element.style.marginRight = input.marginRight;
    element.getBoundingClientRect = () => input.box;
    return element;
  }

  function scrollerOf(
    children: ReadonlyArray<HTMLElement>,
    scrollLeft: number,
  ): HTMLElement {
    const scroller = document.createElement("div");
    scroller.getBoundingClientRect = () => rect(10, 410);
    Object.defineProperty(scroller, "scrollLeft", { value: scrollLeft });
    scroller.append(...children);
    return scroller;
  }

  it("measures each slot's margin box in content coordinates", () => {
    // The scroller's content starts at 10 - 30 = -20 on screen.
    const scroller = scrollerOf(
      [
        child({
          dataset: { stripItemId: "a" },
          box: rect(5, 105),
          marginLeft: "0px",
          marginRight: "0px",
        }),
        child({
          dataset: { stripGroupChip: "group-1" },
          box: rect(113, 173),
          marginLeft: "8px",
          marginRight: "6px",
        }),
      ],
      30,
    );

    expect(measureStripGeometry(scroller)).toEqual({
      // The chip's margin box starts at 125, exactly where the first tab ends.
      slots: [
        { key: "item:a", start: 25 },
        { key: "chip:group-1", start: 125 },
      ],
      end: 199,
      scrollLeft: 30,
    });
  });

  it("names a closing spacer's slot and skips children outside the flow", () => {
    const scroller = scrollerOf(
      [
        child({
          dataset: { stripItemId: "a" },
          box: rect(10, 110),
          marginLeft: "0px",
          marginRight: "0px",
        }),
        child({
          dataset: { stripExitGhost: "closing" },
          box: rect(110, 150),
          marginLeft: "0px",
          marginRight: "0px",
        }),
        // The absolute selection traveller carries none of the strip's data.
        child({
          dataset: {},
          box: rect(10, 900),
          marginLeft: "0px",
          marginRight: "0px",
        }),
      ],
      0,
    );

    expect(measureStripGeometry(scroller)).toEqual({
      slots: [
        { key: "item:a", start: 0 },
        { key: ghostSlotKey("closing"), start: 100 },
      ],
      end: 140,
      scrollLeft: 0,
    });
  });
});
