/**
 * Which openings take the opened-from-To-review hold: focusing the pair's
 * other member does, swapping its sides does not. Where a held row is drawn,
 * and when it lets go on screen, is
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
import { holdInPlace, useOpenedSectionHold } from "../strip-section-hold";
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

function sectionsWith(
  itemId: string,
  section: StripSection,
): ReadonlyArray<StripSectionGroup> {
  return groupEntriesBySection([
    {
      kind: "tabs",
      itemId,
      stripIndex: 0,
      section,
      group: null,
      members: [],
    },
  ]);
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
  /** The section the pair's row is drawn in under the hold the hook answers. */
  readonly section: () => StripSection | undefined;
  readonly set: (next: Partial<Input>) => void;
}

function drawnOf(input: Input): Drawn {
  const { result, rerender } = renderHook(
    (props: Input) => {
      const hold = useOpenedSectionHold(
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
    set: (next) => {
      current = { ...current, ...next };
      rerender(current);
    },
  };
}

describe("useOpenedSectionHold", () => {
  // A mount is not an opening.
  it("takes no hold for a task already current in To review when the list mounts", () => {
    const itemId = tabItemId(REF_A);
    const drawn = drawnOf({
      activeItemId: itemId,
      sections: sectionsWith(itemId, "to-review"),
      items: [{ kind: "tab", id: itemId, ref: REF_A }],
    });
    expect(drawn.section()).toBe("to-review");

    drawn.set({ sections: sectionsWith(itemId, "idle") });

    expect(drawn.section()).toBe("idle");
  });

  it("holds a current pair in To review when its other member is focused from there", () => {
    const drawn = drawnOf({
      activeItemId: PAIR,
      sections: sectionsWithPairIn("idle"),
      items: [pairFocusing("left")],
    });
    // The right member finishes while the left one is on screen.
    drawn.set({ sections: sectionsWithPairIn("to-review") });
    drawn.set({ items: [pairFocusing("right")] });

    // Focusing it read it.
    drawn.set({ sections: sectionsWithPairIn("idle") });

    expect(drawn.section()).toBe("to-review");
  });

  it("lets a pair that finished and was read under the person, then had its sides swapped, go to Idle", () => {
    const drawn = drawnOf({
      activeItemId: PAIR,
      sections: sectionsWithPairIn("idle"),
      items: [pairFocusing("left")],
    });
    drawn.set({ sections: sectionsWithPairIn("to-review") });
    drawn.set({ items: swapped(pairFocusing("left")) });

    drawn.set({ sections: sectionsWithPairIn("idle") });

    expect(drawn.section()).toBe("idle");
  });

  it("keeps an existing hold through a swap of the pair's sides", () => {
    const drawn = drawnOf({
      activeItemId: PAIR,
      sections: sectionsWithPairIn("idle"),
      items: [pairFocusing("left")],
    });
    drawn.set({ sections: sectionsWithPairIn("to-review") });
    drawn.set({ items: [pairFocusing("right")] });
    drawn.set({ items: swapped(pairFocusing("right")) });

    drawn.set({ sections: sectionsWithPairIn("idle") });

    expect(drawn.section()).toBe("to-review");
  });

  describe("when a member of a held pair is closed", () => {
    function heldPair(): Drawn {
      const drawn = drawnOf({
        activeItemId: PAIR,
        sections: sectionsWithPairIn("idle"),
        items: [pairFocusing("left")],
      });
      drawn.set({ sections: sectionsWithPairIn("to-review") });
      drawn.set({ items: [pairFocusing("right")] });
      drawn.set({ sections: sectionsWithPairIn("idle") });
      return drawn;
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

    it("keeps the hold on the surviving tab when the focused member stays", () => {
      const drawn = heldPair();
      const layout = closed(REF_A);

      drawn.set({
        ...layout,
        sections: sectionsWith(tabItemId(REF_B), "idle"),
      });

      expect(layout.activeItemId).toBe(tabItemId(REF_B));
      expect(drawn.section()).toBe("to-review");
    });

    it("does not give the surviving tab the hold when the focused member is closed", () => {
      const drawn = heldPair();
      const layout = closed(REF_B);

      drawn.set({
        ...layout,
        sections: sectionsWith(tabItemId(REF_A), "idle"),
      });

      expect(layout.activeItemId).toBe(tabItemId(REF_A));
      expect(drawn.section()).toBe("idle");
    });
  });
});
