/**
 * The current task's row is held in the most urgent section it has been drawn
 * in since it became current, and released when another task is opened. These
 * are the openings that carry the hold and the ones that start it afresh: a
 * pair's swap and its other member's close carry it, its focused member's
 * close does not. Where a held row is drawn, and when it lets go on screen, is
 * `browser-tests/side-strip-section-motion.spec.ts`'s.
 */
import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  emptyTabStripLayout,
  removeLayoutRef,
  swapSplitSides,
  tabItemId,
  type SplitSideName,
  type SplitStripItem,
  type StripItem,
} from "@/stores/tabs/layout";
import type { TabRef } from "@/stores/tabs/types";
import {
  holdInPlace,
  useCurrentSectionHold,
  useReleasedSectionHolds,
  useStripPointerInside,
  type StripSectionHold,
} from "../strip-section-hold";
import {
  groupEntriesBySection,
  type StripSection,
  type StripSectionGroup,
} from "../strip-sections";

const PAIR = "pair";
const REF_A: TabRef = { kind: "epic", id: "a" };
const REF_B: TabRef = { kind: "epic", id: "b" };

function pairFocusing(focusedSide: SplitSideName): SplitStripItem {
  return {
    kind: "split",
    id: PAIR,
    left: { kind: "tab", ref: REF_A },
    right: { kind: "tab", ref: REF_B },
    focusedSide,
    routeBackingSide: "left",
    leftRatio: 0.5,
  };
}

/** "Swap sides" as the layout does it: the same member stays focused. */
function swapped(item: SplitStripItem): ReadonlyArray<StripItem> {
  return swapSplitSides({ ...emptyTabStripLayout(), items: [item] }, PAIR)
    .items;
}

function sectionsOf(
  rows: ReadonlyArray<readonly [string, StripSection]>,
): ReadonlyArray<StripSectionGroup> {
  return groupEntriesBySection(
    rows.map(([itemId, section], stripIndex) => ({
      kind: "tabs",
      itemId,
      stripIndex,
      section,
      group: null,
      members: [],
    })),
  );
}

function sectionsWith(
  itemId: string,
  section: StripSection,
): ReadonlyArray<StripSectionGroup> {
  return sectionsOf([[itemId, section]]);
}

function sectionsWithPairIn(
  section: StripSection,
): ReadonlyArray<StripSectionGroup> {
  return sectionsWith(PAIR, section);
}

interface Input {
  readonly activeItemId: string | null;
  readonly sections: ReadonlyArray<StripSectionGroup>;
  readonly items: ReadonlyArray<StripItem>;
}

interface Drawn {
  /** The section the first row is drawn in under the hold the hook answers. */
  readonly section: () => StripSection | undefined;
  /** The section the given item's row is drawn in. */
  readonly sectionOf: (itemId: string) => StripSection | undefined;
  readonly set: (next: Partial<Input>) => void;
}

function drawnOf(input: Input): Drawn {
  const { result, rerender } = renderHook(
    (props: Input) => {
      const hold = useCurrentSectionHold(
        props.sections,
        props.items,
        props.activeItemId,
        [],
      );
      return holdInPlace(props.sections, hold === null ? [] : [hold]);
    },
    { initialProps: input },
  );
  let current = input;
  return {
    section: () => result.current.at(0)?.section,
    sectionOf: (itemId) =>
      result.current.find((group) =>
        group.entries.some(
          (entry) => entry.kind === "tabs" && entry.itemId === itemId,
        ),
      )?.section,
    set: (next) => {
      current = { ...current, ...next };
      rerender(current);
    },
  };
}

function loneTab(ref: TabRef): StripItem {
  return { kind: "tab", id: tabItemId(ref), ref };
}

