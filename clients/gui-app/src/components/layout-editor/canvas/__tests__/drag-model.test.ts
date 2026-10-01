import { describe, expect, it } from "vitest";
import {
  clampBoundsOf,
  dragAxisOf,
  dragShiftOf,
  dragSlotsOf,
  dragStarted,
  PointerVelocity,
  restingOffsetOf,
  rubberBanded,
  siblingOffsetOf,
  targetSlotOf,
  type DragRect,
  type DragSlot,
} from "@/components/layout-editor/canvas/drag-model";

/** Three 20px rows, 4px apart: tops 0, 24, 48. */
const ROWS: ReadonlyArray<DragRect> = [
  { left: 0, top: 0, width: 200, height: 20 },
  { left: 0, top: 24, width: 200, height: 20 },
  { left: 0, top: 48, width: 200, height: 20 },
];

/** A small chip beside a wide one, 4px apart: lefts 0 and 14. */
const UNEVEN_ROW: ReadonlyArray<DragRect> = [
  { left: 0, top: 0, width: 10, height: 20 },
  { left: 14, top: 0, width: 40, height: 20 },
];

/**
 * The composer toolbar as the real-Chrome driver measured it (L-143):
 * `attachImage` 28px wide at x 242.5, `access` 120px wide at x 274.5, the
 * cluster ending at 394.5. These are the numbers the leftward drag was
 * impossible on.
 */
const TOOLBAR: ReadonlyArray<DragRect> = [
  { left: 242.5, top: 0, width: 28, height: 28 },
  { left: 274.5, top: 0, width: 120, height: 28 },
];
const TOOLBAR_CLUSTER = { start: 242.5, end: 394.5 } as const;

/** The same shape stacked: a tall dock row above a short one, 4px apart. */
const UNEVEN_STACK: ReadonlyArray<DragRect> = [
  { left: 0, top: 0, width: 200, height: 120 },
  { left: 0, top: 124, width: 200, height: 28 },
];
const STACK_CLUSTER = { start: 0, end: 152 } as const;

/**
 * The sidebar rail on its real numbers: 36px icons 4px apart with an 8px group
 * break among them (L-140). Chats, Artifacts, the break, Terminals.
 *
 * It is the one shape where a member is a fraction of its neighbours' size,
 * which is what makes it the shape the claim floor is about.
 */
const RAIL: ReadonlyArray<DragRect> = [
  { left: 0, top: 0, width: 36, height: 36 },
  { left: 0, top: 40, width: 36, height: 36 },
  { left: 0, top: 80, width: 36, height: 8 },
  { left: 0, top: 92, width: 36, height: 36 },
];

const rowSlots = dragSlotsOf(ROWS, "y");
const railSlots = dragSlotsOf(RAIL, "y");

describe("arming", () => {
  it("waits for the six pixels that tell a drag from a click", () => {
    expect(dragStarted(3, 2)).toBe(false);
    expect(dragStarted(0, 6)).toBe(true);
    // Manhattan, so a diagonal sweep arms as readily as an axis-aligned one.
    expect(dragStarted(-4, 3)).toBe(true);
  });
});

describe("the axis, measured rather than declared", () => {
  it("reads a stack as vertical and a strip as horizontal", () => {
    expect(dragAxisOf(ROWS)).toBe("y");
    expect(dragAxisOf(UNEVEN_ROW)).toBe("x");
  });

  it("falls back to vertical with nothing to compare", () => {
    expect(dragAxisOf([ROWS[0]])).toBe("y");
  });
});

/**
 * The claim rule (L-143), as a table over the shapes the product actually
 * draws: both axes, both directions, and every size relation between the
 * dragged member and the one it is passing.
 *
 * Each row states the boundary from both sides - the last offset that has NOT
 * claimed and the first that has - because a rule is only pinned by the pair.
 */
interface SlotCase {
  readonly name: string;
  readonly slots: ReadonlyArray<DragSlot>;
  readonly index: number;
  readonly offset: number;
  readonly claims: number;
}

