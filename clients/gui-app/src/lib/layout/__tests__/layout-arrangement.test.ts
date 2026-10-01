import { describe, expect, it } from "vitest";
import {
  asBarRegionId,
  barClusterRegions,
  barPlacement,
  canvasOrderGroupForRegion,
  canvasOrderGroupOf,
  DEFAULT_ARRANGEMENT,
  statusBarHostsAnyRegion,
  statusBarShown,
  toggleStatusBarSurface,
  withBarHost,
  withBarSide,
  insertRailDivider,
  liveAgentsInStrip,
  moveCanvasOrderMember,
  movedWithin,
  moveRailEntry,
  moveRailPanelBeside,
  moveRailPanelToEnd,
  removeRailDivider,
  isStackedRailPanel,
  railPanelToStackBelow,
  railStackJoin,
  sideTabStripEdge,
  stackRailPanels,
  stackRailPanelWithBelow,
  unstackRail,
  unstackRailPanel,
  TOOLBAR_REGION_IDS,
  WIDE_READING_WIDTH_MAX_PX,
  WIDE_READING_WIDTH_MIN_PX,
  type LayoutArrangement,
  type SideStripView,
  type TabStripPlacement,
} from "@/lib/layout/layout-arrangement";
import {
  normalizeArrangement,
  resolvePersistedArrangement,
} from "@/lib/layout/arrangement-persist";
import {
  areRailsEqual,
  DEFAULT_RAIL,
  railDisplayEntries,
  railStackMembers,
  railStackMembersFor,
  railStackOf,
  DEFAULT_RAIL_DIVIDER_SEQ,
  normalizeRail,
  railDividerId,
  railDividerInsertIndex,
  railFromPanelIdOrder,
  panelVisibilityOverridesFromValues,
  RAIL_REGION_BY_PANEL,
  visibleRailPanelIds,
  type RailEntry,
} from "@/lib/layout/rail";
import { effectiveLayoutValues } from "@/lib/layout/layout-presets";

function panel(id: RailEntry["id"]): RailEntry {
  const entry = DEFAULT_RAIL.find(
    (candidate) => candidate.kind === "panel" && candidate.id === id,
  );
  if (entry === undefined) throw new Error(`no such rail panel: ${id}`);
  return entry;
}

function divider(id: string): RailEntry {
  return { kind: "divider", id };
}

function stack(id: string): RailEntry {
  return { kind: "stack", id };
}

/**
 * The nine panels with no link and no divider.
 *
 * What the reorder tests below are about is `placedBeside`, which places ONE
 * member by id; the shipped rail's stack (L-166) has its own describe, and
 * carrying it through every reorder assertion would say nothing extra about
 * the mover while making each expectation a line longer.
 */
const FLAT_RAIL: ReadonlyArray<RailEntry> = DEFAULT_RAIL.filter(
  (entry) => entry.kind === "panel",
);

/** The rail as the ids it holds, panels and dividers alike, in order. */
function idsOf(rail: ReadonlyArray<RailEntry>): ReadonlyArray<string> {
  return rail.map((entry) => entry.id);
}

/** Every panel the rail holds, hiding nothing. */
function panelIdsOf(rail: ReadonlyArray<RailEntry>): ReadonlyArray<string> {
  return visibleRailPanelIds(rail, () => true);
}

function withRail(rail: ReadonlyArray<RailEntry>): LayoutArrangement {
  return { ...DEFAULT_ARRANGEMENT, rail };
}

describe("the shipped rail (L-155, L-166)", () => {
  it("is the nine panels in order, with one stack and no dividers", () => {
    expect(idsOf(DEFAULT_RAIL)).toEqual([
      "railAgents",
      "stack:railAgents+railArtifacts",
      "railArtifacts",
      "railTerminals",
      "railBrowsers",
      "railGitDiff",
      "railPullRequests",
      "railFileTree",
      "railSharing",
      "railComments",
    ]);
    expect(DEFAULT_RAIL.filter((entry) => entry.kind === "divider")).toEqual(
      [],
    );
    expect(DEFAULT_RAIL.filter((entry) => entry.kind === "stack")).toEqual([
      { kind: "stack", id: "stack:railAgents+railArtifacts" },
    ]);
  });

  it("is already normal, so a rehydrate changes nothing about it", () => {
    expect(idsOf(normalizeRail(DEFAULT_RAIL))).toEqual(idsOf(DEFAULT_RAIL));
  });

  it("has used no divider seq, so the first one a user adds is divider:1", () => {
    expect(DEFAULT_RAIL_DIVIDER_SEQ).toBe(0);
    expect(DEFAULT_ARRANGEMENT.dividerSeq).toBe(0);

    const added = insertRailDivider(withRail(DEFAULT_RAIL), 3);

    expect(added.dividerSeq).toBe(1);
    expect(added.rail[3]).toEqual(divider("divider:1"));
  });

  it("reads back as the nine panel ids", () => {
    expect(panelIdsOf(DEFAULT_RAIL)).toEqual([
      "chats",
      "artifacts",
      "terminals",
      "browsers",
      "git-diff",
      "pull-requests",
      "file-tree",
      "sharing",
      "comments",
    ]);
  });
});

describe("the panels a rail draws", () => {
  it("drops the hidden ones and keeps the order of the rest", () => {
    const shown = new Set(["chats", "terminals", "comments"]);

    expect(
      visibleRailPanelIds(DEFAULT_RAIL, (panelId) => shown.has(panelId)),
    ).toEqual(["chats", "terminals", "comments"]);
  });

  it("never yields a divider, wherever one sits", () => {
    const rail = [divider("divider:1"), ...DEFAULT_RAIL, divider("divider:2")];

    expect(panelIdsOf(rail)).toEqual(panelIdsOf(DEFAULT_RAIL));
  });
});

describe("a panel moved within the rail", () => {
  // One mover for both drags (R5R-06): these are the arrangement's own
  // helpers, and `moveRailPanelBeside` is `moveCanvasOrderMember` with the
  // panel-id bijection applied, which is the same call the editor's canvas
  // drop makes.
  it("lands on the side of the anchor it was dropped", () => {
    expect(
      idsOf(
        moveRailPanelBeside(withRail(FLAT_RAIL), {
          sourcePanelId: "comments",
          targetPanelId: "chats",
          placeAfter: false,
          carry: "panel",
        }).rail,
      ),
    ).toEqual([
      "railComments",
      "railAgents",
      "railArtifacts",
      "railTerminals",
      "railBrowsers",
      "railGitDiff",
      "railPullRequests",
      "railFileTree",
      "railSharing",
    ]);
    expect(
      idsOf(
        moveRailPanelBeside(withRail(FLAT_RAIL), {
          sourcePanelId: "chats",
          targetPanelId: "terminals",
          placeAfter: true,
          carry: "panel",
        }).rail,
      ),
    ).toEqual([
      "railArtifacts",
      "railTerminals",
      "railAgents",
      "railBrowsers",
      "railGitDiff",
      "railPullRequests",
      "railFileTree",
      "railSharing",
      "railComments",
    ]);
  });

  it("steps over a divider rather than taking it along", () => {
    // Terminals dragged in front of Agents crosses the divider the user put
    // between Artifacts and Terminals; the divider keeps its place.
    const rail = [
      ...FLAT_RAIL.slice(0, 2),
      divider("divider:1"),
      ...FLAT_RAIL.slice(2),
    ];

    expect(
      idsOf(
        moveRailPanelBeside(withRail(rail), {
          sourcePanelId: "terminals",
          targetPanelId: "chats",
          placeAfter: false,
          carry: "panel",
        }).rail,
      ).slice(0, 4),
    ).toEqual(["railTerminals", "railAgents", "railArtifacts", "divider:1"]);
  });

  it("moves nothing for a panel that is not in the rail it was handed", () => {
    const arrangement = withRail(DEFAULT_RAIL.slice(0, 2));

    expect(
      moveRailPanelBeside(arrangement, {
        sourcePanelId: "comments",
        targetPanelId: "chats",
        placeAfter: false,
        carry: "panel",
      }).rail,
    ).toBe(arrangement.rail);
    expect(
      moveRailPanelBeside(arrangement, {
        sourcePanelId: "chats",
        targetPanelId: "comments",
        placeAfter: false,
        carry: "panel",
      }).rail,
    ).toBe(arrangement.rail);
    expect(
      moveRailPanelBeside(arrangement, {
        sourcePanelId: "chats",
        targetPanelId: "chats",
        placeAfter: true,
        carry: "panel",
      }).rail,
    ).toBe(arrangement.rail);
    expect(moveRailPanelToEnd(arrangement, "comments", "panel")).toBe(
      arrangement,
    );
  });
});

