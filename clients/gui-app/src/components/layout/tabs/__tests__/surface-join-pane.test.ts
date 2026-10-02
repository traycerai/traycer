/**
 * `surface-join-pane.ts`: which pane's fill a tab's join takes, by what its
 * surface paints along the edge the tab runs into (`surfaceJoinPane(tab, edge,
 * landing)`).
 *
 * The rule is a switch per kind, so a new kind has to say what its surface
 * paints. This pins every kind on every edge, the one kind that reads state (a
 * draft, whose terminal panel is canvas where it is open), and the ways a strip
 * item can name a pane: a lone tab, a split pair (read off the store's item or
 * off the strip's projection of it), and an item that is gone.
 *
 * A top pair joins `surface` when any member that holds a tab paints
 * `--background` along the top, and `canvas` otherwise: an empty or unavailable
 * side shows the slot chooser, which paints neither, so History (or a draft
 * whose maximized panel covers its page) beside one keeps the canvas.
 */
import { describe, expect, it } from "vitest";
import {
  DEFAULT_LANDING_PANEL_LAYOUT,
  type LandingPanelLayout,
} from "@/stores/home/landing-panel-store";
import {
  tabItemId,
  type SplitSide,
  type SplitStripItem,
  type StripItem,
} from "@/stores/tabs/layout";
import type { HeaderTabKind } from "@/stores/tabs/registry";
import type { HeaderTab, TabRef } from "@/stores/tabs/types";
import type {
  HeaderStripItem,
  HeaderStripMember,
} from "@/stores/tabs/use-header-tabs";
import type { SheetJoinPane } from "../side-strip/side-tab-join";
import {
  headerSplitJoinPane,
  splitPairJoinPane,
  stripItemJoinPane,
  surfaceJoinPane,
  type JoinEdge,
  type LandingPanelLayouts,
} from "../surface-join-pane";

const EDGES: ReadonlyArray<JoinEdge> = ["top", "left", "right"];

/** What each kind's surface paints along each edge, with no panel open. */
const PANE_BY_KIND: ReadonlyArray<
  { readonly kind: HeaderTabKind } & Readonly<Record<JoinEdge, SheetJoinPane>>
> = [
  { kind: "epic", top: "surface", left: "canvas", right: "canvas" },
  { kind: "draft", top: "surface", left: "surface", right: "surface" },
  { kind: "settings", top: "surface", left: "panel", right: "surface" },
  { kind: "home", top: "canvas", left: "canvas", right: "canvas" },
  { kind: "history", top: "canvas", left: "canvas", right: "canvas" },
  { kind: "sample-workspace", top: "canvas", left: "canvas", right: "canvas" },
];

const PANE_BY_KIND_AND_EDGE = PANE_BY_KIND.flatMap((row) =>
  EDGES.map((edge) => ({ kind: row.kind, edge, pane: row[edge] })),
);

/** Nothing recorded for any start page: every panel is closed. */
const DEFAULT_LANDING: LandingPanelLayouts = {
  layoutsByLandingPageId: {},
  fallbackLayout: null,
};

const OPEN_DOCKED: LandingPanelLayout = {
  ...DEFAULT_LANDING_PANEL_LAYOUT,
  panelOpen: true,
  maximized: false,
};

const OPEN_MAXIMIZED: LandingPanelLayout = {
  ...DEFAULT_LANDING_PANEL_LAYOUT,
  panelOpen: true,
  maximized: true,
};

/** A layout that remembers a maximize across a close. */
const CLOSED_MAXIMIZED: LandingPanelLayout = {
  ...DEFAULT_LANDING_PANEL_LAYOUT,
  panelOpen: false,
  maximized: true,
};

const DRAFT: TabRef = { kind: "draft", id: "draft-1" };
const OTHER_DRAFT: TabRef = { kind: "draft", id: "draft-2" };

/** `layout` recorded for the draft with `draftId`, and nothing else. */
function landingWith(
  draftId: string,
  layout: LandingPanelLayout,
): LandingPanelLayouts {
  return {
    layoutsByLandingPageId: { [draftId]: layout },
    fallbackLayout: null,
  };
}

const DRAFT_MAXIMIZED = landingWith(DRAFT.id, OPEN_MAXIMIZED);
const DRAFT_DOCKED = landingWith(DRAFT.id, OPEN_DOCKED);