describe("useCurrentSectionHold", () => {
  const ID_A = tabItemId(REF_A);
  const ID_B = tabItemId(REF_B);

  it("never sinks the current task's row, whatever its state does", () => {
    const drawn = drawnOf({
      activeItemId: ID_A,
      sections: sectionsWith(ID_A, "needs-you"),
      items: [loneTab(REF_A)],
    });

    drawn.set({ sections: sectionsWith(ID_A, "working") });
    expect(drawn.section()).toBe("needs-you");

    drawn.set({ sections: sectionsWith(ID_A, "idle") });
    expect(drawn.section()).toBe("needs-you");
  });

  it("raises the hold as the current task's row rises, and keeps it there", () => {
    const drawn = drawnOf({
      activeItemId: ID_A,
      sections: sectionsWith(ID_A, "idle"),
      items: [loneTab(REF_A)],
    });

    drawn.set({ sections: sectionsWith(ID_A, "working") });
    expect(drawn.section()).toBe("working");

    drawn.set({ sections: sectionsWith(ID_A, "to-review") });
    expect(drawn.section()).toBe("to-review");

    drawn.set({ sections: sectionsWith(ID_A, "idle") });
    expect(drawn.section()).toBe("to-review");
  });

  it("releases the row when another task is opened", () => {
    const drawn = drawnOf({
      activeItemId: ID_A,
      sections: sectionsOf([
        [ID_A, "to-review"],
        [ID_B, "idle"],
      ]),
      items: [loneTab(REF_A), loneTab(REF_B)],
    });
    drawn.set({
      sections: sectionsOf([
        [ID_A, "idle"],
        [ID_B, "idle"],
      ]),
    });
    expect(drawn.sectionOf(ID_A)).toBe("to-review");

    drawn.set({ activeItemId: ID_B });

    expect(drawn.sectionOf(ID_A)).toBe("idle");
  });

  it("holds an opened task in the section its row was drawn in, not the one a change in the same render moved it to", () => {
    const drawn = drawnOf({
      activeItemId: ID_A,
      sections: sectionsOf([
        [ID_A, "idle"],
        [ID_B, "to-review"],
      ]),
      items: [loneTab(REF_A), loneTab(REF_B)],
    });

    drawn.set({
      activeItemId: ID_B,
      sections: sectionsOf([
        [ID_A, "idle"],
        [ID_B, "idle"],
      ]),
    });

    expect(drawn.sectionOf(ID_B)).toBe("to-review");
  });

  it("keeps a task answered into Working in To review while it is current, and lets it go when another is opened", () => {
    const drawn = drawnOf({
      activeItemId: ID_B,
      sections: sectionsOf([
        [ID_A, "to-review"],
        [ID_B, "idle"],
      ]),
      items: [loneTab(REF_A), loneTab(REF_B)],
    });
    drawn.set({ activeItemId: ID_A });

    drawn.set({
      sections: sectionsOf([
        [ID_A, "working"],
        [ID_B, "idle"],
      ]),
    });
    expect(drawn.sectionOf(ID_A)).toBe("to-review");

    drawn.set({ activeItemId: ID_B });

    expect(drawn.sectionOf(ID_A)).toBe("working");
  });

  it("holds a current task that had no row at mount from the section it first appears in", () => {
    const drawn = drawnOf({
      activeItemId: ID_A,
      sections: sectionsOf([[ID_B, "idle"]]),
      items: [loneTab(REF_A), loneTab(REF_B)],
    });

    drawn.set({
      sections: sectionsOf([
        [ID_B, "idle"],
        [ID_A, "to-review"],
      ]),
    });
    drawn.set({
      sections: sectionsOf([
        [ID_B, "idle"],
        [ID_A, "working"],
      ]),
    });

    expect(drawn.sectionOf(ID_A)).toBe("to-review");
  });

  describe("when the layout changes around a held current tab", () => {
    function heldTab(): Drawn {
      return drawnOf({
        activeItemId: ID_A,
        sections: sectionsOf([
          [ID_A, "to-review"],
          [ID_B, "idle"],
        ]),
        items: [loneTab(REF_A), loneTab(REF_B)],
      });
    }

    it("keeps the hold when the items are reordered", () => {
      const drawn = heldTab();

      drawn.set({
        items: [loneTab(REF_B), loneTab(REF_A)],
        sections: sectionsOf([
          [ID_B, "idle"],
          [ID_A, "idle"],
        ]),
      });

      expect(drawn.sectionOf(ID_A)).toBe("to-review");
    });

    it("keeps the hold when the tab is paired as the focused member of a split", () => {
      const drawn = heldTab();

      drawn.set({
        items: [pairFocusing("left")],
        activeItemId: PAIR,
        sections: sectionsWithPairIn("idle"),
      });

      expect(drawn.sectionOf(PAIR)).toBe("to-review");
    });
  });

  it("keeps a pair's hold through a swap of its sides", () => {
    const drawn = drawnOf({
      activeItemId: PAIR,
      sections: sectionsWithPairIn("to-review"),
      items: [pairFocusing("left")],
    });
    drawn.set({ items: swapped(pairFocusing("left")) });

    drawn.set({ sections: sectionsWithPairIn("idle") });

    expect(drawn.section()).toBe("to-review");
  });

  it("keeps a pair's floor when its other member is focused", () => {
    const drawn = drawnOf({
      activeItemId: PAIR,
      sections: sectionsWithPairIn("to-review"),
      items: [pairFocusing("left")],
    });
    drawn.set({ items: [pairFocusing("right")] });

    drawn.set({ sections: sectionsWithPairIn("idle") });

    expect(drawn.section()).toBe("to-review");
  });

  describe("when a member of a held pair is closed", () => {
    function heldPair(): Drawn {
      return drawnOf({
        activeItemId: PAIR,
        sections: sectionsWithPairIn("to-review"),
        items: [pairFocusing("right")],
      });
    }

    function closed(ref: TabRef): {
      readonly items: ReadonlyArray<StripItem>;
      readonly activeItemId: string | null;
    } {
      return removeLayoutRef(
        {
          ...emptyTabStripLayout(),
          items: [pairFocusing("right")],
          activeItemId: PAIR,
        },
        ref,
        false,
      );
    }

    it("carries the hold to the surviving tab when the other member is closed", () => {
      const drawn = heldPair();
      const layout = closed(REF_A);

      drawn.set({ ...layout, sections: sectionsWith(ID_B, "idle") });

      expect(layout.activeItemId).toBe(ID_B);
      expect(drawn.section()).toBe("to-review");
    });

    it("starts the surviving tab afresh when the focused member is closed", () => {
      const drawn = heldPair();
      const layout = closed(REF_B);

      drawn.set({ ...layout, sections: sectionsWith(ID_A, "idle") });

      expect(layout.activeItemId).toBe(ID_A);
      expect(drawn.section()).toBe("idle");
    });
  });
});

