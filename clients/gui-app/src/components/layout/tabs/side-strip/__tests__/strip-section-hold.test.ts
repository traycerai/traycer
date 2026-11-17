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
  swapSplitSides,
  type SplitSideName,
  type SplitStripItem,
  type StripItem,
} from "@/stores/tabs/layout";
import { holdInPlace, useOpenedSectionHold } from "../strip-section-hold";
import {
  groupEntriesBySection,
  type StripSection,
  type StripSectionGroup,
} from "../strip-sections";

const PAIR = "pair";

function pairFocusing(focusedSide: SplitSideName): SplitStripItem {
  return {
    kind: "split",
    id: PAIR,
    left: { kind: "tab", ref: { kind: "epic", id: "a" } },
    right: { kind: "tab", ref: { kind: "epic", id: "b" } },
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

function sectionsWithPairIn(
  section: StripSection,
): ReadonlyArray<StripSectionGroup> {
  return groupEntriesBySection([
    {
      kind: "tabs",
      itemId: PAIR,
      stripIndex: 0,
      section,
      group: null,
      members: [],
    },
  ]);
}

interface Input {
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
      const hold = useOpenedSectionHold(props.sections, props.items, PAIR, []);
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
  it("holds a current pair in To review when its other member is focused from there", () => {
    const drawn = drawnOf({
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
      sections: sectionsWithPairIn("idle"),
      items: [pairFocusing("left")],
    });
    drawn.set({ sections: sectionsWithPairIn("to-review") });
    drawn.set({ items: [pairFocusing("right")] });
    drawn.set({ items: swapped(pairFocusing("right")) });

    drawn.set({ sections: sectionsWithPairIn("idle") });

    expect(drawn.section()).toBe("to-review");
  });
});