function tabRef(kind: HeaderTabKind): TabRef {
  return { kind, id: `${kind}-1` };
}

function tabItem(kind: HeaderTabKind): StripItem {
  const ref = tabRef(kind);
  return { kind: "tab", id: tabItemId(ref), ref };
}

function tabSide(kind: HeaderTabKind): SplitSide {
  return { kind: "tab", ref: tabRef(kind) };
}

const EMPTY_SIDE: Exclude<SplitSide, { readonly kind: "tab" }> = {
  kind: "empty",
};

/** A side whose tab is gone: it shows the slot chooser, like an empty one. */
const UNAVAILABLE_SIDE: Exclude<SplitSide, { readonly kind: "tab" }> = {
  kind: "unavailable",
  previousRef: { kind: "epic", id: "gone" },
  label: "Tab unavailable",
};

function splitItem(left: SplitSide, right: SplitSide): SplitStripItem {
  return {
    kind: "split",
    id: "split-1",
    left,
    right,
    focusedSide: "left",
    routeBackingSide: "left",
    leftRatio: 0.5,
  };
}

const EPIC_TAB: HeaderTab = {
  kind: "epic",
  id: "epic-1",
  epicId: "epic-1",
  hostId: null,
  route: "/epics/epic-1/epic-1",
  name: "Epic",
  icon: null,
  canClose: true,
  canDuplicate: true,
  canOpenInNewWindow: true,
};

const HISTORY_TAB: HeaderTab = {
  kind: "history",
  id: "history",
  route: "/epics",
  name: "History",
  icon: null,
  canDuplicate: false,
  canOpenInNewWindow: false,
  lastPath: null,
};

const DRAFT_TAB: HeaderTab = {
  kind: "draft",
  id: DRAFT.id,
  route: "/",
  name: "Draft",
  icon: null,
  canDuplicate: true,
  canOpenInNewWindow: true,
};

function tabMember(tab: HeaderTab): HeaderStripMember {
  return { kind: "tab", tab };
}

const EMPTY_MEMBER: HeaderStripMember = { kind: "fillable", slot: EMPTY_SIDE };

const UNAVAILABLE_MEMBER: HeaderStripMember = {
  kind: "fillable",
  slot: UNAVAILABLE_SIDE,
};

function headerSplit(
  left: HeaderStripMember,
  right: HeaderStripMember,
): Extract<HeaderStripItem, { readonly kind: "split" }> {
  return { kind: "split", id: "split-1", focusedSide: "left", left, right };
}

describe("surfaceJoinPane", () => {
  it.each(PANE_BY_KIND_AND_EDGE)(
    "$kind joins the $pane pane at the $edge edge, with no panel open",
    ({ kind, edge, pane }) => {
      expect(surfaceJoinPane(tabRef(kind), edge, DEFAULT_LANDING)).toBe(pane);
    },
  );

  describe("a draft, by where its terminal panel is", () => {
    it.each(EDGES)(
      "joins the surface pane at the %s edge while its panel is closed",
      (edge) => {
        expect(surfaceJoinPane(DRAFT, edge, DEFAULT_LANDING)).toBe("surface");
      },
    );

    it.each(EDGES)(
      "joins the surface pane at the %s edge when it is maximized but closed: nothing is covering the page",
      (edge) => {
        expect(
          surfaceJoinPane(DRAFT, edge, landingWith(DRAFT.id, CLOSED_MAXIMIZED)),
        ).toBe("surface");
      },
    );

    it.each([
      { edge: "top", pane: "surface" },
      { edge: "left", pane: "surface" },
      { edge: "right", pane: "canvas" },
    ] as const)(
      "joins the $pane pane at the $edge edge while its panel is open and docked: the panel is canvas on the right",
      ({ edge, pane }) => {
        expect(surfaceJoinPane(DRAFT, edge, DRAFT_DOCKED)).toBe(pane);
      },
    );

    it.each(EDGES)(
      "joins the canvas pane at the %s edge while its panel is open and maximized: it covers the whole page",
      (edge) => {
        expect(surfaceJoinPane(DRAFT, edge, DRAFT_MAXIMIZED)).toBe("canvas");
      },
    );

    it.each(EDGES)(
      "reads the fallback layout at the %s edge when the draft has none of its own",
      (edge) => {
        expect(
          surfaceJoinPane(DRAFT, edge, {
            layoutsByLandingPageId: {},
            fallbackLayout: OPEN_MAXIMIZED,
          }),
        ).toBe("canvas");
      },
    );

    it.each(EDGES)(
      "prefers its own closed layout over an open fallback at the %s edge",
      (edge) => {
        expect(
          surfaceJoinPane(DRAFT, edge, {
            layoutsByLandingPageId: {
              [DRAFT.id]: DEFAULT_LANDING_PANEL_LAYOUT,
            },
            fallbackLayout: OPEN_MAXIMIZED,
          }),
        ).toBe("surface");
      },
    );

    it.each(EDGES)(
      "is not moved at the %s edge by another draft's open panel",
      (edge) => {
        expect(
          surfaceJoinPane(
            OTHER_DRAFT,
            edge,
            landingWith(DRAFT.id, OPEN_MAXIMIZED),
          ),
        ).toBe("surface");
      },
    );
  });

  describe("every other kind, whatever the start page's panel is doing", () => {
    const OTHER_KINDS = PANE_BY_KIND_AND_EDGE.filter(
      (row) => row.kind !== "draft",
    );

    it.each(OTHER_KINDS)(
      "$kind still joins the $pane pane at the $edge edge with a draft's panel maximized",
      ({ kind, edge, pane }) => {
        expect(surfaceJoinPane(tabRef(kind), edge, DRAFT_MAXIMIZED)).toBe(pane);
      },
    );
  });
});