describe("where Add divider puts one (L-159)", () => {
  it("is immediately before the last panel, never after it", () => {
    expect(railDividerInsertIndex(DEFAULT_RAIL)).toBe(DEFAULT_RAIL.length - 1);

    const added = insertRailDivider(
      withRail(DEFAULT_RAIL),
      railDividerInsertIndex(DEFAULT_RAIL),
    );

    expect(idsOf(added.rail).slice(-3)).toEqual([
      "railSharing",
      "divider:1",
      "railComments",
    ]);
  });

  it("looks past a divider already parked at the tail", () => {
    const rail = [...DEFAULT_RAIL, divider("divider:1")];

    // The last ENTRY is a divider, so the index is the last PANEL's - a second
    // divider added beside the first would space nothing either.
    expect(railDividerInsertIndex(rail)).toBe(rail.length - 2);
  });

  it("falls back to the end for a rail holding no panel at all", () => {
    const rail = [divider("divider:1")];

    expect(railDividerInsertIndex(rail)).toBe(1);
  });
});

describe("areRailsEqual", () => {
  it("compares the entries in order, kind and id", () => {
    expect(areRailsEqual(DEFAULT_RAIL, [...DEFAULT_RAIL])).toBe(true);
    expect(areRailsEqual(DEFAULT_RAIL, DEFAULT_RAIL.slice(0, 8))).toBe(false);
    expect(
      areRailsEqual(DEFAULT_RAIL, [
        ...DEFAULT_RAIL.slice(0, 2),
        divider("divider:1"),
        ...DEFAULT_RAIL.slice(2),
      ]),
    ).toBe(false);
    expect(
      areRailsEqual(
        DEFAULT_RAIL,
        moveRailPanelBeside(withRail(FLAT_RAIL), {
          sourcePanelId: "comments",
          targetPanelId: "chats",
          placeAfter: false,
          carry: "panel",
        }).rail,
      ),
    ).toBe(false);
  });
});

describe("railFromPanelIdOrder", () => {
  it("keeps the order it is handed, drops an id this build does not know and puts back one it never named", () => {
    const rail = railFromPanelIdOrder(["comments", "not-a-panel", "chats"]);

    // Comments stays ahead of Agents as handed; every panel the order never
    // named lands after its canonical neighbour, and no divider appears.
    expect(idsOf(rail)).toEqual([
      "railComments",
      "railAgents",
      "railArtifacts",
      "railTerminals",
      "railBrowsers",
      "railGitDiff",
      "railPullRequests",
      "railFileTree",
      "railSharing",
    ]);
  });
});

describe("normalizeRail", () => {
  it("re-inserts a panel the stored rail never named beside its neighbours", () => {
    const stored = DEFAULT_RAIL.filter(
      (entry) => !(entry.kind === "panel" && entry.id === "railGitDiff"),
    );

    const rail = normalizeRail(stored);
    const panelIds = rail.flatMap((entry) =>
      entry.kind === "panel" ? [entry.id] : [],
    );

    expect(panelIds).toEqual(
      DEFAULT_RAIL.flatMap((entry) =>
        entry.kind === "panel" ? [entry.id] : [],
      ),
    );
    // Beside Browsers, where it belongs - not appended after Comments.
    expect(panelIdsOf(rail).indexOf("git-diff")).toBe(
      panelIdsOf(rail).indexOf("browsers") + 1,
    );
  });

  it("keeps a divider at the head and one at the tail (R5R-13)", () => {
    // What CHANGED with L-155: an edge divider used to be inert, because the
    // old group view dropped a boundary with nothing on one side of it. The
    // rail now draws every divider it holds, so normalizing must not quietly
    // eat the two the user is most likely to have parked.
    const rail = normalizeRail([
      divider("divider:20"),
      ...DEFAULT_RAIL,
      divider("divider:21"),
    ]);

    expect(idsOf(rail).at(0)).toBe("divider:20");
    expect(idsOf(rail).at(-1)).toBe("divider:21");
    expect(panelIdsOf(rail)).toEqual(panelIdsOf(DEFAULT_RAIL));
  });

  it("drops a divider whose id is not one this rail could have issued", () => {
    const rail = normalizeRail([
      { kind: "divider", id: "separator:1" },
      ...DEFAULT_RAIL.slice(0, 2),
      divider("divider:5"),
      ...DEFAULT_RAIL.slice(2),
    ]);

    // Only the `divider:` prefix survives: `highestDividerSeq` reads the
    // number off that prefix, so an id it cannot parse would leave the seq
    // free to reissue an id already on screen.
    expect(idsOf(rail)).not.toContain("separator:1");
    expect(idsOf(rail)).toContain("divider:5");
  });

  it("drops a duplicate panel and a duplicate divider", () => {
    const rail = normalizeRail([
      panel("railAgents"),
      panel("railAgents"),
      divider("divider:1"),
      divider("divider:1"),
      panel("railArtifacts"),
    ]);

    expect(
      rail.filter(
        (entry) => entry.kind === "panel" && entry.id === "railAgents",
      ),
    ).toHaveLength(1);
    expect(rail.filter((entry) => entry.kind === "divider")).toHaveLength(1);
  });
});

describe("the rail's move helpers", () => {
  it("moves a panel to a new index, dividers and all", () => {
    const withDivider = insertRailDivider(withRail(FLAT_RAIL), 2);
    const arrangement = moveRailEntry(withDivider, "railTerminals", 2);

    expect(idsOf(arrangement.rail).slice(0, 4)).toEqual([
      "railAgents",
      "railArtifacts",
      "railTerminals",
      "divider:1",
    ]);
  });

  it("removes a divider and leaves the panels where they were", () => {
    const withDivider = insertRailDivider(withRail(FLAT_RAIL), 2);
    const arrangement = removeRailDivider(withDivider, "divider:1");

    expect(idsOf(arrangement.rail)).toEqual(idsOf(FLAT_RAIL));
    // The seq does not go back: a removed id is never reissued.
    expect(arrangement.dividerSeq).toBe(1);
  });

  it("gives every new divider an id no divider has held", () => {
    const first = insertRailDivider(withRail(DEFAULT_RAIL), 2);
    const removed = removeRailDivider(first, "divider:1");
    const second = insertRailDivider(removed, 1);

    expect(second.dividerSeq).toBe(2);
    expect(second.rail[1]).toEqual(divider("divider:2"));
    expect(
      second.rail.some(
        (entry) => entry.kind === "divider" && entry.id === "divider:1",
      ),
    ).toBe(false);
  });

  it("leaves the rail alone when the dragged entry is not in it", () => {
    const arrangement = withRail(DEFAULT_RAIL);

    expect(moveRailEntry(arrangement, "railNowhere", 0)).toBe(arrangement);
    expect(removeRailDivider(arrangement, "divider:99")).toBe(arrangement);
  });

  it("clamps a drop past the end of the rail", () => {
    const arrangement = moveRailEntry(withRail(DEFAULT_RAIL), "railAgents", 99);

    expect(arrangement.rail.at(-1)).toEqual(panel("railAgents"));
    expect(arrangement.rail).toHaveLength(DEFAULT_RAIL.length);
  });
});

describe("movedWithin", () => {
  it("takes an item out and puts it back at the index asked for", () => {
    expect(movedWithin(["a", "b", "c"], 0, 2)).toEqual(["b", "c", "a"]);
    expect(movedWithin(["a", "b", "c"], 2, 0)).toEqual(["c", "a", "b"]);
    expect(movedWithin(["a", "b", "c"], 1, 1)).toEqual(["a", "b", "c"]);
  });

  it("clamps either end, and leaves a list it cannot index alone", () => {
    expect(movedWithin(["a", "b", "c"], 0, 99)).toEqual(["b", "c", "a"]);
    expect(movedWithin(["a", "b", "c"], 2, -5)).toEqual(["c", "a", "b"]);
    const list = ["a", "b"];
    expect(movedWithin(list, 7, 0)).toBe(list);
  });
});