const rowSlotsX = dragSlotsOf(UNEVEN_ROW, "x");
const toolbarSlots = dragSlotsOf(TOOLBAR, "x");
const stackSlots = dragSlotsOf(UNEVEN_STACK, "y");

const SLOT_CASES: ReadonlyArray<SlotCase> = [
  // Equal sizes, vertical. The pitch is 24 and the neighbour's centre is half
  // a box further on, so the claim lands at 14 rather than at the whole 24 the
  // centre rule asked for: the same gesture, arriving sooner.
  { name: "y equal, at rest", slots: rowSlots, index: 0, offset: 0, claims: 0 },
  {
    name: "y equal, down, short",
    slots: rowSlots,
    index: 0,
    offset: 13,
    claims: 0,
  },
  {
    name: "y equal, down, past",
    slots: rowSlots,
    index: 0,
    offset: 16,
    claims: 1,
  },
  {
    name: "y equal, down, two on",
    slots: rowSlots,
    index: 0,
    offset: 60,
    claims: 2,
  },
  {
    name: "y equal, up, short",
    slots: rowSlots,
    index: 2,
    offset: -12,
    claims: 2,
  },
  {
    name: "y equal, up, past",
    slots: rowSlots,
    index: 2,
    offset: -16,
    claims: 1,
  },
  {
    name: "y equal, up, one back",
    slots: rowSlots,
    index: 2,
    offset: -25,
    claims: 1,
  },
  {
    name: "y equal, up, two back",
    slots: rowSlots,
    index: 2,
    offset: -40,
    claims: 0,
  },
  {
    name: "y equal, middle at rest",
    slots: rowSlots,
    index: 1,
    offset: 0,
    claims: 1,
  },

  // Narrow dragged past wide, horizontal, towards the end: the 10px chip's END
  // edge has to reach the 40px chip's centre at 34.
  {
    name: "x narrow-vs-wide, short",
    slots: rowSlotsX,
    index: 0,
    offset: 23,
    claims: 0,
  },
  {
    name: "x narrow-vs-wide, past",
    slots: rowSlotsX,
    index: 0,
    offset: 25,
    claims: 1,
  },

  // Wide dragged past narrow, horizontal, towards the start: the 40px chip's
  // START edge has to reach the 10px chip's centre at 5. Its own centre never
  // could - that is the bug.
  //
  // This is the one pair in the table the 12px floor separates rather than the
  // half-overlap rule: a 10px neighbour 4px away is claimed at 9px of travel,
  // which is inside the floor (L-150(4)). The far side still fails under the
  // superseded centre rule, which is what the pair is here for.
  {
    name: "x wide-vs-narrow, short",
    slots: rowSlotsX,
    index: 1,
    offset: -11,
    claims: 1,
  },
  {
    name: "x wide-vs-narrow, past",
    slots: rowSlotsX,
    index: 1,
    offset: -13,
    claims: 0,
  },

  // The measured toolbar, leftwards: `access` claims `attachImage`'s slot from
  // -18 on, and the clamp lets it reach -32.
  {
    name: "toolbar access left, short",
    slots: toolbarSlots,
    index: 1,
    offset: -17,
    claims: 1,
  },
  {
    name: "toolbar access left, past",
    slots: toolbarSlots,
    index: 1,
    offset: -19,
    claims: 0,
  },

  // The same shape stacked and travelling the other way: a 120px dock row
  // dropped past the 28px one below it.
  {
    name: "y tall-vs-short, short",
    slots: stackSlots,
    index: 0,
    offset: 17,
    claims: 0,
  },
  {
    name: "y tall-vs-short, past",
    slots: stackSlots,
    index: 0,
    offset: 19,
    claims: 1,
  },
  {
    name: "y short-vs-tall, short",
    slots: stackSlots,
    index: 1,
    offset: -63,
    claims: 1,
  },
  {
    name: "y short-vs-tall, past",
    slots: stackSlots,
    index: 1,
    offset: -65,
    claims: 0,
  },

  // The sidebar rail on its real numbers, which is the shape the floor exists
  // for and the one size relation the rest of this table does not carry: an
  // 8px divider between two 36px icons is claimed at 8px of travel by the
  // half-overlap rule alone, so a click that slips would regroup a panel
  // (L-150(4)). The floor puts it at 12, and the panel BEYOND the break is
  // still where the rule puts it, at 34.
  {
    name: "rail break, wobble",
    slots: railSlots,
    index: 1,
    offset: 11,
    claims: 1,
  },
  {
    name: "rail break, claimed",
    slots: railSlots,
    index: 1,
    offset: 12,
    claims: 2,
  },
  {
    name: "rail next panel, short",
    slots: railSlots,
    index: 1,
    offset: 34,
    claims: 2,
  },
  {
    name: "rail next panel, past",
    slots: railSlots,
    index: 1,
    offset: 35,
    claims: 3,
  },
  // And upward, so the floor is measured in both directions on this shape too:
  // Terminals' own start edge reaches the break's centre at -8.
  {
    name: "rail break upward, wobble",
    slots: railSlots,
    index: 3,
    offset: -11,
    claims: 3,
  },
  {
    name: "rail break upward, claimed",
    slots: railSlots,
    index: 3,
    offset: -12,
    claims: 2,
  },
];

