/**
 * The current task's row is held in the most urgent section it has been drawn
 * in since it became current, and released when another task is opened. These
 * are the openings that carry the hold and the ones that start it afresh: a
 * pair's swap and its other member's close carry it, its focused member's
 * close does not. Where a held row is drawn, and when it lets go on screen, is
 * `browser-tests/side-strip-section-motion.spec.ts`'s.
 */
import { renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
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
import { holdInPlace, useCurrentSectionHold } from "../strip-section-hold";
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