describe("a canvas drop written back into the full order (4.7)", () => {
  const arrangement: LayoutArrangement = {
    ...DEFAULT_ARRANGEMENT,
    toolbarLeft: ["attachImage", "access", "mic"],
  };

  it("puts the dragged member on the side of the anchor it was dropped", () => {
    expect(
      moveCanvasOrderMember({
        arrangement,
        group: "toolbarLeft",
        fromId: "attachImage",
        toId: "mic",
        placeAfter: true,
      }).toolbarLeft,
    ).toEqual(["access", "mic", "attachImage"]);
    expect(
      moveCanvasOrderMember({
        arrangement,
        group: "toolbarLeft",
        fromId: "mic",
        toId: "attachImage",
        placeAfter: false,
      }).toolbarLeft,
    ).toEqual(["mic", "attachImage", "access"]);
  });

  it("moves nothing for an id this build does not know", () => {
    expect(
      moveCanvasOrderMember({
        arrangement,
        group: "toolbarLeft",
        fromId: "somethingElse",
        toId: "mic",
        placeAfter: true,
      }).toolbarLeft,
    ).toBe(arrangement.toolbarLeft);
    expect(
      moveCanvasOrderMember({
        arrangement,
        group: "toolbarLeft",
        fromId: "attachImage",
        toId: "somethingElse",
        placeAfter: true,
      }).toolbarLeft,
    ).toBe(arrangement.toolbarLeft);
  });

  it("moves a rail panel past a divider the user placed", () => {
    const withDivider = insertRailDivider(withRail(FLAT_RAIL), 2);
    const next = moveCanvasOrderMember({
      arrangement: withDivider,
      group: "rail",
      fromId: "railArtifacts",
      toId: railDividerId(1),
      placeAfter: true,
    });

    expect(idsOf(next.rail).slice(0, 4)).toEqual([
      "railAgents",
      "divider:1",
      "railArtifacts",
      "railTerminals",
    ]);
  });

  it("moves a rail DIVIDER, which is how a gap is re-placed", () => {
    const withDivider = insertRailDivider(withRail(FLAT_RAIL), 2);
    const next = moveCanvasOrderMember({
      arrangement: withDivider,
      group: "rail",
      fromId: railDividerId(1),
      toId: "railTerminals",
      placeAfter: true,
    });

    expect(idsOf(next.rail).slice(0, 4)).toEqual([
      "railAgents",
      "railArtifacts",
      "railTerminals",
      "divider:1",
    ]);
  });

  it("writes back only the group the drop was in", () => {
    const next = moveCanvasOrderMember({
      arrangement,
      group: "dock",
      fromId: "changedFiles",
      toId: "runningAgents",
      placeAfter: true,
    });

    expect(next.dock).toEqual([
      "todo",
      "runningAgents",
      "changedFiles",
      "background",
    ]);
    expect(next.toolbarLeft).toBe(arrangement.toolbarLeft);
    expect(next.rail).toBe(arrangement.rail);
  });
});

describe("which regions a canvas drag can pick up", () => {
  it("puts every dock and toolbar region in its own cluster", () => {
    for (const regionId of DEFAULT_ARRANGEMENT.dock)
      expect(canvasOrderGroupForRegion(regionId)).toBe("dock");
    for (const regionId of DEFAULT_ARRANGEMENT.toolbarLeft)
      expect(canvasOrderGroupForRegion(regionId)).toBe("toolbarLeft");
    for (const regionId of DEFAULT_ARRANGEMENT.toolbarRight)
      expect(canvasOrderGroupForRegion(regionId)).toBe("toolbarRight");
  });

  it("names every toolbar region exactly once across the two clusters", () => {
    expect(
      [
        ...DEFAULT_ARRANGEMENT.toolbarLeft,
        ...DEFAULT_ARRANGEMENT.toolbarRight,
      ].sort(),
    ).toEqual([...TOOLBAR_REGION_IDS].sort());
  });

  it("puts every rail panel in the rail's cluster (L-115)", () => {
    for (const entry of DEFAULT_RAIL) {
      if (entry.kind !== "panel") continue;
      expect(canvasOrderGroupForRegion(entry.id)).toBe("rail");
    }
  });

  it("refuses a region reordered in the inspector's list only", () => {
    // The usage providers are segments inside one region, so they carry no
    // identity of their own on the canvas to place by.
    expect(canvasOrderGroupForRegion("usageLimits")).toBeNull();
    expect(canvasOrderGroupForRegion("minimap")).toBeNull();
  });

  it("reads a group back off an element, and refuses anything else", () => {
    // The rail's dividers are members with no region id, so the group a press
    // belongs to is read off the attribute rather than from a region.
    expect(canvasOrderGroupOf("rail")).toBe("rail");
    expect(canvasOrderGroupOf("dock")).toBe("dock");
    expect(canvasOrderGroupOf("usageProviders")).toBeNull();
    expect(canvasOrderGroupOf("")).toBeNull();
  });
});

describe("normalizeArrangement", () => {
  it("keeps the divider counter ahead of the ids the rail is using", () => {
    const arrangement = normalizeArrangement(
      withRail([...DEFAULT_RAIL, divider("divider:42")]),
    );

    expect(arrangement.dividerSeq).toBe(42);
  });

  it("puts a toolbar region dropped into the wrong cluster back on the right", () => {
    const arrangement = normalizeArrangement({
      ...DEFAULT_ARRANGEMENT,
      toolbarLeft: ["model", "attachImage", "access"],
      toolbarRight: ["mic"],
    });

    expect(arrangement.toolbarLeft).toEqual(["attachImage", "access"]);
    // Re-inserted at its canonical position rather than appended after `mic`.
    expect(arrangement.toolbarRight).toEqual(["model", "mic"]);
  });

  it("re-inserts a dock row the arrangement lost", () => {
    const arrangement = normalizeArrangement({
      ...DEFAULT_ARRANGEMENT,
      dock: ["background"],
    });

    expect(arrangement.dock).toEqual([
      "todo",
      "changedFiles",
      "runningAgents",
      "background",
    ]);
  });

  it("hands an already-normal arrangement straight back, by identity", () => {
    // Every write path ends here, so a no-op write - a drag that lands where
    // it started, a bulk clear that changed nothing - must not mint a new
    // object: a fresh `arrangement` invalidates every selector subscribed to
    // any field of it, which is the whole chrome (G1-21).
    const arrangement = normalizeArrangement(DEFAULT_ARRANGEMENT);

    expect(arrangement).toBe(DEFAULT_ARRANGEMENT);
    expect(normalizeArrangement(arrangement)).toBe(arrangement);
  });

  it("re-inserts every panel when the stored rail has none left", () => {
    // An empty rail is a corrupt record, not a user preference: the sidebar
    // would have no icons at all, and no gesture in the editor can produce it.
    const arrangement = normalizeArrangement(withRail([]));

    expect(arrangement.rail).toEqual(
      DEFAULT_RAIL.filter((entry) => entry.kind === "panel"),
    );
  });

  it("drops an Automatic providerLimits entry and keeps a drawn one", () => {
    const arrangement = normalizeArrangement({
      ...DEFAULT_ARRANGEMENT,
      providerLimits: {
        codex: { limitKeys: [] },
        grok: { limitKeys: ["weekly"] },
      },
    });

    expect(arrangement.providerLimits).toEqual({
      grok: { limitKeys: ["weekly"] },
    });
  });

  it("keeps providerLimits by identity when there is nothing Automatic to drop", () => {
    const providerLimits = { grok: { limitKeys: ["weekly"] } };
    const arrangement = normalizeArrangement({
      ...DEFAULT_ARRANGEMENT,
      providerLimits,
    });

    expect(arrangement.providerLimits).toBe(providerLimits);
  });
});

describe("the rail's three-state visibility (L-47, L-61)", () => {
  it("reads the sparse map: hidden always, shown only where Auto exists", () => {
    const values = effectiveLayoutValues("default", {
      // A plain panel's own rule IS shown, so setting it to `shown` is a
      // no-op and stays absent from the map; only `hidden` is a real pick.
      railSharing: { shown: "hidden" },
      // Pull requests and Comments can leave the rail on their own rule, so
      // pinning either one `shown` is a real pick and belongs in the map.
      railPullRequests: { shown: "shown" },
      railComments: { shown: "hidden" },
    });

    expect(panelVisibilityOverridesFromValues(values)).toEqual({
      sharing: false,
      "pull-requests": true,
      comments: false,
    });
  });

  it("names every rail region, so a panel added later cannot be silently absent", () => {
    const values = effectiveLayoutValues(
      "default",
      Object.fromEntries(
        Object.values(RAIL_REGION_BY_PANEL).map((regionId) => [
          regionId,
          { shown: "hidden" },
        ]),
      ),
    );

    expect(
      Object.keys(panelVisibilityOverridesFromValues(values)).sort(),
    ).toEqual(Object.keys(RAIL_REGION_BY_PANEL).sort());
  });
});

