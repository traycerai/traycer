import { describe, expect, it } from "vitest";
import {
  groupSidebarPanelWithPrevious,
  isSidebarPanelGroupBoundary,
  moveSidebarPanelDown,
  moveSidebarPanelUp,
  resolveSidebarPanelDrop,
  sidebarPanelRowActions,
  ungroupSidebarPanel,
} from "@/components/settings/panels/layout/sidebar-panel-moves";
import {
  areLeftPanelGroupsEqual,
  LEFT_PANEL_IDS,
  type LeftPanelGroup,
} from "@/stores/epics/left-panel-store";

// One three-panel group, one two-panel group, and four single-panel groups -
// covers a first/interior/last row inside a multi-panel group, a first/last
// row inside a two-panel group, and a lone panel next to another lone panel,
// using all nine panel ids exactly once so every resolved result below is
// fully determined.
const GROUPS = [
  { panelIds: ["chats", "artifacts", "terminals"] },
  { panelIds: ["browsers"] },
  { panelIds: ["git-diff", "pull-requests"] },
  { panelIds: ["file-tree"] },
  { panelIds: ["sharing"] },
  { panelIds: ["comments"] },
] as const satisfies ReadonlyArray<LeftPanelGroup>;

// Every panel ungrouped, in canonical id order - the shape row-action
// boundaries (first/last row of the first/last group, alone) need.
const UNGROUPED: ReadonlyArray<LeftPanelGroup> = LEFT_PANEL_IDS.map(
  (panelId) => ({ panelIds: [panelId] }),
);

describe("resolveSidebarPanelDrop", () => {
  it("nests the source into the target's group on combine", () => {
    expect(
      resolveSidebarPanelDrop(GROUPS, "browsers", "file-tree", "combine"),
    ).toEqual([
      { panelIds: ["chats", "artifacts", "terminals"] },
      { panelIds: ["git-diff", "pull-requests"] },
      { panelIds: ["file-tree", "browsers"] },
      { panelIds: ["sharing"] },
      { panelIds: ["comments"] },
    ]);
  });

  it("un-nests the source and places it as its own group before a group's first row", () => {
    // "git-diff" is the first row of its group, so the boundary above it is a
    // GROUP boundary - "terminals" leaves its own group instead of nesting.
    expect(
      resolveSidebarPanelDrop(GROUPS, "terminals", "git-diff", "before"),
    ).toEqual([
      { panelIds: ["chats", "artifacts"] },
      { panelIds: ["browsers"] },
      { panelIds: ["terminals"] },
      { panelIds: ["git-diff", "pull-requests"] },
      { panelIds: ["file-tree"] },
      { panelIds: ["sharing"] },
      { panelIds: ["comments"] },
    ]);
  });

  it("un-nests the source and places it as its own group after a group's last row", () => {
    // "pull-requests" is the last row of its group, so the boundary below it
    // is a GROUP boundary too - "chats" leaves its own group.
    expect(
      resolveSidebarPanelDrop(GROUPS, "chats", "pull-requests", "after"),
    ).toEqual([
      { panelIds: ["artifacts", "terminals"] },
      { panelIds: ["browsers"] },
      { panelIds: ["git-diff", "pull-requests"] },
      { panelIds: ["chats"] },
      { panelIds: ["file-tree"] },
      { panelIds: ["sharing"] },
      { panelIds: ["comments"] },
    ]);
  });

  it("nests the source into an interior row's group at that index", () => {
    // "artifacts" sits between two other rows in its group, so the boundary
    // beside it is an IN-GROUP one - "sharing" nests in at that index.
    expect(
      resolveSidebarPanelDrop(GROUPS, "sharing", "artifacts", "before"),
    ).toEqual([
      { panelIds: ["chats", "sharing", "artifacts", "terminals"] },
      { panelIds: ["browsers"] },
      { panelIds: ["git-diff", "pull-requests"] },
      { panelIds: ["file-tree"] },
      { panelIds: ["comments"] },
    ]);
  });

  it("returns groups structurally equal to the input for a drop that changes nothing", () => {
    // "artifacts" is already directly after "chats" in its group.
    const result = resolveSidebarPanelDrop(
      GROUPS,
      "artifacts",
      "chats",
      "after",
    );
    expect(areLeftPanelGroupsEqual(result, GROUPS)).toBe(true);
  });
});