describe("which slot the dragged member claims", () => {
  it.each(SLOT_CASES)("$name", (slotCase) => {
    expect(targetSlotOf(slotCase.slots, slotCase.index, slotCase.offset)).toBe(
      slotCase.claims,
    );
  });

  /**
   * The case the centre rule could not perform at all (L-143): a member wider
   * than the one standing first in its cluster, pulled to the cluster's own
   * leading edge. The clamp is the whole budget the pointer has, so if the
   * claim is not inside it the move does not exist - which is what the driver
   * measured on the real composer.
   */
  it("lets a wide member claim the leading slot from inside its own clamp", () => {
    const bounds = clampBoundsOf(
      toolbarSlots[1],
      TOOLBAR_CLUSTER.start,
      TOOLBAR_CLUSTER.end,
    );

    expect(bounds.min).toBe(-32);
    expect(targetSlotOf(toolbarSlots, 1, bounds.min)).toBe(0);
    // And the drop is exactly the clamp's own edge, so the release spring has
    // somewhere to land rather than resting on a rubber band.
    expect(restingOffsetOf(toolbarSlots, 1, 0)).toBe(bounds.min);
  });

  it("lets a tall row claim the trailing slot from inside its own clamp", () => {
    const bounds = clampBoundsOf(
      stackSlots[0],
      STACK_CLUSTER.start,
      STACK_CLUSTER.end,
    );

    expect(bounds.max).toBe(32);
    expect(targetSlotOf(stackSlots, 0, bounds.max)).toBe(1);
    expect(restingOffsetOf(stackSlots, 0, 1)).toBe(bounds.max);
  });

  /**
   * No flicker under a stationary pointer.
   *
   * The claim reads the RESTING slots and the offset and nothing else, so it
   * is a pure function of where the pointer is: the live reflow a claim starts
   * moves the siblings' transforms, never these numbers, and a sweep across
   * the cluster therefore walks the slots in one direction and never doubles
   * back. Monotonicity is the property that says so, and it is asserted on the
   * uneven pair, where the two boundaries are furthest apart.
   */
  it("walks the slots monotonically as the pointer sweeps", () => {
    const claims: number[] = [];
    for (let offset = -14; offset <= 40; offset += 1)
      claims.push(targetSlotOf(rowSlotsX, 1, offset));

    expect(claims[0]).toBe(0);
    expect(claims.at(-1)).toBe(1);
    for (const [step, claim] of claims.entries())
      if (step > 0) expect(claim).toBeGreaterThanOrEqual(claims[step - 1]);
    // Re-asking at the same offset answers the same slot, whatever was claimed
    // in between: there is no state to settle.
    expect(targetSlotOf(rowSlotsX, 1, -14)).toBe(0);
  });
});

