/**
 * Regression cover for the drop-commit rendered-position discontinuity.
 *
 * WHAT THE FIRST VERSION OF THIS FILE GOT WRONG. It rendered ONE item, in ONE
 * direction, and asserted that its rendered position was continuous. It passed
 * against a build where the re-base reached only a single element per commit -
 * because the element it sampled was the one being reached. A five-run
 * both-direction probe then found a visible tab departing 134.11px, three times
 * out of three, in the other direction.
 *
 * That is this project's recurring defect arriving in a TEST rather than an
 * instrument: a check whose outcome is identical across the distinction it
 * exists to make. "Rendered position is continuous for the item I looked at"
 * cannot separate "every moved item was corrected" from "one was, and I sampled
 * it".
 *
 * So the assertions here are over the WHOLE strip: every item whose baseline
 * moved must be re-based, and every item's composite rendered position must be
 * preserved - in both directions, with unequal widths, including the hidden
 * dragged tab. Opacity and direction are never inputs to the rule, so they are
 * never inputs to the test either.
 *
 * The numbers a per-frame probe recorded against the defective build:
 *
 *   pre-fix          360.52px and 351.50px departure
 *   partial fix, A   134.11px x3   (re-base landed on the hidden dragged tab)
 *   partial fix, B     0.33px      (re-base landed on the visible neighbour)
 */
import { useLayoutEffect, useRef } from "react";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import {
  armHeaderStripCommitHandoff,
  disarmHeaderStripCommitHandoff,
  handoffTransformFor,
  runHeaderStripCommitHandoff,
  type HeaderStripHandoffReport,
} from "../header-strip-commit-handoff";
import { HEADER_STRIP_SCROLL_TEST_ID } from "../header-strip-geometry";
import { useHeaderTabDisplacement } from "../use-header-tab-displacement";

/**
 * Unequal widths on purpose: a fixture of equal tabs cannot tell a correct
 * per-element delta from one element's delta applied to every element.
 */
const WIDTHS: Record<string, number> = { a: 180.8, b: 400.4, c: 180.8 };

/** Slot of each item, keyed by id. jsdom performs no layout, so this IS layout. */
let slots: Record<string, number> = {};
let report: HeaderStripHandoffReport = {
  rebased: [],
  moved: [],
  uncorrected: [],
};

function slotsForOrder(order: readonly string[]): Record<string, number> {
  const next: Record<string, number> = {};
  let left = 0;
  for (const id of order) {
    next[id] = left;
    left += WIDTHS[id] ?? 0;
  }
  return next;
}

let originalOffsetLeft: PropertyDescriptor | undefined;

beforeAll(() => {
  originalOffsetLeft = Object.getOwnPropertyDescriptor(
    HTMLElement.prototype,
    "offsetLeft",
  );
  // Per-element, keyed by the item's own id - a single shared value would make
  // every item report the same slot and hide exactly the bug under test.
  Object.defineProperty(HTMLElement.prototype, "offsetLeft", {
    configurable: true,
    get(this: HTMLElement) {
      const id = this.getAttribute("data-strip-item-id");
      return id === null ? 0 : (slots[id] ?? 0);
    },
  });
});

afterAll(() => {
  if (originalOffsetLeft === undefined) {
    Reflect.deleteProperty(HTMLElement.prototype, "offsetLeft");
    return;
  }
  Object.defineProperty(
    HTMLElement.prototype,
    "offsetLeft",
    originalOffsetLeft,
  );
});

interface ItemState {
  readonly id: string;
  readonly offsetX: number;
  /** Carried only to prove it is NOT an input to the correction. */
  readonly opacity: number;
  /**
   * `false` renders a strip item that never registers - the shape
   * `SplitTabItem` had, which made the widest item in the strip exempt from
   * every commit while reading as present.
   */
  readonly registered: boolean;
  /**
   * Swapping this replaces the item's DOM node while KEEPING the component
   * instance - the only way to reproduce same-instance node churn. Changing the
   * React key instead remounts, which builds a fresh registry entry and so
   * cannot exercise a stale one.
   */
  readonly tag: "div" | "span";
}

const values = new Map<string, () => number>();