describe("resolvePersistedArrangement", () => {
  it("keeps a stored side and host and drops a value this build has no case for", () => {
    const arrangement = resolvePersistedArrangement({
      usageHost: "header",
      usageSide: "right",
      resourceHost: "sideways",
      minimapSide: "left",
      resourceSide: "sideways",
      mobileFooter: true,
    });

    expect(arrangement.usageHost).toBe("header");
    expect(arrangement.usageSide).toBe("right");
    expect(arrangement.minimapSide).toBe("left");
    // The feature is unreleased, so there is no migration (P5): a value this
    // build cannot read is the DEFAULT for that field alone, and the three
    // fields beside it keep what they were given.
    expect(arrangement.resourceHost).toBe(DEFAULT_ARRANGEMENT.resourceHost);
    expect(arrangement.resourceSide).toBe(DEFAULT_ARRANGEMENT.resourceSide);
    expect(arrangement.mobileFooter).toBe(true);
  });

  /**
   * L-161: a record the SHIPPED build wrote carries `usageHost` and no split
   * fields, and under that build `usageHost: "header"` meant both readings up,
   * no strip at all, and the pair drawn at the right end of the top bar. The
   * read carries that meaning rather than landing the user on today's
   * per-region defaults, which would hand them back a status bar they do not
   * have and move their gauge across the window.
   */
  it("reads a pre-split record as the arrangement it meant", () => {
    const arrangement = resolvePersistedArrangement({
      usageHost: "header",
      resourceSide: "right",
      minimapSide: "right",
      mobileFooter: false,
    });

    expect(barPlacement(arrangement, "usageLimits")).toEqual({
      host: "header",
      side: "right",
    });
    expect(barPlacement(arrangement, "resourceMonitor").host).toBe("header");
    expect(statusBarHostsAnyRegion(arrangement)).toBe(false);
  });

  it("leaves a pre-split record that kept the strip exactly where it was", () => {
    const arrangement = resolvePersistedArrangement({
      usageHost: "status-bar",
      resourceSide: "left",
    });

    expect(barPlacement(arrangement, "usageLimits")).toEqual({
      host: "status-bar",
      side: "left",
    });
    expect(barPlacement(arrangement, "resourceMonitor")).toEqual({
      host: "status-bar",
      side: "left",
    });
  });

  it("carries nothing once the record answers for itself", () => {
    // A record written by THIS build with the gauge up and the readout down:
    // the carry must not fire, or the split it stores would be undone on
    // every start.
    const arrangement = resolvePersistedArrangement({
      usageHost: "header",
      usageSide: "left",
      resourceHost: "status-bar",
      resourceSide: "right",
    });

    expect(arrangement.usageSide).toBe("left");
    expect(arrangement.resourceHost).toBe("status-bar");
  });

  it("keeps only the parked ids it has readings for", () => {
    expect(
      resolvePersistedArrangement({ statusBarParked: ["usageLimits", "nope"] })
        .statusBarParked,
    ).toEqual(["usageLimits"]);
    expect(
      resolvePersistedArrangement({ statusBarParked: "both" }).statusBarParked,
    ).toEqual([]);
  });

  /**
   * The direction L-142 opened: a dock order written before Todo was a member
   * has three entries and this build has four. No migration exists and none
   * is wanted (P5) - `mergeOrder` against `DEFAULT_DOCK_ORDER` is the whole of
   * it.
   *
   * Todo leads, because that is where `ChatLowerDock` already draws it and a
   * stored order says nothing about a member it never had: the person whose
   * record this is has been looking at Todo above the rest, and nothing
   * about opening a newer build should move it. Message queue is never one
   * of these entries at all (G1-G2) - it is not a dock region, so no stored
   * order ever names it and `mergeOrder` never has to reason about it.
   *
   * And it is NEIGHBOUR placement rather than an append, which is the rule
   * `mergeOrder` states for every order field this app stores: a member the
   * stored list never had lands after the canonical id ahead of it that is
   * actually present. Todo has none - it opens the canonical list - so it
   * lands at the front whatever the user did with the other three. A
   * rearranged dock is what tells that apart from a plain append: the three
   * rows below keep the order they were given.
   */
  it("lands them at the front of a rearranged dock, rows undisturbed", () => {
    const arrangement = resolvePersistedArrangement({
      dock: ["background", "changedFiles", "runningAgents"],
    });

    expect(arrangement.dock).toEqual([
      "todo",
      "background",
      "changedFiles",
      "runningAgents",
    ]);
  });

  /**
   * The unreleased-feature rule in the one place a retired region can still
   * arrive: a blob written while `agent` existed (L-136). Tolerant parsing,
   * not migration - the id is simply not one `TOOLBAR_REGION_IDS` names, so it
   * never reaches an arrangement, and the members around it keep the order the
   * user gave them.
   */
  it("drops a toolbar region this build retired and keeps the rest in stored order", () => {
    const arrangement = resolvePersistedArrangement({
      toolbarLeft: ["access", "agent", "attachImage"],
      toolbarRight: ["model", "mic"],
    });

    expect(arrangement.toolbarLeft).toEqual(["access", "attachImage"]);
    expect(arrangement.toolbarRight).toEqual(["model", "mic"]);
  });

  it("materialises every provider and keeps the order the stored pair had", () => {
    const arrangement = resolvePersistedArrangement({
      usageProviders: ["grok", "codex", "not-a-provider"],
      hiddenProviders: ["codex", "not-a-provider"],
    });

    expect(arrangement.usageProviders.indexOf("grok")).toBeLessThan(
      arrangement.usageProviders.indexOf("codex"),
    );
    expect(arrangement.usageProviders).toHaveLength(
      DEFAULT_ARRANGEMENT.usageProviders.length,
    );
    expect(arrangement.hiddenProviders).toEqual(["codex"]);
  });

  it("keeps a drawable limit selection and drops an Automatic one entirely", () => {
    // The `automatic` booleans are what a record written before R1-15 carries.
    // They are ignored rather than rejected: the only thing that field ever
    // said was whether the list was empty, and the list says it. An entry
    // that resolves to Automatic is then normalized away, since Automatic IS
    // the absent key.
    const arrangement = resolvePersistedArrangement({
      providerLimits: {
        codex: { automatic: false, limitKeys: ["weekly"] },
        grok: { automatic: false, limitKeys: [] },
        nobody: { automatic: true, limitKeys: [] },
      },
    });

    expect(arrangement.providerLimits).toEqual({
      codex: { limitKeys: ["weekly"] },
    });
  });

  it("drops a host whose every provider resolved to nothing checked", () => {
    const arrangement = resolvePersistedArrangement({
      shownProfiles: {
        "host-1": { codex: ["profile-1", null], nobody: ["profile-2"] },
        "host-2": { codex: [] },
      },
    });

    expect(arrangement.shownProfiles).toEqual({
      "host-1": { codex: ["profile-1", null] },
    });
  });

  it("reads a stored rail and re-inserts what this build added to it", () => {
    const arrangement = resolvePersistedArrangement({
      rail: [
        { kind: "panel", id: "railAgents" },
        { kind: "panel", id: "railRetired" },
        { kind: "divider", id: "divider:4" },
        { kind: "panel", id: "railComments" },
      ],
      dividerSeq: 1,
    });

    // Every panel is back, each beside its canonical neighbour, so a panel
    // this build added lands next to the one it belongs after rather than
    // piling up at the end. The stored divider survives with its id.
    expect(
      arrangement.rail.filter((entry) => entry.kind === "panel"),
    ).toHaveLength(9);
    expect(idsOf(arrangement.rail)).toEqual([
      "railAgents",
      "railArtifacts",
      "railTerminals",
      "railBrowsers",
      "railGitDiff",
      "railPullRequests",
      "railFileTree",
      "railSharing",
      "divider:4",
      "railComments",
    ]);
    expect(arrangement.dividerSeq).toBe(4);
  });
});

/**
 * L-156: usage limits and the resource monitor each pick a bar and an end of
 * it, and moving one never moves the other. The shipped answer is the frame
 * the app has always drawn - usage on the left of the strip, the readout on
 * its right - so a user who never opens the editor sees no change at all.
 */