describe("useStripPointerInside", () => {
  function mounted() {
    const scroller = document.createElement("div");
    const child = document.createElement("span");
    scroller.append(child);
    document.body.append(scroller);
    const { result } = renderHook(() => useStripPointerInside(scroller));
    const fire = (target: EventTarget, event: Event): void => {
      act(() => {
        target.dispatchEvent(event);
      });
    };
    return { scroller, child, inside: () => result.current, fire };
  }

  function showing(state: DocumentVisibilityState): void {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => state,
    });
  }

  afterEach(() => {
    Reflect.deleteProperty(document, "visibilityState");
  });

  it("is false at mount", () => {
    expect(mounted().inside()).toBe(false);
  });

  it("is true after a pointerover on a descendant of the scroller", () => {
    const list = mounted();

    list.fire(list.child, new PointerEvent("pointerover", { bubbles: true }));

    expect(list.inside()).toBe(true);
  });

  it("is false after the pointer leaves the scroller", () => {
    const list = mounted();
    list.fire(list.child, new PointerEvent("pointerover", { bubbles: true }));

    list.fire(list.scroller, new PointerEvent("pointerleave"));

    expect(list.inside()).toBe(false);
  });

  it("is false after the window blurs, and true again on the next pointerover", () => {
    const list = mounted();
    list.fire(list.child, new PointerEvent("pointerover", { bubbles: true }));

    list.fire(window, new Event("blur"));
    expect(list.inside()).toBe(false);

    list.fire(list.child, new PointerEvent("pointerover", { bubbles: true }));
    expect(list.inside()).toBe(true);
  });

  it("is false once the page becomes hidden, and unchanged when it is visible", () => {
    const list = mounted();
    list.fire(list.child, new PointerEvent("pointerover", { bubbles: true }));

    showing("visible");
    list.fire(document, new Event("visibilitychange"));
    expect(list.inside()).toBe(true);

    showing("hidden");
    list.fire(document, new Event("visibilitychange"));
    expect(list.inside()).toBe(false);
  });

  it("forgets the pointer when the list's scroller is replaced", () => {
    const first = document.createElement("div");
    const second = document.createElement("div");
    document.body.append(first, second);
    const { result, rerender } = renderHook(
      (scroller: HTMLElement) => useStripPointerInside(scroller),
      { initialProps: first },
    );
    act(() => {
      first.dispatchEvent(new PointerEvent("pointerover"));
    });
    expect(result.current).toBe(true);

    rerender(second);
    expect(result.current).toBe(false);

    act(() => {
      second.dispatchEvent(new PointerEvent("pointerover"));
    });
    expect(result.current).toBe(true);
  });

  it("is unchanged when focus leaves the scroller", () => {
    const list = mounted();
    list.fire(list.child, new PointerEvent("pointerover", { bubbles: true }));

    list.fire(list.child, new FocusEvent("focusout", { bubbles: true }));

    expect(list.inside()).toBe(true);
  });
});