function StripItem(props: { readonly item: ItemState }) {
  const frameRef = useRef<HTMLElement | null>(null);
  const x = useHeaderTabDisplacement({
    nodeRef: frameRef,
    offsetX: props.item.offsetX,
    transition: { duration: 0 },
  });
  values.set(props.item.id, () => x.get());
  // A callback ref, because the two element types have different ref types and
  // the point of the swap is that the instance outlives either.
  const setNode = (node: HTMLElement | null) => {
    frameRef.current = node;
  };
  if (props.item.tag === "span") {
    return (
      <span
        ref={setNode}
        data-strip-item-id={props.item.id}
        style={{ opacity: props.item.opacity }}
      />
    );
  }
  return (
    <div
      ref={setNode}
      data-strip-item-id={props.item.id}
      style={{ opacity: props.item.opacity }}
    />
  );
}

/** A strip item that renders its own frame and never registers. */
function UnregisteredStripItem(props: { readonly item: ItemState }) {
  return (
    <div
      data-strip-item-id={props.item.id}
      style={{ opacity: props.item.opacity }}
    />
  );
}

/** Mirrors the strip container: the re-base runs on the parent boundary. */
function Strip(props: {
  readonly items: readonly ItemState[];
  readonly nodeEpoch: number;
}) {
  useLayoutEffect(() => {
    report = runHeaderStripCommitHandoff();
  });
  return (
    // The pass walks the DOM scoped to the strip container, so the harness has
    // to be that container - which is also what lets an UNREGISTERED item be
    // seen at all.
    <div data-testid={HEADER_STRIP_SCROLL_TEST_ID}>
      {props.items.map((item) =>
        item.registered ? (
          <StripItem key={`${item.id}:${props.nodeEpoch}`} item={item} />
        ) : (
          <UnregisteredStripItem
            key={`${item.id}:${props.nodeEpoch}`}
            item={item}
          />
        ),
      )}
    </div>
  );
}

function renderedLeft(id: string): number {
  const read = values.get(id);
  return (slots[id] ?? 0) + (read === undefined ? Number.NaN : read());
}

afterEach(() => {
  cleanup();
  disarmHeaderStripCommitHandoff();
  values.clear();
  report = { rebased: [], moved: [], uncorrected: [] };
});

/**
 * Drive a commit from `order` to `nextOrder`.
 *
 * Pre-commit each item is displaced so it ALREADY renders at its final slot -
 * the settled state the probe captured. A correct commit therefore moves
 * nothing at all, which is a sharper assertion than "moves a little".
 */
function driveCommit(input: {
  readonly order: readonly string[];
  readonly nextOrder: readonly string[];
  readonly hiddenId: string;
  readonly unregisteredIds: readonly string[];
}): {
  readonly before: Record<string, number>;
  readonly after: Record<string, number>;
} {
  const startSlots = slotsForOrder(input.order);
  const endSlots = slotsForOrder(input.nextOrder);
  slots = startSlots;

  const displaced = input.order.map((id) => ({
    id,
    // Where it must end up, expressed against where it currently sits.
    offsetX: (endSlots[id] ?? 0) - (startSlots[id] ?? 0),
    opacity: id === input.hiddenId ? 0 : 1,
    registered: !input.unregisteredIds.includes(id),
    tag: "div" as const,
  }));

  const view = render(<Strip items={displaced} nodeEpoch={0} />);
  const before: Record<string, number> = {};
  for (const id of input.order) before[id] = renderedLeft(id);

  // The commit: DOM order changes and the drag model's offsets drop to zero on
  // the same pass, which is the whole difficulty.
  act(() => {
    armHeaderStripCommitHandoff();
    slots = endSlots;
    view.rerender(
      <Strip
        nodeEpoch={0}
        items={input.nextOrder.map((id) => ({
          id,
          offsetX: 0,
          opacity: id === input.hiddenId ? 0 : 1,
          registered: !input.unregisteredIds.includes(id),
          tag: "div" as const,
        }))}
      />,
    );
  });

  const after: Record<string, number> = {};
  for (const id of input.nextOrder) after[id] = renderedLeft(id);
  return { before, after };
}