describe("the reflow the siblings run", () => {
  it("moves every member between the two slots, and nobody else", () => {
    const shift = dragShiftOf(rowSlots, 0);

    // The first row claiming the second: only the second steps up.
    expect(siblingOffsetOf(0, 1, 1, shift)).toBe(-24);
    expect(siblingOffsetOf(0, 1, 2, shift)).toBe(0);
    // Claiming the third: both step up.
    expect(siblingOffsetOf(0, 2, 1, shift)).toBe(-24);
    expect(siblingOffsetOf(0, 2, 2, shift)).toBe(-24);
    // The dragged member is driven by the pointer, never by this.
    expect(siblingOffsetOf(0, 2, 0, shift)).toBe(0);
  });

  it("steps aside by the dragged member's own footprint, gap included", () => {
    const slots = dragSlotsOf(UNEVEN_ROW, "x");

    // The narrow chip frees 10px of box plus the 4px gap behind it.
    expect(dragShiftOf(slots, 0)).toBe(14);
    // The wide one frees its own 40.
    expect(dragShiftOf(slots, 1)).toBe(44);
  });
});

describe("where a release lands", () => {
  it("puts the member flush in the slot it claimed", () => {
    expect(restingOffsetOf(rowSlots, 0, 1)).toBe(24);
    expect(restingOffsetOf(rowSlots, 0, 2)).toBe(48);
    expect(restingOffsetOf(rowSlots, 2, 0)).toBe(-48);
    expect(restingOffsetOf(rowSlots, 1, 1)).toBe(0);
  });

  it("lands on a neighbour of a different size by its far edge", () => {
    const slots = dragSlotsOf(UNEVEN_ROW, "x");

    // The 10px chip ends flush against the 40px one's right edge, which is
    // 44 away - not the 14 a uniform step would have given it.
    expect(restingOffsetOf(slots, 0, 1)).toBe(44);
    expect(restingOffsetOf(slots, 1, 0)).toBe(-14);
  });
});

describe("the rubber band on a pinned member", () => {
  it("passes a pull inside the clamp through untouched", () => {
    expect(rubberBanded(12, -10, 30)).toBe(12);
    expect(rubberBanded(-10, -10, 30)).toBe(-10);
  });

  it("gives a quarter of the way past either edge", () => {
    expect(rubberBanded(-50, -10, 30)).toBe(-20);
    expect(rubberBanded(70, -10, 30)).toBe(40);
  });

  it("measures the clamp from the member's own two edges", () => {
    // A 40px member at 100, inside a container spanning 80..300.
    expect(clampBoundsOf({ start: 100, size: 40 }, 80, 300)).toEqual({
      min: -20,
      max: 160,
    });
  });
});

describe("the velocity handed to the release", () => {
  it("is zero before the pointer has moved", () => {
    const velocity = new PointerVelocity();
    velocity.sample(40, 0);

    expect(velocity.perSecond()).toBe(0);
  });

  it("reports pixels per second, signed with the direction", () => {
    const velocity = new PointerVelocity();
    velocity.sample(0, 0);
    velocity.sample(-100, 100);

    expect(velocity.perSecond()).toBe(-1000);
  });

  it("still hands over the speed of a sweep that ended on a slow frame", () => {
    const velocity = new PointerVelocity();
    // 2px per millisecond for 96ms, then one nearly still frame.
    for (let at = 0; at <= 96; at += 16) velocity.sample(at * 2, at);
    velocity.sample(193, 112);

    // The last pair alone would read about 60px/s; the window sees the sweep.
    expect(velocity.perSecond()).toBeGreaterThan(1000);
  });

  it("forgets a sweep the pointer has since sat still through", () => {
    const velocity = new PointerVelocity();
    velocity.sample(0, 0);
    velocity.sample(400, 100);
    velocity.sample(400, 300);
    velocity.sample(400, 500);

    expect(velocity.perSecond()).toBe(0);
  });
});