describe("moveSidebarPanelUp", () => {
  it("swaps with the row above it while one exists in the same group", () => {
    expect(moveSidebarPanelUp(GROUPS, "artifacts")).toEqual([
      { panelIds: ["artifacts", "chats", "terminals"] },
      { panelIds: ["browsers"] },
      { panelIds: ["git-diff", "pull-requests"] },
      { panelIds: ["file-tree"] },
      { panelIds: ["sharing"] },
      { panelIds: ["comments"] },
    ]);
  });

  it("leaves the group at its top edge, landing just above the remainder", () => {
    expect(moveSidebarPanelUp(GROUPS, "chats")).toEqual([
      { panelIds: ["chats"] },
      { panelIds: ["artifacts", "terminals"] },
      { panelIds: ["browsers"] },
      { panelIds: ["git-diff", "pull-requests"] },
      { panelIds: ["file-tree"] },
      { panelIds: ["sharing"] },
      { panelIds: ["comments"] },
    ]);
  });

  it("swaps with the neighbouring group when alone in its own", () => {
    expect(moveSidebarPanelUp(GROUPS, "browsers")).toEqual([
      { panelIds: ["browsers"] },
      { panelIds: ["chats", "artifacts", "terminals"] },
      { panelIds: ["git-diff", "pull-requests"] },
      { panelIds: ["file-tree"] },
      { panelIds: ["sharing"] },
      { panelIds: ["comments"] },
    ]);
  });
});

describe("moveSidebarPanelDown", () => {
  it("swaps with the row below it while one exists in the same group", () => {
    expect(moveSidebarPanelDown(GROUPS, "chats")).toEqual([
      { panelIds: ["artifacts", "chats", "terminals"] },
      { panelIds: ["browsers"] },
      { panelIds: ["git-diff", "pull-requests"] },
      { panelIds: ["file-tree"] },
      { panelIds: ["sharing"] },
      { panelIds: ["comments"] },
    ]);
  });

  it("leaves the group at its bottom edge, landing just below the remainder", () => {
    expect(moveSidebarPanelDown(GROUPS, "terminals")).toEqual([
      { panelIds: ["chats", "artifacts"] },
      { panelIds: ["terminals"] },
      { panelIds: ["browsers"] },
      { panelIds: ["git-diff", "pull-requests"] },
      { panelIds: ["file-tree"] },
      { panelIds: ["sharing"] },
      { panelIds: ["comments"] },
    ]);
  });

  it("swaps with the neighbouring group when alone in its own", () => {
    expect(moveSidebarPanelDown(GROUPS, "browsers")).toEqual([
      { panelIds: ["chats", "artifacts", "terminals"] },
      { panelIds: ["git-diff", "pull-requests"] },
      { panelIds: ["browsers"] },
      { panelIds: ["file-tree"] },
      { panelIds: ["sharing"] },
      { panelIds: ["comments"] },
    ]);
  });
});

describe("groupSidebarPanelWithPrevious", () => {
  it("appends the panel to the card above", () => {
    expect(groupSidebarPanelWithPrevious(GROUPS, "browsers")).toEqual([
      { panelIds: ["chats", "artifacts", "terminals", "browsers"] },
      { panelIds: ["git-diff", "pull-requests"] },
      { panelIds: ["file-tree"] },
      { panelIds: ["sharing"] },
      { panelIds: ["comments"] },
    ]);
  });

  it("is a no-op for the first group's row, which has no card above it", () => {
    expect(groupSidebarPanelWithPrevious(GROUPS, "chats")).toBe(GROUPS);
  });
});

describe("ungroupSidebarPanel", () => {
  it("un-nests the panel directly below the card it left", () => {
    expect(ungroupSidebarPanel(GROUPS, "artifacts")).toEqual([
      { panelIds: ["chats", "terminals"] },
      { panelIds: ["artifacts"] },
      { panelIds: ["browsers"] },
      { panelIds: ["git-diff", "pull-requests"] },
      { panelIds: ["file-tree"] },
      { panelIds: ["sharing"] },
      { panelIds: ["comments"] },
    ]);
  });
});

describe("sidebarPanelRowActions", () => {
  it("disables move-up for the first row of the first group, alone", () => {
    expect(sidebarPanelRowActions(UNGROUPED, "chats")).toEqual({
      canMoveUp: false,
      canMoveDown: true,
      canGroupWithPrevious: false,
      canUngroup: false,
    });
  });

  it("disables move-down for the last row of the last group, alone", () => {
    expect(sidebarPanelRowActions(UNGROUPED, "comments")).toEqual({
      canMoveUp: true,
      canMoveDown: false,
      canGroupWithPrevious: true,
      canUngroup: false,
    });
  });

  it("enables group-with-previous only for the first row of a non-first group", () => {
    expect(
      sidebarPanelRowActions(UNGROUPED, "terminals").canGroupWithPrevious,
    ).toBe(true);
    // "pull-requests" is a non-first row of a non-first group.
    expect(
      sidebarPanelRowActions(GROUPS, "pull-requests").canGroupWithPrevious,
    ).toBe(false);
  });

  it("enables ungroup only inside a multi-panel group", () => {
    expect(sidebarPanelRowActions(GROUPS, "artifacts").canUngroup).toBe(true);
    expect(sidebarPanelRowActions(GROUPS, "browsers").canUngroup).toBe(false);
  });
});