describe("splitPairJoinPane", () => {
  it.each(PANE_BY_KIND)(
    "a pair holding only $kind joins the $top pane",
    ({ kind, top }) => {
      expect(splitPairJoinPane([tabRef(kind)], DEFAULT_LANDING)).toBe(top);
    },
  );

  it("a pair holding no tab joins the canvas pane: the slot chooser paints neither", () => {
    expect(splitPairJoinPane([], DEFAULT_LANDING)).toBe("canvas");
  });

  it("History beside a task joins the surface pane, whichever side the task is on", () => {
    expect(
      splitPairJoinPane([tabRef("history"), tabRef("epic")], DEFAULT_LANDING),
    ).toBe("surface");
    expect(
      splitPairJoinPane([tabRef("epic"), tabRef("history")], DEFAULT_LANDING),
    ).toBe("surface");
  });

  it("History beside Settings or a draft joins the surface pane", () => {
    expect(
      splitPairJoinPane(
        [tabRef("history"), tabRef("settings")],
        DEFAULT_LANDING,
      ),
    ).toBe("surface");
    expect(splitPairJoinPane([DRAFT, tabRef("history")], DEFAULT_LANDING)).toBe(
      "surface",
    );
  });

  it("two tasks join the surface pane", () => {
    expect(
      splitPairJoinPane([tabRef("epic"), tabRef("epic")], DEFAULT_LANDING),
    ).toBe("surface");
  });

  describe("with a draft whose terminal panel is open", () => {
    it("a maximized draft beside History joins the canvas pane: the panel covers the page", () => {
      expect(
        splitPairJoinPane([DRAFT, tabRef("history")], DRAFT_MAXIMIZED),
      ).toBe("canvas");
      expect(
        splitPairJoinPane([tabRef("history"), DRAFT], DRAFT_MAXIMIZED),
      ).toBe("canvas");
    });

    it("a maximized draft beside a task joins the surface pane: the task still paints it", () => {
      expect(splitPairJoinPane([DRAFT, tabRef("epic")], DRAFT_MAXIMIZED)).toBe(
        "surface",
      );
    });

    it("a maximized draft alone in its pair joins the canvas pane", () => {
      expect(splitPairJoinPane([DRAFT], DRAFT_MAXIMIZED)).toBe("canvas");
    });

    it("a docked draft beside History joins the surface pane: only the right edge meets the panel", () => {
      expect(splitPairJoinPane([DRAFT, tabRef("history")], DRAFT_DOCKED)).toBe(
        "surface",
      );
    });

    it("a maximized draft beside a closed one joins the surface pane", () => {
      expect(splitPairJoinPane([DRAFT, OTHER_DRAFT], DRAFT_MAXIMIZED)).toBe(
        "surface",
      );
    });
  });
});