describe("the two bar readings (L-156)", () => {
  it("moves one reading without touching the other, on either axis", () => {
    const usageUp = withBarHost(DEFAULT_ARRANGEMENT, "usageLimits", "header");

    expect(barPlacement(usageUp, "usageLimits").host).toBe("header");
    expect(barPlacement(usageUp, "resourceMonitor")).toEqual(
      barPlacement(DEFAULT_ARRANGEMENT, "resourceMonitor"),
    );

    const monitorLeft = withBarSide(usageUp, "resourceMonitor", "left");

    expect(barPlacement(monitorLeft, "resourceMonitor")).toEqual({
      host: "status-bar",
      side: "left",
    });
    expect(barPlacement(monitorLeft, "usageLimits")).toEqual(
      barPlacement(usageUp, "usageLimits"),
    );
  });

  it("answers each of the four clusters with what it holds", () => {
    expect(
      barClusterRegions(DEFAULT_ARRANGEMENT, "status-bar", "left"),
    ).toEqual(["usageLimits"]);
    expect(
      barClusterRegions(DEFAULT_ARRANGEMENT, "status-bar", "right"),
    ).toEqual(["resourceMonitor"]);
    expect(barClusterRegions(DEFAULT_ARRANGEMENT, "header", "left")).toEqual(
      [],
    );
    expect(barClusterRegions(DEFAULT_ARRANGEMENT, "header", "right")).toEqual(
      [],
    );
  });

  it("puts usage limits first wherever the two share a bar and a side", () => {
    // Reached from the monitor's side rather than by writing both, so the
    // order is the MODEL's and not the order the fields were written in.
    const shareLeft = withBarSide(
      DEFAULT_ARRANGEMENT,
      "resourceMonitor",
      "left",
    );
    expect(barClusterRegions(shareLeft, "status-bar", "left")).toEqual([
      "usageLimits",
      "resourceMonitor",
    ]);

    const shareHeaderRight = withBarHost(
      withBarHost(
        withBarSide(DEFAULT_ARRANGEMENT, "usageLimits", "right"),
        "usageLimits",
        "header",
      ),
      "resourceMonitor",
      "header",
    );
    expect(barClusterRegions(shareHeaderRight, "header", "right")).toEqual([
      "usageLimits",
      "resourceMonitor",
    ]);
  });

  it("keeps the strip on screen for as long as either reading is in it", () => {
    const usageUp = withBarHost(DEFAULT_ARRANGEMENT, "usageLimits", "header");
    const bothUp = withBarHost(usageUp, "resourceMonitor", "header");

    expect(statusBarHostsAnyRegion(DEFAULT_ARRANGEMENT)).toBe(true);
    expect(statusBarHostsAnyRegion(usageUp)).toBe(true);
    expect(statusBarHostsAnyRegion(bothUp)).toBe(false);

    expect(statusBarShown(usageUp, false)).toBe(true);
    expect(statusBarShown(bothUp, false)).toBe(false);
    // A mobile viewport answers with its own switch and ignores both hosts
    // (L-51), which L-156 does not touch.
    expect(statusBarShown(DEFAULT_ARRANGEMENT, true)).toBe(false);
    expect(statusBarShown({ ...bothUp, mobileFooter: true }, true)).toBe(true);
  });

  it("names the two readings and nothing else", () => {
    expect(asBarRegionId("usageLimits")).toBe("usageLimits");
    expect(asBarRegionId("resourceMonitor")).toBe("resourceMonitor");
    expect(asBarRegionId("minimap")).toBe(null);
    expect(asBarRegionId("not-a-region")).toBe(null);
  });
});

/**
 * L-160: "Toggle status bar" is its own inverse. It sends whatever the strip
 * holds to the header and remembers that set; the next press brings exactly
 * that set back. The arrangement L-156 exists to let a person build - one
 * reading up, one down - survives the round trip instead of being flattened.
 */
describe("the status bar surface toggle (L-160)", () => {
  it("empties the strip, then fills it back the same way", () => {
    const parked = toggleStatusBarSurface(DEFAULT_ARRANGEMENT);

    expect(statusBarHostsAnyRegion(parked)).toBe(false);
    expect(parked.statusBarParked).toEqual(["usageLimits", "resourceMonitor"]);

    const back = toggleStatusBarSurface(parked);

    expect(barPlacement(back, "usageLimits")).toEqual(
      barPlacement(DEFAULT_ARRANGEMENT, "usageLimits"),
    );
    expect(barPlacement(back, "resourceMonitor")).toEqual(
      barPlacement(DEFAULT_ARRANGEMENT, "resourceMonitor"),
    );
    expect(back.statusBarParked).toEqual([]);
  });

  it("leaves a mixed arrangement exactly as it found it after two presses", () => {
    // The gauge up on the right, the readout still in the strip: the whole
    // point of L-156, and what a lossy toggle flattened on the second press.
    const mixed = withBarSide(
      withBarHost(DEFAULT_ARRANGEMENT, "usageLimits", "header"),
      "usageLimits",
      "right",
    );

    const parked = toggleStatusBarSurface(mixed);
    expect(statusBarHostsAnyRegion(parked)).toBe(false);
    expect(parked.statusBarParked).toEqual(["resourceMonitor"]);

    const back = toggleStatusBarSurface(parked);
    expect(barPlacement(back, "usageLimits")).toEqual(
      barPlacement(mixed, "usageLimits"),
    );
    expect(barPlacement(back, "resourceMonitor")).toEqual(
      barPlacement(mixed, "resourceMonitor"),
    );
    expect(back.statusBarParked).toEqual([]);
  });

  it("makes three presses the same as one", () => {
    const mixed = withBarHost(DEFAULT_ARRANGEMENT, "usageLimits", "header");
    const once = toggleStatusBarSurface(mixed);
    const thrice = toggleStatusBarSurface(
      toggleStatusBarSurface(toggleStatusBarSurface(mixed)),
    );

    expect(thrice).toEqual(once);
  });

  it("brings both down when an emptied strip remembers nothing", () => {
    // The strip emptied some other way - the region rows, the strip's own
    // menu - so there is no remembered set to restore and "show the status
    // bar" can only mean both.
    const empty = withBarHost(
      withBarHost(DEFAULT_ARRANGEMENT, "usageLimits", "header"),
      "resourceMonitor",
      "header",
    );

    const back = toggleStatusBarSurface(empty);

    expect(barPlacement(back, "usageLimits").host).toBe("status-bar");
    expect(barPlacement(back, "resourceMonitor").host).toBe("status-bar");
  });

  it("never moves a reading to the other end of its bar", () => {
    const sided = withBarSide(
      withBarSide(DEFAULT_ARRANGEMENT, "usageLimits", "right"),
      "resourceMonitor",
      "left",
    );
    const round = toggleStatusBarSurface(toggleStatusBarSurface(sided));

    expect([round.usageSide, round.resourceSide]).toEqual(["right", "left"]);
  });
});

describe("a stack link, normalised (L-166)", () => {
  it("is dropped when one of its panels moves away", () => {
    const moved = moveRailPanelBeside(withRail(DEFAULT_RAIL), {
      sourcePanelId: "artifacts",
      targetPanelId: "comments",
      placeAfter: true,
      carry: "panel",
    }).rail;

    expect(idsOf(normalizeRail(moved))).toEqual([
      "railAgents",
      "railTerminals",
      "railBrowsers",
      "railGitDiff",
      "railPullRequests",
      "railFileTree",
      "railSharing",
      "railComments",
      "railArtifacts",
    ]);
  });

  it("survives its two panels trading places, re-minted for the current order (G3)", () => {
    // Artifacts and Agents have swapped physical places, but the link still
    // names them in their SHIPPED order. The pair is a view group (G3), and
    // reordering its members is how the user picks which icon the rail shows
    // - so the join is not read as "broken", it is re-minted for the order
    // the two panels now stand in.
    const traded = [
      panel("railArtifacts"),
      panel("railAgents"),
      stack("stack:railAgents+railArtifacts"),
      ...FLAT_RAIL.slice(2),
    ];

    expect(idsOf(normalizeRail(traded))).toEqual([
      "railArtifacts",
      "stack:railArtifacts+railAgents",
      "railAgents",
      ...idsOf(FLAT_RAIL).slice(2),
    ]);
  });

  it("is put back between its pair when the record left it somewhere else", () => {
    // A link names the pair it joins, so where the stored blob happened to put
    // the entry says nothing: the pair is still adjacent, so the join is the
    // user's and survives, drawn where it belongs.
    expect(
      idsOf(
        normalizeRail([stack("stack:railAgents+railArtifacts"), ...FLAT_RAIL]),
      ),
    ).toEqual(idsOf(DEFAULT_RAIL));
  });

  it("is broken by a divider between its two panels", () => {
    const parted = [
      FLAT_RAIL[0],
      stack("stack:railAgents+railArtifacts"),
      divider("divider:1"),
      ...FLAT_RAIL.slice(1),
    ];

    expect(idsOf(normalizeRail(parted))).toEqual([
      "railAgents",
      "divider:1",
      ...idsOf(FLAT_RAIL).slice(1),
    ]);
  });

  it("refuses a run of three: the second link on a claimed panel is dropped", () => {
    const three = [
      FLAT_RAIL[0],
      stack("stack:railAgents+railArtifacts"),
      FLAT_RAIL[1],
      stack("stack:railArtifacts+railTerminals"),
      ...FLAT_RAIL.slice(2),
    ];

    expect(idsOf(normalizeRail(three))).toEqual(idsOf(DEFAULT_RAIL));
  });

  it("is dropped when its id is not a pair this build can read", () => {
    const foreign = [
      FLAT_RAIL[0],
      stack("stack:railAgents"),
      ...FLAT_RAIL.slice(1),
    ];

    expect(idsOf(normalizeRail(foreign))).toEqual(idsOf(FLAT_RAIL));
  });

  it("survives a persisted round trip", () => {
    const stored: unknown = JSON.parse(
      JSON.stringify({ ...DEFAULT_ARRANGEMENT, rail: DEFAULT_RAIL }),
    );

    expect(idsOf(resolvePersistedArrangement(stored).rail)).toEqual(
      idsOf(DEFAULT_RAIL),
    );
  });
});