describe("keyboard actions match their equivalent drag", () => {
  it("moveSidebarPanelDown matches dropping the panel after the row below it", () => {
    expect(moveSidebarPanelDown(GROUPS, "chats")).toEqual(
      resolveSidebarPanelDrop(GROUPS, "chats", "artifacts", "after"),
    );
  });

  it("moveSidebarPanelUp matches dropping the panel before the row above it", () => {
    expect(moveSidebarPanelUp(GROUPS, "terminals")).toEqual(
      resolveSidebarPanelDrop(GROUPS, "terminals", "artifacts", "before"),
    );
  });

  it("ungroupSidebarPanel matches the equivalent group-edge drop", () => {
    expect(ungroupSidebarPanel(GROUPS, "artifacts")).toEqual(
      resolveSidebarPanelDrop(GROUPS, "artifacts", "terminals", "after"),
    );
  });
});

describe("resolveSidebarPanelDrop edge cases", () => {
  it("returns the input unchanged when the source and target are the same panel", () => {
    expect(resolveSidebarPanelDrop(GROUPS, "chats", "chats", "after")).toBe(
      GROUPS,
    );
  });

  it("is a no-op to combine onto a row already in the source's own group", () => {
    const result = resolveSidebarPanelDrop(
      GROUPS,
      "chats",
      "terminals",
      "combine",
    );
    expect(areLeftPanelGroupsEqual(result, GROUPS)).toBe(true);
  });

  it("lands the panel as its own group at the very start, before the first group's first row", () => {
    // "chats" is the first row of the first group, so the boundary above it is
    // the outermost one there is.
    expect(
      resolveSidebarPanelDrop(GROUPS, "comments", "chats", "before"),
    ).toEqual([
      { panelIds: ["comments"] },
      { panelIds: ["chats", "artifacts", "terminals"] },
      { panelIds: ["browsers"] },
      { panelIds: ["git-diff", "pull-requests"] },
      { panelIds: ["file-tree"] },
      { panelIds: ["sharing"] },
    ]);
  });

  it("lands the panel as its own group at the very end, after the last group's last row", () => {
    // "comments" is alone in the last group, so the boundary below it is the
    // outermost one there is.
    expect(
      resolveSidebarPanelDrop(GROUPS, "chats", "comments", "after"),
    ).toEqual([
      { panelIds: ["artifacts", "terminals"] },
      { panelIds: ["browsers"] },
      { panelIds: ["git-diff", "pull-requests"] },
      { panelIds: ["file-tree"] },
      { panelIds: ["sharing"] },
      { panelIds: ["comments"] },
      { panelIds: ["chats"] },
    ]);
  });
});

describe("ungroupSidebarPanel on a two-member card", () => {
  it("leaves both panels in cards of their own, the moved one directly below", () => {
    // Unlike the 3-panel "artifacts" case above, "git-diff" shares its card
    // with only one other panel, so taking it out leaves nothing nested on
    // either side of the move.
    expect(ungroupSidebarPanel(GROUPS, "git-diff")).toEqual([
      { panelIds: ["chats", "artifacts", "terminals"] },
      { panelIds: ["browsers"] },
      { panelIds: ["pull-requests"] },
      { panelIds: ["git-diff"] },
      { panelIds: ["file-tree"] },
      { panelIds: ["sharing"] },
      { panelIds: ["comments"] },
    ]);
  });
});

describe("isSidebarPanelGroupBoundary agrees with resolveSidebarPanelDrop", () => {
  // The drop indicator is drawn from `isSidebarPanelGroupBoundary`; the actual
  // drop resolves through `resolveSidebarPanelDrop`. Both read the SAME
  // boundary for a given (row, position), so what the indicator promises and
  // what the drop does cannot drift apart. Same source throughout, dropped
  // against an interior row (both directions) and both edges of the
  // "git-diff"/"pull-requests" card.
  const source = "sharing";
  const cases: ReadonlyArray<{
    readonly target: LeftPanelGroup["panelIds"][number];
    readonly position: "before" | "after";
    readonly description: string;
  }> = [
    {
      target: "artifacts",
      position: "before",
      description: "interior row, before",
    },
    {
      target: "artifacts",
      position: "after",
      description: "interior row, after",
    },
    {
      target: "git-diff",
      position: "before",
      description: "card's own top edge",
    },
    {
      target: "pull-requests",
      position: "after",
      description: "card's own bottom edge",
    },
  ];

  it.each(cases)(
    "$description: the resolved grouping matches what the boundary predicate promises",
    ({ target, position }) => {
      const isBoundary = isSidebarPanelGroupBoundary(GROUPS, target, position);
      const result = resolveSidebarPanelDrop(GROUPS, source, target, position);
      const sourceGroup = result.find((group) =>
        group.panelIds.includes(source),
      );
      const sourcePanelIds = sourceGroup?.panelIds ?? [];

      if (isBoundary) {
        // A group boundary lands the panel in a card of its own.
        expect(sourcePanelIds).toEqual([source]);
      } else {
        // An in-group boundary nests the panel into the target's card.
        expect(sourcePanelIds.length).toBeGreaterThan(1);
        expect(sourcePanelIds).toContain(target);
      }
    },
  );
});
