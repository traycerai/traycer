/**
 * Which openings take the opened-from-To-review hold. Where a held row is
 * drawn, and when it lets go on screen, is
 * `browser-tests/side-strip-section-motion.spec.ts`'s.
 */
import { renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  holdInPlace,
  useOpenedSectionHold,
  type StripOpening,
} from "../strip-section-hold";
import {
  groupEntriesBySection,
  type StripSection,
  type StripSectionGroup,
} from "../strip-sections";

const PAIR = "pair";

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
  readonly opening: StripOpening;
}

interface Drawn {
  /** The section the pair's row is drawn in under the hold the hook answers. */
  readonly section: () => StripSection | undefined;
  readonly set: (next: Partial<Input>) => void;
}

function drawnOf(input: Input): Drawn {
  const { result, rerender } = renderHook(
    (props: Input) => {
      const hold = useOpenedSectionHold(props.sections, props.opening, []);
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
  it("holds a current pair in To review when its other half is opened from there", () => {
    const idle = sectionsWithPairIn("idle");
    const drawn = drawnOf({
      sections: idle,
      opening: { itemId: PAIR, focusedSide: "left" },
    });
    // The right half finishes while the left one is on screen.
    drawn.set({ sections: sectionsWithPairIn("to-review") });
    drawn.set({ opening: { itemId: PAIR, focusedSide: "right" } });

    // Opening it read it.
    drawn.set({ sections: idle });

    expect(drawn.section()).toBe("to-review");
  });

  it("lets a pair that finished and was read under the person, unopened, go to Idle", () => {
    const drawn = drawnOf({
      sections: sectionsWithPairIn("idle"),
      opening: { itemId: PAIR, focusedSide: "left" },
    });
    drawn.set({ sections: sectionsWithPairIn("to-review") });

    drawn.set({ sections: sectionsWithPairIn("idle") });

    expect(drawn.section()).toBe("idle");
  });
});