describe("headerSplitJoinPane", () => {
  it("History beside an empty slot joins the canvas pane: the slot paints no ground", () => {
    expect(
      headerSplitJoinPane(
        headerSplit(tabMember(HISTORY_TAB), EMPTY_MEMBER),
        DEFAULT_LANDING,
      ),
    ).toBe("canvas");
    expect(
      headerSplitJoinPane(
        headerSplit(EMPTY_MEMBER, tabMember(HISTORY_TAB)),
        DEFAULT_LANDING,
      ),
    ).toBe("canvas");
  });

  it("History beside an unavailable tab joins the canvas pane", () => {
    expect(
      headerSplitJoinPane(
        headerSplit(tabMember(HISTORY_TAB), UNAVAILABLE_MEMBER),
        DEFAULT_LANDING,
      ),
    ).toBe("canvas");
  });

  it("History beside a task joins the surface pane, whichever side the task is on", () => {
    expect(
      headerSplitJoinPane(
        headerSplit(tabMember(HISTORY_TAB), tabMember(EPIC_TAB)),
        DEFAULT_LANDING,
      ),
    ).toBe("surface");
    expect(
      headerSplitJoinPane(
        headerSplit(tabMember(EPIC_TAB), tabMember(HISTORY_TAB)),
        DEFAULT_LANDING,
      ),
    ).toBe("surface");
  });

  it("a task beside an empty slot joins the surface pane", () => {
    expect(
      headerSplitJoinPane(
        headerSplit(tabMember(EPIC_TAB), EMPTY_MEMBER),
        DEFAULT_LANDING,
      ),
    ).toBe("surface");
    expect(
      headerSplitJoinPane(
        headerSplit(EMPTY_MEMBER, tabMember(EPIC_TAB)),
        DEFAULT_LANDING,
      ),
    ).toBe("surface");
  });

  it("a task beside an unavailable tab joins the surface pane", () => {
    expect(
      headerSplitJoinPane(
        headerSplit(tabMember(EPIC_TAB), UNAVAILABLE_MEMBER),
        DEFAULT_LANDING,
      ),
    ).toBe("surface");
  });

  it("two tasks join the surface pane", () => {
    expect(
      headerSplitJoinPane(
        headerSplit(tabMember(EPIC_TAB), tabMember(EPIC_TAB)),
        DEFAULT_LANDING,
      ),
    ).toBe("surface");
  });

  it("a pair with no tab in it joins the canvas pane", () => {
    expect(
      headerSplitJoinPane(
        headerSplit(EMPTY_MEMBER, UNAVAILABLE_MEMBER),
        DEFAULT_LANDING,
      ),
    ).toBe("canvas");
  });

  it("a draft beside History joins the surface pane while its panel is closed", () => {
    expect(
      headerSplitJoinPane(
        headerSplit(tabMember(DRAFT_TAB), tabMember(HISTORY_TAB)),
        DEFAULT_LANDING,
      ),
    ).toBe("surface");
  });

  it("a maximized draft beside History or an empty slot joins the canvas pane", () => {
    expect(
      headerSplitJoinPane(
        headerSplit(tabMember(DRAFT_TAB), tabMember(HISTORY_TAB)),
        DRAFT_MAXIMIZED,
      ),
    ).toBe("canvas");
    expect(
      headerSplitJoinPane(
        headerSplit(EMPTY_MEMBER, tabMember(DRAFT_TAB)),
        DRAFT_MAXIMIZED,
      ),
    ).toBe("canvas");
  });

  it("a maximized draft beside a task joins the surface pane", () => {
    expect(
      headerSplitJoinPane(
        headerSplit(tabMember(DRAFT_TAB), tabMember(EPIC_TAB)),
        DRAFT_MAXIMIZED,
      ),
    ).toBe("surface");
  });

  it("a docked draft beside History joins the surface pane", () => {
    expect(
      headerSplitJoinPane(
        headerSplit(tabMember(DRAFT_TAB), tabMember(HISTORY_TAB)),
        DRAFT_DOCKED,
      ),
    ).toBe("surface");
  });
});