describe("header strip commit handoff", () => {
  it("direction A - every moved item keeps its rendered position", () => {
    // The direction the partial fix failed 3/3. `a` is the dragged tab and is
    // hidden; the re-base used to land on it and leave the visible tabs stale.
    const { before, after } = driveCommit({
      order: ["a", "b", "c"],
      nextOrder: ["b", "c", "a"],
      hiddenId: "a",
      unregisteredIds: [],
    });
    for (const id of ["a", "b", "c"]) {
      expect(after[id], `${id} rendered position moved at commit`).toBeCloseTo(
        before[id] ?? Number.NaN,
        2,
      );
    }
    // Every slot moved in this reorder, so every item must have been corrected.
    expect([...report.rebased].sort()).toEqual(["a", "b", "c"]);
  });

  it("direction B - every moved item keeps its rendered position", () => {
    const { before, after } = driveCommit({
      order: ["a", "b", "c"],
      nextOrder: ["c", "a", "b"],
      hiddenId: "c",
      unregisteredIds: [],
    });
    for (const id of ["a", "b", "c"]) {
      expect(after[id], `${id} rendered position moved at commit`).toBeCloseTo(
        before[id] ?? Number.NaN,
        2,
      );
    }
    expect([...report.rebased].sort()).toEqual(["a", "b", "c"]);
  });

  it("corrects the hidden dragged tab on the same terms as a visible one", () => {
    // Opacity is not an input to the rule. A correction that skipped hidden
    // items would leave the dragged tab stale the moment it became visible.
    driveCommit({
      order: ["a", "b", "c"],
      nextOrder: ["b", "c", "a"],
      hiddenId: "a",
      unregisteredIds: [],
    });
    expect(report.rebased).toContain("a");
  });

  it("re-bases only the slots that actually moved", () => {
    // Swapping the leading pair leaves `c` where it was: it must NOT be
    // re-based, and it must not move. An over-broad correction shows up here.
    const { before, after } = driveCommit({
      order: ["a", "b", "c"],
      nextOrder: ["b", "a", "c"],
      hiddenId: "a",
      unregisteredIds: [],
    });
    for (const id of ["a", "b", "c"]) {
      expect(after[id]).toBeCloseTo(before[id] ?? Number.NaN, 2);
    }
    expect([...report.rebased].sort()).toEqual(["a", "b"]);
    expect(report.rebased).not.toContain("c");
  });

  it("leaves a cancel untouched, because its baseline does not move", () => {
    // Cancel restores geometry: no slot moves, so there is nothing to re-base
    // and the spring-back is untouched. Preserved by arithmetic, not a branch.
    const { before, after } = driveCommit({
      order: ["a", "b", "c"],
      nextOrder: ["a", "b", "c"],
      hiddenId: "a",
      unregisteredIds: [],
    });
    for (const id of ["a", "b", "c"]) {
      expect(after[id]).toBeCloseTo(before[id] ?? Number.NaN, 2);
    }
    expect(report.rebased).toEqual([]);
  });

  it("does not re-base when the handoff is not armed", () => {
    // A baseline can move for reasons that are not a drop - a tab closes, the
    // window resizes. Those keep their existing behaviour.
    slots = slotsForOrder(["a", "b", "c"]);
    const view = render(
      <Strip
        nodeEpoch={0}
        items={[
          { id: "a", offsetX: 0, opacity: 1, registered: true, tag: "div" },
          { id: "b", offsetX: 0, opacity: 1, registered: true, tag: "div" },
          { id: "c", offsetX: 0, opacity: 1, registered: true, tag: "div" },
        ]}
      />,
    );
    act(() => {
      slots = slotsForOrder(["c", "b", "a"]);
      view.rerender(
        <Strip
          nodeEpoch={0}
          items={[
            { id: "c", offsetX: 0, opacity: 1, registered: true, tag: "div" },
            { id: "b", offsetX: 0, opacity: 1, registered: true, tag: "div" },
            { id: "a", offsetX: 0, opacity: 1, registered: true, tag: "div" },
          ]}
        />,
      );
    });
    expect(report.rebased).toEqual([]);
  });

  it("reports a strip item that is on screen but never registers", () => {
    // The split-group class of bug, reproduced. `b` is the widest item and
    // renders its own frame without registering, so it CANNOT be re-based. The
    // requirement is not that it be corrected - it is that it never passes
    // unnoticed, because silence is what let this ship.
    const { before, after } = driveCommit({
      order: ["a", "b", "c"],
      nextOrder: ["b", "c", "a"],
      hiddenId: "a",
      unregisteredIds: ["b"],
    });
    expect(report.uncorrected).toContain("b");
    expect(report.rebased).not.toContain("b");
    // The registered items are still corrected - one exempt item must not take
    // the rest of the strip down with it.
    for (const id of ["a", "c"]) {
      expect(after[id]).toBeCloseTo(before[id] ?? Number.NaN, 2);
    }
  });

  it("keeps correcting an item whose DOM node is replaced in place", () => {
    // Registry identity has to survive node churn WITHOUT a remount. Keyed by
    // the node captured at mount, a replaced element leaves a detached key
    // whose `offsetLeft` reads 0 forever - the item stays registered and is
    // exempt from every later commit. Swapping the element TYPE replaces the
    // node while keeping the component instance, which a key change cannot do.
    const mk = (
      order: readonly string[],
      offsets: Record<string, number>,
      tag: "div" | "span",
    ) =>
      order.map((id) => ({
        id,
        offsetX: offsets[id] ?? 0,
        opacity: 1,
        registered: true,
        tag,
      }));
    const start = slotsForOrder(["a", "b", "c"]);
    const endSlots = slotsForOrder(["b", "c", "a"]);
    slots = start;

    const view = render(
      <Strip items={mk(["a", "b", "c"], {}, "div")} nodeEpoch={0} />,
    );
    // Same instances, brand-new elements.
    act(() => {
      view.rerender(
        <Strip items={mk(["a", "b", "c"], {}, "span")} nodeEpoch={0} />,
      );
    });
    // Displace to the settled pre-commit state.
    const offsets: Record<string, number> = {};
    for (const id of ["a", "b", "c"]) {
      offsets[id] = (endSlots[id] ?? 0) - (start[id] ?? 0);
    }
    act(() => {
      view.rerender(
        <Strip items={mk(["a", "b", "c"], offsets, "span")} nodeEpoch={0} />,
      );
    });
    const before: Record<string, number> = {};
    for (const id of ["a", "b", "c"]) before[id] = renderedLeft(id);

    act(() => {
      armHeaderStripCommitHandoff();
      slots = endSlots;
      view.rerender(
        <Strip items={mk(["b", "c", "a"], {}, "span")} nodeEpoch={0} />,
      );
    });

    expect(report.uncorrected).toEqual([]);
    expect([...report.rebased].sort()).toEqual(["a", "b", "c"]);
    for (const id of ["a", "b", "c"]) {
      expect(renderedLeft(id)).toBeCloseTo(before[id] ?? Number.NaN, 2);
    }
  });

  it("reproduces the observed defect from the probe's own numbers", () => {
    // The model, stated as arithmetic against the pre-fix trace: slot 613.75
    // with transform -400.45 renders at 213.30, and the stale transform -351.50
    // against the new slot 213.30 renders at -138.20.
    expect(613.75 + -400.45).toBeCloseTo(213.3, 2);
    expect(213.3 + -351.5).toBeCloseTo(-138.2, 2);
    // And the correction that makes it continuous is zero, not merely small.
    expect(
      handoffTransformFor({
        previousBaselineLeft: 613.75,
        nextBaselineLeft: 213.3,
        appliedTransformX: -400.45,
      }),
    ).toBeCloseTo(0, 2);
  });

  it("handoffTransformFor preserves rendered position for any baseline move", () => {
    const cases = [
      { previous: 613.75, next: 213.3, applied: -400.45 },
      { previous: 100, next: 460.52, applied: 360.52 },
      { previous: 0, next: 0, applied: -12.5 },
      { previous: 880.5, next: 120.25, applied: 0 },
    ] as const;
    for (const c of cases) {
      const carried = handoffTransformFor({
        previousBaselineLeft: c.previous,
        nextBaselineLeft: c.next,
        appliedTransformX: c.applied,
      });
      expect(c.next + carried).toBeCloseTo(c.previous + c.applied, 6);
    }
  });
});