describe("useReleasedSectionHolds", () => {
  const ID_A = "a";
  const ID_B = "b";
  const HELD_A: StripSectionHold = { itemId: ID_A, section: "to-review" };
  const HELD_B: StripSectionHold = { itemId: ID_B, section: "idle" };
  const AT_REST = sectionsOf([
    [ID_A, "idle"],
    [ID_B, "idle"],
  ]);

  interface Input {
    readonly current: StripSectionHold | null;
    readonly sections: ReadonlyArray<StripSectionGroup>;
    readonly pointerInside: boolean;
  }

  function released(input: Input) {
    const { result, rerender } = renderHook(
      (props: Input) =>
        useReleasedSectionHolds(
          props.current,
          props.sections,
          props.pointerInside,
        ),
      { initialProps: input },
    );
    let latest = input;
    return {
      holds: () => result.current,
      set: (next: Partial<Input>) => {
        latest = { ...latest, ...next };
        rerender(latest);
      },
    };
  }

  const openingA: Input = {
    current: HELD_A,
    sections: AT_REST,
    pointerInside: true,
  };

  it("is empty at mount", () => {
    expect(released(openingA).holds()).toEqual([]);
  });

  it("keeps the row that stopped being current in the section it was held in, while the pointer is inside", () => {
    const list = released(openingA);

    list.set({ current: HELD_B });

    expect(list.holds()).toEqual([HELD_A]);
  });

  it("keeps nothing when the pointer is outside as the current task changes", () => {
    const list = released({ ...openingA, pointerInside: false });

    list.set({ current: HELD_B });

    expect(list.holds()).toEqual([]);
  });

  it("drops a waiting hold when the pointer leaves", () => {
    const list = released(openingA);
    list.set({ current: HELD_B });

    list.set({ pointerInside: false });

    expect(list.holds()).toEqual([]);
  });

  it("drops a waiting hold when its task is current again, and the row it replaces waits", () => {
    const list = released(openingA);
    list.set({ current: HELD_B });

    list.set({ current: HELD_A });

    expect(list.holds()).toEqual([HELD_B]);
  });

  it("adds the previous row's hold when its section is its own", () => {
    const heldInOwn: StripSectionHold = { itemId: ID_A, section: "idle" };
    const list = released({ ...openingA, current: heldInOwn });

    list.set({ current: HELD_B });

    expect(list.holds()).toEqual([heldInOwn]);
  });

  it("keeps nothing for an item that has no row any more", () => {
    const list = released(openingA);

    list.set({ current: HELD_B, sections: sectionsOf([[ID_B, "idle"]]) });

    expect(list.holds()).toEqual([]);
  });

  it("keeps nothing when the current hold's section changes for the same item", () => {
    const list = released(openingA);

    list.set({ current: { itemId: ID_A, section: "needs-you" } });

    expect(list.holds()).toEqual([]);
  });

  it("keeps a waiting row where it waits when its own section becomes that one and moves on", () => {
    const list = released(openingA);
    list.set({ current: HELD_B });
    expect(list.holds()).toEqual([HELD_A]);

    list.set({
      sections: sectionsOf([
        [ID_A, "to-review"],
        [ID_B, "idle"],
      ]),
    });
    expect(list.holds()).toEqual([HELD_A]);

    list.set({
      sections: sectionsOf([
        [ID_A, "needs-you"],
        [ID_B, "idle"],
      ]),
    });
    expect(list.holds()).toEqual([HELD_A]);

    list.set({ pointerInside: false });
    expect(list.holds()).toEqual([]);
  });
});