describe("stripItemJoinPane", () => {
  it.each(PANE_BY_KIND)(
    "a lone $kind tab joins the $top pane",
    ({ kind, top }) => {
      expect(stripItemJoinPane(tabItem(kind), DEFAULT_LANDING)).toBe(top);
    },
  );

  it("a lone draft joins the canvas pane only while its panel is open and maximized", () => {
    expect(stripItemJoinPane(tabItem("draft"), DRAFT_MAXIMIZED)).toBe("canvas");
    expect(stripItemJoinPane(tabItem("draft"), DRAFT_DOCKED)).toBe("surface");
    expect(stripItemJoinPane(tabItem("draft"), DEFAULT_LANDING)).toBe(
      "surface",
    );
  });

  it("a split pair of two tasks joins the surface pane", () => {
    expect(
      stripItemJoinPane(
        splitItem(tabSide("epic"), tabSide("epic")),
        DEFAULT_LANDING,
      ),
    ).toBe("surface");
  });

  it("a split pair of History and a surface kind joins the surface pane, whichever side History is on", () => {
    expect(
      stripItemJoinPane(
        splitItem(tabSide("history"), tabSide("epic")),
        DEFAULT_LANDING,
      ),
    ).toBe("surface");
    expect(
      stripItemJoinPane(
        splitItem(tabSide("epic"), tabSide("history")),
        DEFAULT_LANDING,
      ),
    ).toBe("surface");
    expect(
      stripItemJoinPane(
        splitItem(tabSide("draft"), tabSide("history")),
        DEFAULT_LANDING,
      ),
    ).toBe("surface");
  });

  it("a split pair of a task and an empty slot joins the surface pane", () => {
    expect(
      stripItemJoinPane(
        splitItem(tabSide("epic"), EMPTY_SIDE),
        DEFAULT_LANDING,
      ),
    ).toBe("surface");
  });

  it("a split pair of a task and an unavailable tab joins the surface pane", () => {
    expect(
      stripItemJoinPane(
        splitItem(tabSide("epic"), UNAVAILABLE_SIDE),
        DEFAULT_LANDING,
      ),
    ).toBe("surface");
  });

  it("a split pair of History and an empty slot joins the canvas pane", () => {
    expect(
      stripItemJoinPane(
        splitItem(tabSide("history"), EMPTY_SIDE),
        DEFAULT_LANDING,
      ),
    ).toBe("canvas");
    expect(
      stripItemJoinPane(
        splitItem(EMPTY_SIDE, tabSide("history")),
        DEFAULT_LANDING,
      ),
    ).toBe("canvas");
  });

  it("a split pair of History and an unavailable tab joins the canvas pane", () => {
    expect(
      stripItemJoinPane(
        splitItem(tabSide("history"), UNAVAILABLE_SIDE),
        DEFAULT_LANDING,
      ),
    ).toBe("canvas");
  });

  describe("a split pair holding a draft whose terminal panel is open", () => {
    it("a maximized draft beside History joins the canvas pane", () => {
      expect(
        stripItemJoinPane(
          splitItem(tabSide("draft"), tabSide("history")),
          DRAFT_MAXIMIZED,
        ),
      ).toBe("canvas");
    });

    it("a maximized draft beside an empty slot joins the canvas pane", () => {
      expect(
        stripItemJoinPane(
          splitItem(tabSide("draft"), EMPTY_SIDE),
          DRAFT_MAXIMIZED,
        ),
      ).toBe("canvas");
    });

    it("a maximized draft beside a task joins the surface pane", () => {
      expect(
        stripItemJoinPane(
          splitItem(tabSide("draft"), tabSide("epic")),
          DRAFT_MAXIMIZED,
        ),
      ).toBe("surface");
    });

    it("a docked draft beside History joins the surface pane", () => {
      expect(
        stripItemJoinPane(
          splitItem(tabSide("draft"), tabSide("history")),
          DRAFT_DOCKED,
        ),
      ).toBe("surface");
    });
  });

  it("an item that is gone joins the surface pane: it was a task's", () => {
    expect(stripItemJoinPane(undefined, DEFAULT_LANDING)).toBe("surface");
    expect(stripItemJoinPane(undefined, DRAFT_MAXIMIZED)).toBe("surface");
  });
});
