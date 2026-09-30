import { describe, expect, it } from "vitest";
import {
  switcherCategories,
  type SwitcherCategories,
} from "@/components/epic-canvas/mobile/switcher-categories";
import { LEFT_PANEL_DEFINITIONS } from "@/components/epic-canvas/sidebar/left-panel-registry";
import {
  DEFAULT_RAIL,
  normalizeRail,
  railDividerId,
  railFromPanelIdOrder,
  railStackId,
  visibleRailPanelIds,
} from "@/lib/layout/rail";
import { LEFT_PANEL_IDS } from "@/lib/left-panel-ids";

function ids(categories: SwitcherCategories): {
  bar: ReadonlyArray<string>;
  more: ReadonlyArray<string>;
} {
  return {
    bar: categories.bar.map((definition) => definition.id),
    more: categories.more.map((definition) => definition.id),
  };
}

describe("switcherCategories", () => {
  it("puts every panel on the bar in the rail's order, Pull requests and Comments included, with nothing under More", () => {
    // No override is what `Auto` produces for Pull requests and Comments: the
    // phone reads it as shown rather than applying the rail's presence rule.
    const result = ids(switcherCategories(DEFAULT_RAIL, {}));
    expect(result.bar).toEqual(visibleRailPanelIds(DEFAULT_RAIL, () => true));
    expect(result.bar).toContain("pull-requests");
    expect(result.bar).toContain("comments");
    expect(result.more).toEqual([]);
  });

  it("follows the user's rail order, not a fixed one", () => {
    const reversed = [...LEFT_PANEL_IDS].reverse();
    const result = ids(switcherCategories(railFromPanelIdOrder(reversed), {}));
    expect(result.bar).toEqual(reversed);
  });

  it("moves only a panel explicitly turned off into More, in rail order", () => {
    const result = ids(
      switcherCategories(DEFAULT_RAIL, {
        comments: false,
        sharing: false,
        terminals: false,
        "pull-requests": true,
      }),
    );
    expect(result.more).toEqual(["terminals", "sharing", "comments"]);
    expect(result.bar).not.toContain("terminals");
    expect(result.bar).toContain("pull-requests");
  });

  it("flattens a stacked rail: each member its own chip in stack order, dividers ignored, off per member", () => {
    const rail = normalizeRail([
      { kind: "panel", id: "railTerminals" },
      { kind: "divider", id: railDividerId(1) },
      { kind: "panel", id: "railGitDiff" },
      { kind: "panel", id: "railAgents" },
      { kind: "panel", id: "railBrowsers" },
      {
        kind: "stack",
        id: railStackId(["railGitDiff", "railAgents", "railBrowsers"]),
      },
      // Every other panel named, so normalization inserts none into the stack.
      ...(
        [
          "railArtifacts",
          "railPullRequests",
          "railFileTree",
          "railSharing",
          "railComments",
        ] as const
      ).map((id) => ({ kind: "panel" as const, id })),
    ]);
    // Positive control: the stack and the divider survived normalization.
    expect(rail.some((entry) => entry.kind === "stack")).toBe(true);
    expect(rail.some((entry) => entry.kind === "divider")).toBe(true);

    const result = ids(switcherCategories(rail, { chats: false }));
    expect(result.bar.slice(0, 3)).toEqual([
      "terminals",
      "git-diff",
      "browsers",
    ]);
    expect(result.more).toEqual(["chats"]);
    expect([...result.bar, ...result.more]).toHaveLength(LEFT_PANEL_IDS.length);
  });

  it("keeps every panel reachable, as a chip or under More, whatever is turned off", () => {
    const allOff = Object.fromEntries(
      LEFT_PANEL_IDS.map((panelId) => [panelId, false]),
    );
    for (const overrides of [{}, { chats: false }, allOff]) {
      const result = ids(switcherCategories(DEFAULT_RAIL, overrides));
      expect([...result.bar, ...result.more].sort()).toEqual(
        [...LEFT_PANEL_IDS].sort(),
      );
    }
  });

  it("reuses the registry's identity rather than forking the copy", () => {
    for (const definition of switcherCategories(DEFAULT_RAIL, {}).bar) {
      expect(LEFT_PANEL_DEFINITIONS).toContain(definition);
    }
  });
});