describe("stacking and unstacking (L-168)", () => {
  it("puts the dragged panel directly below the one it was dropped on", () => {
    const stacked = stackRailPanels(
      withRail(DEFAULT_RAIL),
      "terminals",
      "browsers",
      "panel",
    );

    expect(idsOf(normalizeRail(stacked.rail))).toEqual([
      "railAgents",
      "stack:railAgents+railArtifacts",
      "railArtifacts",
      "railBrowsers",
      "stack:railBrowsers+railTerminals",
      "railTerminals",
      "railGitDiff",
      "railPullRequests",
      "railFileTree",
      "railSharing",
      "railComments",
    ]);
  });

  it("joins a target that is already stacked, growing the stack, instead of refusing it (L-181)", () => {
    const arrangement = withRail(DEFAULT_RAIL);
    const expected = [
      "railAgents",
      "stack:railAgents+railArtifacts+railTerminals",
      "railArtifacts",
      "railTerminals",
      "railBrowsers",
      "railGitDiff",
      "railPullRequests",
      "railFileTree",
      "railSharing",
      "railComments",
    ];

    expect(
      idsOf(
        normalizeRail(
          stackRailPanels(arrangement, "terminals", "artifacts", "panel").rail,
        ),
      ),
    ).toEqual(expected);
    // Either existing member is an equally good target: the new one lands in
    // the same place either way.
    expect(
      idsOf(
        normalizeRail(
          stackRailPanels(arrangement, "terminals", "chats", "panel").rail,
        ),
      ),
    ).toEqual(expected);
    // A panel onto itself is refused (`railStackJoin` answers `same`).
    expect(stackRailPanels(arrangement, "chats", "chats", "panel")).toBe(
      arrangement,
    );
  });

  it("refuses a target whose stack already holds the max, with the `full` cue (L-181)", () => {
    const fourMember: ReadonlyArray<RailEntry> = [
      panel("railAgents"),
      stack("stack:railAgents+railArtifacts+railTerminals+railBrowsers"),
      panel("railArtifacts"),
      panel("railTerminals"),
      panel("railBrowsers"),
      ...FLAT_RAIL.slice(4),
    ];
    const arrangement = withRail(fourMember);

    expect(railStackJoin(arrangement.rail, "git-diff", "chats", "panel")).toBe(
      "full",
    );
    expect(
      railStackJoin(arrangement.rail, "git-diff", "artifacts", "panel"),
    ).toBe("full");
    expect(stackRailPanels(arrangement, "git-diff", "chats", "panel")).toBe(
      arrangement,
    );
  });

  it("builds up to a 4-member stack one join at a time, then refuses the 5th", () => {
    let arrangement = withRail(DEFAULT_RAIL);
    arrangement = stackRailPanels(
      arrangement,
      "terminals",
      "artifacts",
      "panel",
    );
    arrangement = stackRailPanels(
      arrangement,
      "browsers",
      "artifacts",
      "panel",
    );

    expect(idsOf(normalizeRail(arrangement.rail))).toEqual([
      "railAgents",
      "stack:railAgents+railArtifacts+railTerminals+railBrowsers",
      "railArtifacts",
      "railTerminals",
      "railBrowsers",
      "railGitDiff",
      "railPullRequests",
      "railFileTree",
      "railSharing",
      "railComments",
    ]);

    expect(stackRailPanels(arrangement, "git-diff", "chats", "panel")).toBe(
      arrangement,
    );
  });

  it("lets a stacked SOURCE leave its pair and join a new one (L-170)", () => {
    // Agents ships joined to Artifacts. Dropping it onto Terminals is the
    // first stacking gesture most users will try, and it has to mean what it
    // says: the old join goes, the new one arrives, Artifacts stands alone.
    // This is the section-header ("panel") carry: only Agents itself moves.
    const joined = stackRailPanels(
      withRail(DEFAULT_RAIL),
      "chats",
      "terminals",
      "panel",
    );

    expect(idsOf(normalizeRail(joined.rail))).toEqual([
      "railArtifacts",
      "railTerminals",
      "stack:railTerminals+railAgents",
      "railAgents",
      "railBrowsers",
      "railGitDiff",
      "railPullRequests",
      "railFileTree",
      "railSharing",
      "railComments",
    ]);
    expect(
      isStackedRailPanel(normalizeRail(joined.rail), "railArtifacts"),
    ).toBe(false);
  });

  it("leaves a rail holding no such link untouched", () => {
    const flat = withRail(FLAT_RAIL);

    expect(unstackRail(flat, "stack:railAgents+railArtifacts")).toBe(flat);
  });

  it("is not what a before or after drop does", () => {
    // Terminals dropped after Browsers really moves, and the two stay apart:
    // the only stack is still the shipped one.
    const after = moveRailPanelBeside(withRail(DEFAULT_RAIL), {
      sourcePanelId: "terminals",
      targetPanelId: "browsers",
      placeAfter: true,
      carry: "panel",
    }).rail;

    expect(idsOf(normalizeRail(after))).toEqual([
      "railAgents",
      "stack:railAgents+railArtifacts",
      "railArtifacts",
      "railBrowsers",
      "railTerminals",
      ...idsOf(FLAT_RAIL).slice(4),
    ]);
  });

  const THREE_MEMBER_RAIL: ReadonlyArray<RailEntry> = [
    panel("railAgents"),
    stack("stack:railAgents+railArtifacts+railTerminals"),
    panel("railArtifacts"),
    panel("railTerminals"),
    ...FLAT_RAIL.slice(3),
  ];

  describe("unstackRailPanel: one member out (L-181)", () => {
    it("moves a removed MIDDLE member to just after its former stack, keeping the rest stacked", () => {
      const result = unstackRailPanel(
        withRail(THREE_MEMBER_RAIL),
        "railArtifacts",
      ).rail;

      expect(idsOf(normalizeRail(result))).toEqual([
        "railAgents",
        "stack:railAgents+railTerminals",
        "railTerminals",
        "railArtifacts",
        ...idsOf(FLAT_RAIL).slice(3),
      ]);
    });

    it("leaves the FIRST or LAST member exactly where it stands, dissolving a two-member stack", () => {
      const paired = withRail(DEFAULT_RAIL);

      expect(
        idsOf(normalizeRail(unstackRailPanel(paired, "railAgents").rail)),
      ).toEqual(idsOf(FLAT_RAIL));
      expect(
        idsOf(normalizeRail(unstackRailPanel(paired, "railArtifacts").rail)),
      ).toEqual(idsOf(FLAT_RAIL));
    });

    it("does nothing for a panel that is not in a stack", () => {
      const flat = withRail(FLAT_RAIL);

      expect(unstackRailPanel(flat, "railTerminals")).toBe(flat);
    });
  });

  describe("unstackRail: the whole stack at once", () => {
    it("removes a 3-member stack in one write, leaving every member in place", () => {
      const result = unstackRail(
        withRail(THREE_MEMBER_RAIL),
        "stack:railAgents+railArtifacts+railTerminals",
      ).rail;

      expect(idsOf(result)).toEqual(
        idsOf(THREE_MEMBER_RAIL).filter((id) => !id.startsWith("stack:")),
      );
    });
  });

  describe("moveRailPanelBeside and a stack (L-181)", () => {
    it("carries the WHOLE stack when dragged by its rail icon, landing beside another panel as one block", () => {
      const moved = moveRailPanelBeside(withRail(DEFAULT_RAIL), {
        sourcePanelId: "chats",
        targetPanelId: "terminals",
        placeAfter: true,
        carry: "stack",
      }).rail;

      expect(idsOf(normalizeRail(moved))).toEqual([
        "railTerminals",
        "railAgents",
        "stack:railAgents+railArtifacts",
        "railArtifacts",
        ...idsOf(FLAT_RAIL).slice(3),
      ]);
    });

    it("carries the WHOLE stack to the rail's end", () => {
      const moved = moveRailPanelToEnd(
        withRail(DEFAULT_RAIL),
        "chats",
        "stack",
      ).rail;

      expect(idsOf(moved)).toEqual([
        ...idsOf(FLAT_RAIL).slice(2),
        "railAgents",
        "stack:railAgents+railArtifacts",
        "railArtifacts",
      ]);
    });

    it("joins two whole stacks together up to the max, and refuses past it", () => {
      const rail: ReadonlyArray<RailEntry> = [
        panel("railAgents"),
        stack("stack:railAgents+railArtifacts+railTerminals"),
        panel("railArtifacts"),
        panel("railTerminals"),
        panel("railBrowsers"),
        stack("stack:railBrowsers+railGitDiff"),
        panel("railGitDiff"),
        panel("railPullRequests"),
        panel("railFileTree"),
        panel("railSharing"),
        panel("railComments"),
      ];
      const arrangement = withRail(rail);

      // 3 carried + 1 lone = 4, exactly the max: a whole-stack carry joins.
      expect(
        railStackJoin(arrangement.rail, "chats", "pull-requests", "stack"),
      ).toBe("join");
      const joined = stackRailPanels(
        arrangement,
        "chats",
        "pull-requests",
        "stack",
      );
      expect(idsOf(normalizeRail(joined.rail))).toEqual([
        "railBrowsers",
        "stack:railBrowsers+railGitDiff",
        "railGitDiff",
        "railPullRequests",
        "stack:railPullRequests+railAgents+railArtifacts+railTerminals",
        "railAgents",
        "railArtifacts",
        "railTerminals",
        "railFileTree",
        "railSharing",
        "railComments",
      ]);

      // 3 carried + 2 already stacked = 5, past the max: refused.
      expect(
        railStackJoin(arrangement.rail, "chats", "git-diff", "stack"),
      ).toBe("full");
      expect(stackRailPanels(arrangement, "chats", "git-diff", "stack")).toBe(
        arrangement,
      );
    });

    it("lets a section-header drag of a MIDDLE member out, leaving the rest stacked", () => {
      const moved = moveRailPanelBeside(withRail(THREE_MEMBER_RAIL), {
        sourcePanelId: "artifacts",
        targetPanelId: "browsers",
        placeAfter: true,
        carry: "panel",
      }).rail;

      expect(idsOf(normalizeRail(moved))).toEqual([
        "railAgents",
        "stack:railAgents+railTerminals",
        "railTerminals",
        "railBrowsers",
        "railArtifacts",
        ...idsOf(FLAT_RAIL).slice(4),
      ]);
    });

    it("reorders WITHIN its own stack and stays a member", () => {
      const moved = moveRailPanelBeside(withRail(DEFAULT_RAIL), {
        sourcePanelId: "artifacts",
        targetPanelId: "chats",
        placeAfter: false,
        carry: "panel",
      }).rail;

      expect(idsOf(normalizeRail(moved))).toEqual([
        "railArtifacts",
        "stack:railArtifacts+railAgents",
        "railAgents",
        ...idsOf(FLAT_RAIL).slice(2),
      ]);
    });

    it("dropped beside a stacked target lands beside its WHOLE stack, never between its members", () => {
      const moved = moveRailPanelBeside(withRail(DEFAULT_RAIL), {
        sourcePanelId: "browsers",
        targetPanelId: "artifacts",
        placeAfter: true,
        carry: "panel",
      }).rail;

      expect(idsOf(normalizeRail(moved))).toEqual([
        "railAgents",
        "stack:railAgents+railArtifacts",
        "railArtifacts",
        "railBrowsers",
        "railTerminals",
        ...idsOf(FLAT_RAIL).slice(4),
      ]);
    });

    it("returns the IDENTICAL rail for a 3-stack's middle member dropped where it already stands (L-170, L-181)", () => {
      const arrangement = withRail(THREE_MEMBER_RAIL);

      // Artifacts (the middle member) already stands directly after Agents.
      expect(
        moveRailPanelBeside(arrangement, {
          sourcePanelId: "artifacts",
          targetPanelId: "chats",
          placeAfter: true,
          carry: "panel",
        }).rail,
      ).toBe(arrangement.rail);
      // And directly before Terminals.
      expect(
        moveRailPanelBeside(arrangement, {
          sourcePanelId: "artifacts",
          targetPanelId: "terminals",
          placeAfter: false,
          carry: "panel",
        }).rail,
      ).toBe(arrangement.rail);
    });

    it("moves a NON-adjacent reorder within a 3-stack, which the old pair-only early return wrongly refused", () => {
      // Terminals is the LAST member, dropped before the FIRST: a real move
      // across the whole stack, not a swap of adjacent members.
      const moved = moveRailPanelBeside(withRail(THREE_MEMBER_RAIL), {
        sourcePanelId: "terminals",
        targetPanelId: "chats",
        placeAfter: false,
        carry: "panel",
      }).rail;

      expect(idsOf(normalizeRail(moved))).toEqual([
        "railTerminals",
        "stack:railTerminals+railAgents+railArtifacts",
        "railAgents",
        "railArtifacts",
        ...idsOf(FLAT_RAIL).slice(3),
      ]);
    });

    it("keeps the same no-op identity through moveCanvasOrderMember's rail group", () => {
      const arrangement = withRail(THREE_MEMBER_RAIL);

      const next = moveCanvasOrderMember({
        arrangement,
        group: "rail",
        fromId: "railArtifacts",
        toId: "railAgents",
        placeAfter: true,
      });

      expect(next.rail).toBe(arrangement.rail);
    });
  });

  it("leaves its stack when moved to the rail's end", () => {
    const moved = moveRailPanelToEnd(
      withRail(DEFAULT_RAIL),
      "chats",
      "panel",
    ).rail;
    const normalized = normalizeRail(moved);

    expect(idsOf(normalized).at(-1)).toBe("railAgents");
    expect(isStackedRailPanel(normalized, "railAgents")).toBe(false);
    expect(isStackedRailPanel(normalized, "railArtifacts")).toBe(false);
  });

  describe("the list's own join: stack with the panel below (L-168, L-181)", () => {
    it("offers the panel directly below, only from the LAST member of a block", () => {
      const rail = withRail(DEFAULT_RAIL).rail;

      // Agents is the FIRST member of the shipped pair, not the last.
      expect(railPanelToStackBelow(rail, "railAgents")).toBeNull();
      expect(railPanelToStackBelow(rail, "railArtifacts")).toBe(
        "railTerminals",
      );
      expect(railPanelToStackBelow(rail, "railTerminals")).toBe("railBrowsers");
    });

    it("offers nothing when the next entry is a divider, or there is none", () => {
      const withDivider = [
        ...FLAT_RAIL.slice(0, 3),
        divider("divider:1"),
        ...FLAT_RAIL.slice(3),
      ];

      expect(railPanelToStackBelow(withDivider, "railTerminals")).toBeNull();
      expect(railPanelToStackBelow(FLAT_RAIL, "railComments")).toBeNull();
    });

    it("refuses once the combined total would exceed the max", () => {
      const fourAboveOne: ReadonlyArray<RailEntry> = [
        panel("railAgents"),
        stack("stack:railAgents+railArtifacts+railTerminals+railBrowsers"),
        panel("railArtifacts"),
        panel("railTerminals"),
        panel("railBrowsers"),
        ...FLAT_RAIL.slice(4),
      ];

      expect(railPanelToStackBelow(fourAboveOne, "railBrowsers")).toBeNull();
    });

    it("joins the two blocks with no member moving", () => {
      const joined = stackRailPanelWithBelow(
        withRail(DEFAULT_RAIL),
        "railArtifacts",
      ).rail;

      expect(idsOf(normalizeRail(joined))).toEqual([
        "railAgents",
        "stack:railAgents+railArtifacts+railTerminals",
        "railArtifacts",
        "railTerminals",
        ...idsOf(FLAT_RAIL).slice(3),
      ]);
    });

    it("does nothing when there is no panel below to join", () => {
      const arrangement = withRail(FLAT_RAIL);

      expect(stackRailPanelWithBelow(arrangement, "railComments")).toBe(
        arrangement,
      );
    });
  });
});

