import { describe, expect, it } from "vitest";
import {
  DEFAULT_ARRANGEMENT,
  type LayoutArrangement,
} from "@/lib/layout/layout-arrangement";
import {
  EMPTY_LAYOUT_HISTORY,
  LAYOUT_HISTORY_CAP,
  rebaseLayoutSnapshot,
  recordLayoutChange,
  redoLayout,
  undoLayout,
  type LayoutHistory,
} from "@/lib/layout/layout-history";
import type { LayoutSnapshot } from "@/lib/layout/layout-snapshot";
import { DEFAULT_LAYOUT_SNAPSHOT } from "@/stores/layout/layout-store";

function withModelStyle(style: "text" | "bars"): LayoutSnapshot {
  return {
    ...DEFAULT_LAYOUT_SNAPSHOT,
    overrides: style === "text" ? {} : { model: { style } },
  };
}

describe("undo and redo", () => {
  it("walks back to the state a gesture replaced and forward again", () => {
    const before = withModelStyle("text");
    const after = withModelStyle("bars");
    const history = recordLayoutChange(EMPTY_LAYOUT_HISTORY, before);

    const undone = undoLayout(history, after);

    expect(undone?.snapshot).toEqual(before);

    const redone = redoLayout(undone?.history ?? EMPTY_LAYOUT_HISTORY, before);

    expect(redone?.snapshot).toEqual(after);
    expect(redone?.history).toEqual({ past: [before], future: [] });
  });

  it("has nothing to travel to on an empty history", () => {
    const current = withModelStyle("bars");

    expect(undoLayout(EMPTY_LAYOUT_HISTORY, current)).toBeNull();
    expect(redoLayout(EMPTY_LAYOUT_HISTORY, current)).toBeNull();
  });

  it("keeps the newest entries once the cap is reached", () => {
    let history: LayoutHistory = EMPTY_LAYOUT_HISTORY;
    for (let step = 0; step < LAYOUT_HISTORY_CAP + 5; step += 1) {
      history = recordLayoutChange(history, {
        ...DEFAULT_LAYOUT_SNAPSHOT,
        arrangement: { ...DEFAULT_ARRANGEMENT, dividerSeq: step },
      });
    }

    expect(history.past).toHaveLength(LAYOUT_HISTORY_CAP);
    expect(history.past[0].arrangement.dividerSeq).toBe(5);
    expect(history.past.at(-1)?.arrangement.dividerSeq).toBe(
      LAYOUT_HISTORY_CAP + 4,
    );
  });
});

describe("rebasing the entry snapshot on an external write", () => {
  const entry: LayoutSnapshot = {
    ...DEFAULT_LAYOUT_SNAPSHOT,
    overrides: { model: { style: "bars" } },
  };
  const previous: LayoutSnapshot = {
    ...DEFAULT_LAYOUT_SNAPSHOT,
    overrides: { mic: { shown: "hidden" } },
  };

  it("takes the field the other writer moved and keeps the rest of the entry", () => {
    const next: LayoutSnapshot = {
      ...previous,
      arrangement: { ...DEFAULT_ARRANGEMENT, usageHost: "header" },
    };

    const rebased = rebaseLayoutSnapshot(entry, previous, next);

    // Discard now puts the page back to how this session found it, WITH the
    // other window's move - rather than undoing a change it never made.
    expect(rebased.arrangement.usageHost).toBe("header");
    expect(rebased.arrangement.minimapSide).toBe(
      DEFAULT_ARRANGEMENT.minimapSide,
    );
    expect(rebased.overrides).toEqual({ model: { style: "bars" } });
  });

  /**
   * The entry's own pick and the external writer's move can land on
   * DIFFERENT arrangement fields, and each must survive on its own - a bug
   * that collapsed both onto whichever wrote last would pass every other
   * case here, since they all move at most one non-default field.
   */
  const ownVersusTheirs: ReadonlyArray<{
    readonly name: string;
    readonly own: Partial<LayoutArrangement>;
    readonly theirs: Partial<LayoutArrangement>;
  }> = [
    {
      name: "tab strip placement while taking the other writer's sidebar side",
      own: { tabStripPlacement: "left" },
      theirs: { sidebarSide: "right" },
    },
    {
      name: "sidebar side while taking the other writer's tab strip placement",
      own: { sidebarSide: "right" },
      theirs: { tabStripPlacement: "left" },
    },
    {
      name: "strip view while taking the other writer's sidebar side (D8)",
      own: { sideStripView: "activity" },
      theirs: { sidebarSide: "right" },
    },
  ];

  it.each(ownVersusTheirs)("keeps the entry's own $name", ({ own, theirs }) => {
    const ownEntry: LayoutSnapshot = {
      ...entry,
      arrangement: { ...DEFAULT_ARRANGEMENT, ...own },
    };
    const next: LayoutSnapshot = {
      ...previous,
      arrangement: { ...DEFAULT_ARRANGEMENT, ...theirs },
    };

    const rebased = rebaseLayoutSnapshot(ownEntry, previous, next);

    expect(rebased.arrangement).toMatchObject({ ...own, ...theirs });
  });

  it("takes a region the other writer changed and leaves a region it did not", () => {
    const next: LayoutSnapshot = {
      ...previous,
      overrides: {
        mic: { shown: "hidden" },
        homeTab: { shown: "shown" },
      },
    };

    const rebased = rebaseLayoutSnapshot(entry, previous, next);

    expect(rebased.overrides).toEqual({
      model: { style: "bars" },
      homeTab: { shown: "shown" },
    });
  });

  it("takes a base preset the other writer switched", () => {
    const next: LayoutSnapshot = { ...previous, basePreset: "compact" };

    const rebased = rebaseLayoutSnapshot(entry, previous, next);

    expect(rebased.basePreset).toBe("compact");
    // The picks are untouched by a density change, here as everywhere
    // (L-133): the other writer switched the base, not the entry's own
    // answers, and Compact drawing the model chip as bars already is what
    // makes this pick invisible rather than what makes it gone.
    expect(rebased.overrides).toEqual({ model: { style: "bars" } });
  });

  it("changes nothing when the other writer changed nothing", () => {
    expect(rebaseLayoutSnapshot(entry, previous, previous)).toEqual(entry);
  });
});