describe("what a rail SURFACE draws (L-166, L-167)", () => {
  it("draws a stack as one capsule holding every member, and everything else as itself (L-181)", () => {
    expect(railDisplayEntries(DEFAULT_RAIL, () => true)).toEqual([
      {
        kind: "stack",
        id: "stack:railAgents+railArtifacts",
        members: ["railAgents", "railArtifacts"],
      },
      ...idsOf(FLAT_RAIL)
        .slice(2)
        .map((id) => ({ kind: "panel", id })),
    ]);
  });

  it("draws a 3- or 4-member stack as one capsule listing every member, in order", () => {
    const fourMember: ReadonlyArray<RailEntry> = [
      panel("railAgents"),
      stack("stack:railAgents+railArtifacts+railTerminals+railBrowsers"),
      panel("railArtifacts"),
      panel("railTerminals"),
      panel("railBrowsers"),
      ...FLAT_RAIL.slice(4),
    ];

    expect(railDisplayEntries(fourMember, () => true)[0]).toEqual({
      kind: "stack",
      id: "stack:railAgents+railArtifacts+railTerminals+railBrowsers",
      members: ["railAgents", "railArtifacts", "railTerminals", "railBrowsers"],
    });
  });

  it("leaves the visible partner standing alone when one is hidden", () => {
    const drawn = railDisplayEntries(
      DEFAULT_RAIL,
      (regionId) => regionId !== "railArtifacts",
    );

    expect(drawn[0]).toEqual({ kind: "panel", id: "railAgents" });
    expect(drawn.some((entry) => entry.kind === "stack")).toBe(false);
  });

  it("tells the body which panels share it", () => {
    expect(
      railStackMembersFor(DEFAULT_RAIL, "railArtifacts", () => true),
    ).toEqual(["railAgents", "railArtifacts"]);
    expect(
      railStackMembersFor(DEFAULT_RAIL, "railTerminals", () => true),
    ).toEqual(["railTerminals"]);
    expect(
      railStackMembersFor(
        DEFAULT_RAIL,
        "railAgents",
        (regionId) => regionId !== "railArtifacts",
      ),
    ).toEqual(["railAgents"]);
  });
});

describe("railStackMembers / railStackOf (L-181)", () => {
  it("reads a stack id back as its ordered members, or null for one this build cannot read", () => {
    expect(
      railStackMembers("stack:railAgents+railArtifacts+railTerminals"),
    ).toEqual(["railAgents", "railArtifacts", "railTerminals"]);
    expect(railStackMembers("stack:railAgents")).toBeNull(); // fewer than two
    expect(railStackMembers("stack:railAgents+railAgents")).toBeNull(); // a repeat
    expect(railStackMembers("stack:railAgents+notARegion")).toBeNull(); // unknown
    expect(railStackMembers("not-a-stack-id")).toBeNull();
  });

  it("finds the stack a panel belongs to in a normalized rail, or null standing alone", () => {
    expect(railStackOf(DEFAULT_RAIL, "railArtifacts")).toEqual({
      id: "stack:railAgents+railArtifacts",
      members: ["railAgents", "railArtifacts"],
    });
    expect(railStackOf(DEFAULT_RAIL, "railTerminals")).toBeNull();
  });
});

/**
 * S-01, S-02, S-05, S-06: the tab strip's placement and the sidebar's side
 * are arrangement fields beside the bar placements, top and left by default.
 */
describe("the tab strip's placement and the sidebar's side (S-01, S-02, S-05, S-06)", () => {
  describe("sideTabStripEdge", () => {
    it("is null for top and the edge itself for a side", () => {
      expect(sideTabStripEdge("top")).toBeNull();
      expect(sideTabStripEdge("left")).toBe("left");
      expect(sideTabStripEdge("right")).toBe("right");
    });
  });
});

/**
 * D8: what the vertical strip shows, and D9's predicate for when it lists the
 * active task's live agents under its row.
 */
describe("the vertical strip's view (D8, D9)", () => {
  describe("liveAgentsInStrip (D9)", () => {
    it.each<{
      readonly placement: TabStripPlacement;
      readonly stripCollapsed: boolean;
      readonly view: SideStripView;
      readonly shown: boolean;
    }>([
      {
        placement: "top",
        stripCollapsed: false,
        view: "layered",
        shown: false,
      },
      {
        placement: "top",
        stripCollapsed: false,
        view: "activity",
        shown: false,
      },
      { placement: "top", stripCollapsed: true, view: "layered", shown: false },
      {
        placement: "top",
        stripCollapsed: true,
        view: "activity",
        shown: false,
      },
      {
        placement: "left",
        stripCollapsed: false,
        view: "layered",
        shown: false,
      },
      {
        placement: "left",
        stripCollapsed: false,
        view: "activity",
        shown: true,
      },
      {
        placement: "left",
        stripCollapsed: true,
        view: "layered",
        shown: false,
      },
      {
        placement: "left",
        stripCollapsed: true,
        view: "activity",
        shown: false,
      },
      {
        placement: "right",
        stripCollapsed: false,
        view: "layered",
        shown: false,
      },
      {
        placement: "right",
        stripCollapsed: false,
        view: "activity",
        shown: true,
      },
      {
        placement: "right",
        stripCollapsed: true,
        view: "layered",
        shown: false,
      },
      {
        placement: "right",
        stripCollapsed: true,
        view: "activity",
        shown: false,
      },
    ])(
      "placement=$placement stripCollapsed=$stripCollapsed view=$view -> $shown",
      ({ placement, stripCollapsed, view, shown }) => {
        expect(liveAgentsInStrip(placement, stripCollapsed, view)).toBe(shown);
      },
    );
  });
});

/**
 * The persisted enum fields (L-133): the tab strip's placement, the sidebar's
 * side, the reading width (audit R1: how wide the transcript, the composer and
 * an artifact's body run), the vertical strip's view (D8) and Tab overflow.
 * Each keeps a value this build knows verbatim and reads anything else as its
 * shipped default, field by field.
 *
 * The junk is a number, a wrong-case literal, `null`, an object and a string
 * this build has no case for - every shape a corrupt or foreign record could
 * hold, not just one string. `"top"` is valid for the strip but junk for the
 * sidebar, which is worth pinning on its own.
 */
describe("resolvePersistedArrangement: the enum fields (L-133)", () => {
  it.each<{
    readonly field:
      | "tabStripPlacement"
      | "sidebarSide"
      | "readingWidth"
      | "sideStripView"
      | "taskTabLayout";
    readonly fallback: string;
    readonly valid: ReadonlyArray<string>;
    readonly junk: ReadonlyArray<unknown>;
  }>([
    {
      field: "tabStripPlacement",
      fallback: "top",
      valid: ["top", "left", "right"],
      junk: [1, "TOP", null, {}, "sideways"],
    },
    {
      field: "sidebarSide",
      fallback: "left",
      valid: ["right"],
      junk: [0, "LEFT", null, "top"],
    },
    {
      field: "readingWidth",
      fallback: "comfortable",
      valid: ["wide"],
      junk: [1, "WIDE", null, {}, "narrow"],
    },
    {
      field: "sideStripView",
      fallback: "layered",
      valid: ["layered", "activity"],
      junk: [1, "ACTIVITY", null, {}, "focused"],
    },
    {
      field: "taskTabLayout",
      fallback: "scroll",
      valid: ["shrink"],
      junk: ["wrap", undefined],
    },
  ])(
    "$field falls back to $fallback on an absent or unreadable value and keeps a valid one verbatim",
    ({ field, fallback, valid, junk }) => {
      expect(resolvePersistedArrangement({})[field]).toBe(fallback);
      for (const value of junk) {
        expect(
          resolvePersistedArrangement({ [field]: value })[field],
          JSON.stringify(value),
        ).toBe(fallback);
      }
      for (const value of valid) {
        expect(resolvePersistedArrangement({ [field]: value })[field]).toBe(
          value,
        );
      }
    },
  );
});

/**
 * `wideReadingWidthPx` is not one of L-133's small enum fields - it is a
 * clamped number, so it gets its own describe rather than joining the
 * `it.each` table above (which asserts strict membership, not a range).
 */
describe("resolvePersistedArrangement: wideReadingWidthPx (clamped, not enum)", () => {
  it("falls back to the default on an absent or non-numeric value", () => {
    expect(resolvePersistedArrangement({}).wideReadingWidthPx).toBe(
      DEFAULT_ARRANGEMENT.wideReadingWidthPx,
    );
    for (const value of ["1200", null, {}, NaN, Infinity, -Infinity]) {
      expect(
        resolvePersistedArrangement({ wideReadingWidthPx: value })
          .wideReadingWidthPx,
        JSON.stringify(value),
      ).toBe(DEFAULT_ARRANGEMENT.wideReadingWidthPx);
    }
  });

  it("keeps a valid in-range value verbatim", () => {
    expect(
      resolvePersistedArrangement({ wideReadingWidthPx: 1600 })
        .wideReadingWidthPx,
    ).toBe(1600);
  });

  it("clamps a value below the floor up to the slider's own minimum", () => {
    expect(
      resolvePersistedArrangement({ wideReadingWidthPx: 200 })
        .wideReadingWidthPx,
    ).toBe(WIDE_READING_WIDTH_MIN_PX);
  });

  it("clamps a value above the ceiling down to the slider's own maximum", () => {
    expect(
      resolvePersistedArrangement({ wideReadingWidthPx: 100_000 })
        .wideReadingWidthPx,
    ).toBe(WIDE_READING_WIDTH_MAX_PX);
  });
});

describe("where Add divider puts one when the rail ends in a stack", () => {
  it("steps over the link rather than splitting the pair", () => {
    const endsStacked = normalizeRail([
      ...idsOf(FLAT_RAIL)
        .slice(0, 7)
        .map((id): RailEntry => panel(id)),
      panel("railSharing"),
      stack("stack:railSharing+railComments"),
      panel("railComments"),
    ]);

    const at = railDividerInsertIndex(endsStacked);
    const added = insertRailDivider(withRail(endsStacked), at);

    expect(idsOf(normalizeRail(added.rail)).slice(-4)).toEqual([
      "divider:1",
      "railSharing",
      "stack:railSharing+railComments",
      "railComments",
    ]);
  });
});
