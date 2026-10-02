/**
 * `surface-join-pane.ts`: which pane's fill a tab's join takes, by what its
 * surface paints along the edge the tab runs into (`surfaceJoinPane(tab, edge,
 * landing)`).
 *
 * The rule is a switch per kind, so a new kind has to say what its surface
 * paints. This pins every kind on every edge, the one kind that reads state (a
 * draft, whose terminal panel is canvas where it is RENDERED), and the ways the
 * strip's own projection of an item names a pane (`headerItemJoinPane`, which
 * the sliding selection box reads and which composes the two rules an item's
 * resting box and drag overlay read): a lone tab, and a split pair.
 *
 * What the rule reads of a start page is the panel's published coverage
 * (`panelCoverage` in the landing pane anchor store): no entry for a page that
 * shows no panel, `docked` down its right side, `full` over the whole page. It
 * never reads the stored layout, which stays open and maximized for a page whose
 * panel is not rendered at all.
 *
 * A top pair joins `surface` when any member that holds a tab paints
 * `--background` along the top, and `canvas` otherwise: an empty or unavailable
 * side shows the slot chooser, which paints neither, so History (or a draft
 * whose full panel covers its page) beside one keeps the canvas.
 */
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  useLandingPaneAnchorStore,
  type LandingPanelCoverage,
} from "@/components/home/terminal-panel/landing-pane-anchor-store";
import type { SplitSide } from "@/stores/tabs/layout";
import type { HeaderTabKind } from "@/stores/tabs/registry";
import type { HeaderTab, TabRef } from "@/stores/tabs/types";
import type {
  HeaderStripItem,
  HeaderStripMember,
} from "@/stores/tabs/use-header-tabs";
import type { SheetJoinPane } from "../side-strip/side-tab-join";
import {
  headerItemJoinPane,
  headerSplitJoinPane,
  splitPairJoinPane,
  surfaceJoinPane,
  useHeaderItemJoinPane,
  useHeaderSplitJoinPane,
  useSurfaceJoinPane,
  type JoinEdge,
  type LandingPanelCoverages,
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

/** No start page publishes a panel: every one is closed or not rendered. */
const NO_COVERAGE: LandingPanelCoverages = new Map();

const DRAFT: TabRef = { kind: "draft", id: "draft-1" };
const OTHER_DRAFT: TabRef = { kind: "draft", id: "draft-2" };

/** `coverage` published for the draft with `draftId`, and nothing else. */
function coverageOf(
  draftId: string,
  coverage: LandingPanelCoverage,
): LandingPanelCoverages {
  return new Map([[draftId, coverage]]);
}

const DRAFT_FULL = coverageOf(DRAFT.id, "full");
const DRAFT_DOCKED = coverageOf(DRAFT.id, "docked");

function tabRef(kind: HeaderTabKind): TabRef {
  return { kind, id: `${kind}-1` };
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

const SETTINGS_TAB: HeaderTab = {
  kind: "settings",
  id: "settings",
  route: "/settings/general",
  name: "Settings",
  icon: null,
  canDuplicate: false,
  canOpenInNewWindow: false,
  lastPath: null,
};

const HOME_TAB: HeaderTab = {
  kind: "home",
  id: "home",
  route: "/",
  name: "Home",
  icon: null,
  canDuplicate: false,
  canOpenInNewWindow: false,
};

const SAMPLE_WORKSPACE_TAB: HeaderTab = {
  kind: "sample-workspace",
  id: "sample-workspace-1",
  route: "/sample-workspace/sample-workspace-1",
  name: "Sample workspace",
  icon: null,
  canDuplicate: false,
  canOpenInNewWindow: false,
};

/** One header tab of every kind, keyed by it: the strip's projection of each. */
const HEADER_TAB_BY_KIND: Readonly<Record<HeaderTabKind, HeaderTab>> = {
  epic: EPIC_TAB,
  draft: DRAFT_TAB,
  settings: SETTINGS_TAB,
  home: HOME_TAB,
  history: HISTORY_TAB,
  "sample-workspace": SAMPLE_WORKSPACE_TAB,
};

function tabMember(tab: HeaderTab): HeaderStripMember {
  return { kind: "tab", tab };
}

/** What `useHeaderItemJoinPane` is rendered with, so a rerender can drop the item. */
interface ItemProps {
  readonly item: HeaderStripItem | null;
}

/** A lone tab as the strip projects it. */
function headerTabItem(tab: HeaderTab): HeaderStripItem {
  return { kind: "tab", id: `tab:${tab.kind}:${tab.id}`, tab };
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
      expect(surfaceJoinPane(tabRef(kind), edge, NO_COVERAGE)).toBe(pane);
    },
  );

  describe("a draft, by what its terminal panel renders", () => {
    /** What a draft's join meets on each edge, by the coverage its panel publishes. */
    const DRAFT_PANE_BY_COVERAGE: ReadonlyArray<
      {
        readonly coverage: LandingPanelCoverage | null;
      } & Readonly<Record<JoinEdge, SheetJoinPane>>
    > = [
      { coverage: null, top: "surface", left: "surface", right: "surface" },
      { coverage: "docked", top: "surface", left: "surface", right: "canvas" },
      { coverage: "full", top: "canvas", left: "canvas", right: "canvas" },
    ];

    const DRAFT_PANE_BY_COVERAGE_AND_EDGE = DRAFT_PANE_BY_COVERAGE.flatMap(
      (row) =>
        EDGES.map((edge) => ({
          coverage: row.coverage ?? "none",
          landing:
            row.coverage === null
              ? NO_COVERAGE
              : coverageOf(DRAFT.id, row.coverage),
          edge,
          pane: row[edge],
        })),
    );

    it.each(DRAFT_PANE_BY_COVERAGE_AND_EDGE)(
      "joins the $pane pane at the $edge edge with $coverage coverage",
      ({ landing, edge, pane }) => {
        expect(surfaceJoinPane(DRAFT, edge, landing)).toBe(pane);
      },
    );

    it.each(EDGES)(
      "is not moved at the %s edge by another draft's panel",
      (edge) => {
        expect(
          surfaceJoinPane(OTHER_DRAFT, edge, coverageOf(DRAFT.id, "full")),
        ).toBe("surface");
        expect(
          surfaceJoinPane(OTHER_DRAFT, edge, coverageOf(DRAFT.id, "docked")),
        ).toBe("surface");
      },
    );

    it.each(EDGES)(
      "reads only its own entry at the %s edge when two drafts publish different coverage",
      (edge) => {
        const landing: LandingPanelCoverages = new Map<
          string,
          LandingPanelCoverage
        >([
          [DRAFT.id, "full"],
          [OTHER_DRAFT.id, "docked"],
        ]);
        expect(surfaceJoinPane(DRAFT, edge, landing)).toBe("canvas");
        expect(surfaceJoinPane(OTHER_DRAFT, edge, landing)).toBe(
          edge === "right" ? "canvas" : "surface",
        );
      },
    );
  });

  describe("every other kind, whatever the start page's panel is doing", () => {
    const OTHER_KINDS = PANE_BY_KIND_AND_EDGE.filter(
      (row) => row.kind !== "draft",
    );

    it.each(OTHER_KINDS)(
      "$kind still joins the $pane pane at the $edge edge with a draft's panel covering its page",
      ({ kind, edge, pane }) => {
        expect(surfaceJoinPane(tabRef(kind), edge, DRAFT_FULL)).toBe(pane);
      },
    );
  });
});

describe("splitPairJoinPane", () => {
  it.each(PANE_BY_KIND)(
    "a pair holding only $kind joins the $top pane",
    ({ kind, top }) => {
      expect(splitPairJoinPane([tabRef(kind)], NO_COVERAGE)).toBe(top);
    },
  );

  it("a pair holding no tab joins the canvas pane: the slot chooser paints neither", () => {
    expect(splitPairJoinPane([], NO_COVERAGE)).toBe("canvas");
  });

  it("History beside a task joins the surface pane, whichever side the task is on", () => {
    expect(
      splitPairJoinPane([tabRef("history"), tabRef("epic")], NO_COVERAGE),
    ).toBe("surface");
    expect(
      splitPairJoinPane([tabRef("epic"), tabRef("history")], NO_COVERAGE),
    ).toBe("surface");
  });

  it("History beside Settings or a draft joins the surface pane", () => {
    expect(
      splitPairJoinPane([tabRef("history"), tabRef("settings")], NO_COVERAGE),
    ).toBe("surface");
    expect(splitPairJoinPane([DRAFT, tabRef("history")], NO_COVERAGE)).toBe(
      "surface",
    );
  });

  it("two tasks join the surface pane", () => {
    expect(
      splitPairJoinPane([tabRef("epic"), tabRef("epic")], NO_COVERAGE),
    ).toBe("surface");
  });

  describe("with a draft whose terminal panel is rendered", () => {
    it("a draft with a full panel beside History joins the canvas pane: the panel covers the page", () => {
      expect(splitPairJoinPane([DRAFT, tabRef("history")], DRAFT_FULL)).toBe(
        "canvas",
      );
      expect(splitPairJoinPane([tabRef("history"), DRAFT], DRAFT_FULL)).toBe(
        "canvas",
      );
    });

    it("a draft with a full panel beside a task joins the surface pane: the task still paints it", () => {
      expect(splitPairJoinPane([DRAFT, tabRef("epic")], DRAFT_FULL)).toBe(
        "surface",
      );
    });

    it("a draft with a full panel alone in its pair joins the canvas pane", () => {
      expect(splitPairJoinPane([DRAFT], DRAFT_FULL)).toBe("canvas");
    });

    it("a docked draft beside History joins the surface pane: only the right edge meets the panel", () => {
      expect(splitPairJoinPane([DRAFT, tabRef("history")], DRAFT_DOCKED)).toBe(
        "surface",
      );
    });

    it("a draft with a full panel beside one with no panel joins the surface pane", () => {
      expect(splitPairJoinPane([DRAFT, OTHER_DRAFT], DRAFT_FULL)).toBe(
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
        NO_COVERAGE,
      ),
    ).toBe("canvas");
    expect(
      headerSplitJoinPane(
        headerSplit(EMPTY_MEMBER, tabMember(HISTORY_TAB)),
        NO_COVERAGE,
      ),
    ).toBe("canvas");
  });

  it("History beside an unavailable tab joins the canvas pane", () => {
    expect(
      headerSplitJoinPane(
        headerSplit(tabMember(HISTORY_TAB), UNAVAILABLE_MEMBER),
        NO_COVERAGE,
      ),
    ).toBe("canvas");
  });

  it("History beside a task joins the surface pane, whichever side the task is on", () => {
    expect(
      headerSplitJoinPane(
        headerSplit(tabMember(HISTORY_TAB), tabMember(EPIC_TAB)),
        NO_COVERAGE,
      ),
    ).toBe("surface");
    expect(
      headerSplitJoinPane(
        headerSplit(tabMember(EPIC_TAB), tabMember(HISTORY_TAB)),
        NO_COVERAGE,
      ),
    ).toBe("surface");
  });

  it("a task beside an empty slot joins the surface pane", () => {
    expect(
      headerSplitJoinPane(
        headerSplit(tabMember(EPIC_TAB), EMPTY_MEMBER),
        NO_COVERAGE,
      ),
    ).toBe("surface");
    expect(
      headerSplitJoinPane(
        headerSplit(EMPTY_MEMBER, tabMember(EPIC_TAB)),
        NO_COVERAGE,
      ),
    ).toBe("surface");
  });

  it("a task beside an unavailable tab joins the surface pane", () => {
    expect(
      headerSplitJoinPane(
        headerSplit(tabMember(EPIC_TAB), UNAVAILABLE_MEMBER),
        NO_COVERAGE,
      ),
    ).toBe("surface");
  });

  it("two tasks join the surface pane", () => {
    expect(
      headerSplitJoinPane(
        headerSplit(tabMember(EPIC_TAB), tabMember(EPIC_TAB)),
        NO_COVERAGE,
      ),
    ).toBe("surface");
  });

  it("a pair with no tab in it joins the canvas pane", () => {
    expect(
      headerSplitJoinPane(
        headerSplit(EMPTY_MEMBER, UNAVAILABLE_MEMBER),
        NO_COVERAGE,
      ),
    ).toBe("canvas");
  });

  it("a draft beside History joins the surface pane while it shows no panel", () => {
    expect(
      headerSplitJoinPane(
        headerSplit(tabMember(DRAFT_TAB), tabMember(HISTORY_TAB)),
        NO_COVERAGE,
      ),
    ).toBe("surface");
  });

  it("a draft with a full panel beside History or an empty slot joins the canvas pane", () => {
    expect(
      headerSplitJoinPane(
        headerSplit(tabMember(DRAFT_TAB), tabMember(HISTORY_TAB)),
        DRAFT_FULL,
      ),
    ).toBe("canvas");
    expect(
      headerSplitJoinPane(
        headerSplit(EMPTY_MEMBER, tabMember(DRAFT_TAB)),
        DRAFT_FULL,
      ),
    ).toBe("canvas");
  });

  it("a draft with a full panel beside a task joins the surface pane", () => {
    expect(
      headerSplitJoinPane(
        headerSplit(tabMember(DRAFT_TAB), tabMember(EPIC_TAB)),
        DRAFT_FULL,
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

describe("headerItemJoinPane", () => {
  describe("a lone tab", () => {
    it.each(PANE_BY_KIND)(
      "a lone $kind tab joins the $top pane",
      ({ kind, top }) => {
        expect(
          headerItemJoinPane(
            headerTabItem(HEADER_TAB_BY_KIND[kind]),
            NO_COVERAGE,
          ),
        ).toBe(top);
      },
    );

    it("a lone draft joins the surface pane while it shows no panel", () => {
      expect(headerItemJoinPane(headerTabItem(DRAFT_TAB), NO_COVERAGE)).toBe(
        "surface",
      );
    });

    it("a lone draft joins the surface pane while its panel is docked", () => {
      expect(headerItemJoinPane(headerTabItem(DRAFT_TAB), DRAFT_DOCKED)).toBe(
        "surface",
      );
    });

    it("a lone draft joins the canvas pane while its panel is full", () => {
      expect(headerItemJoinPane(headerTabItem(DRAFT_TAB), DRAFT_FULL)).toBe(
        "canvas",
      );
    });

    it("a lone draft is not moved by another draft's full panel", () => {
      expect(
        headerItemJoinPane(
          headerTabItem(DRAFT_TAB),
          coverageOf(OTHER_DRAFT.id, "full"),
        ),
      ).toBe("surface");
    });

    it("a lone task, Settings, Home and History ignore a draft's full panel", () => {
      for (const { kind, top } of PANE_BY_KIND) {
        if (kind === "draft") continue;
        expect(
          headerItemJoinPane(
            headerTabItem(HEADER_TAB_BY_KIND[kind]),
            DRAFT_FULL,
          ),
        ).toBe(top);
      }
    });
  });

  describe("a split pair", () => {
    it("two tasks join the surface pane", () => {
      expect(
        headerItemJoinPane(
          headerSplit(tabMember(EPIC_TAB), tabMember(EPIC_TAB)),
          NO_COVERAGE,
        ),
      ).toBe("surface");
    });

    it("History beside an empty slot joins the canvas pane: the slot paints no ground", () => {
      expect(
        headerItemJoinPane(
          headerSplit(tabMember(HISTORY_TAB), EMPTY_MEMBER),
          NO_COVERAGE,
        ),
      ).toBe("canvas");
      expect(
        headerItemJoinPane(
          headerSplit(EMPTY_MEMBER, tabMember(HISTORY_TAB)),
          NO_COVERAGE,
        ),
      ).toBe("canvas");
    });

    it("History beside an unavailable tab joins the canvas pane", () => {
      expect(
        headerItemJoinPane(
          headerSplit(tabMember(HISTORY_TAB), UNAVAILABLE_MEMBER),
          NO_COVERAGE,
        ),
      ).toBe("canvas");
    });

    it("History beside a task joins the surface pane, whichever side the task is on", () => {
      expect(
        headerItemJoinPane(
          headerSplit(tabMember(HISTORY_TAB), tabMember(EPIC_TAB)),
          NO_COVERAGE,
        ),
      ).toBe("surface");
      expect(
        headerItemJoinPane(
          headerSplit(tabMember(EPIC_TAB), tabMember(HISTORY_TAB)),
          NO_COVERAGE,
        ),
      ).toBe("surface");
    });

    it("a task beside an empty slot joins the surface pane", () => {
      expect(
        headerItemJoinPane(
          headerSplit(tabMember(EPIC_TAB), EMPTY_MEMBER),
          NO_COVERAGE,
        ),
      ).toBe("surface");
    });

    it("a task beside an unavailable tab joins the surface pane", () => {
      expect(
        headerItemJoinPane(
          headerSplit(tabMember(EPIC_TAB), UNAVAILABLE_MEMBER),
          NO_COVERAGE,
        ),
      ).toBe("surface");
    });

    it("a draft beside History joins the surface pane while it shows no panel", () => {
      expect(
        headerItemJoinPane(
          headerSplit(tabMember(DRAFT_TAB), tabMember(HISTORY_TAB)),
          NO_COVERAGE,
        ),
      ).toBe("surface");
    });

    describe("holding a draft whose terminal panel is open", () => {
      it("a draft with a full panel beside History joins the canvas pane", () => {
        expect(
          headerItemJoinPane(
            headerSplit(tabMember(DRAFT_TAB), tabMember(HISTORY_TAB)),
            DRAFT_FULL,
          ),
        ).toBe("canvas");
      });

      it("a draft with a full panel beside an empty slot joins the canvas pane", () => {
        expect(
          headerItemJoinPane(
            headerSplit(tabMember(DRAFT_TAB), EMPTY_MEMBER),
            DRAFT_FULL,
          ),
        ).toBe("canvas");
      });

      it("a draft with a full panel beside a task joins the surface pane", () => {
        expect(
          headerItemJoinPane(
            headerSplit(tabMember(DRAFT_TAB), tabMember(EPIC_TAB)),
            DRAFT_FULL,
          ),
        ).toBe("surface");
      });

      it("a docked draft beside History joins the surface pane", () => {
        expect(
          headerItemJoinPane(
            headerSplit(tabMember(DRAFT_TAB), tabMember(HISTORY_TAB)),
            DRAFT_DOCKED,
          ),
        ).toBe("surface");
      });
    });
  });
});

describe("the join hooks follow the coverage the panel publishes", () => {
  afterEach(() => {
    cleanup();
    useLandingPaneAnchorStore.setState(
      useLandingPaneAnchorStore.getInitialState(),
      true,
    );
  });

  function publish(
    draftId: string,
    coverage: LandingPanelCoverage | null,
  ): void {
    act(() => {
      useLandingPaneAnchorStore.getState().setPanelCoverage(draftId, coverage);
    });
  }

  describe("useSurfaceJoinPane", () => {
    it("moves a draft's right-edge join when its panel docks, and back when it retracts", () => {
      const { result } = renderHook(() => useSurfaceJoinPane(DRAFT, "right"));
      expect(result.current).toBe("surface");

      publish(DRAFT.id, "docked");
      expect(result.current).toBe("canvas");

      publish(DRAFT.id, null);
      expect(result.current).toBe("surface");
    });

    it("leaves a draft's top and left joins on the surface pane while its panel is docked", () => {
      const top = renderHook(() => useSurfaceJoinPane(DRAFT, "top"));
      const left = renderHook(() => useSurfaceJoinPane(DRAFT, "left"));

      publish(DRAFT.id, "docked");

      expect(top.result.current).toBe("surface");
      expect(left.result.current).toBe("surface");
    });

    it.each(EDGES)(
      "moves a draft's %s-edge join to the canvas pane when its panel goes full, and back when it retracts",
      (edge) => {
        const { result } = renderHook(() => useSurfaceJoinPane(DRAFT, edge));
        expect(result.current).toBe("surface");

        publish(DRAFT.id, "full");
        expect(result.current).toBe("canvas");

        publish(DRAFT.id, null);
        expect(result.current).toBe("surface");
      },
    );

    it("follows a docked panel growing to full", () => {
      const { result } = renderHook(() => useSurfaceJoinPane(DRAFT, "top"));

      publish(DRAFT.id, "docked");
      expect(result.current).toBe("surface");

      publish(DRAFT.id, "full");
      expect(result.current).toBe("canvas");
    });

    it("is not moved by another draft's panel", () => {
      const { result } = renderHook(() => useSurfaceJoinPane(DRAFT, "top"));

      publish(OTHER_DRAFT.id, "full");

      expect(result.current).toBe("surface");
    });

    it("answers null for no tab, whatever any panel publishes", () => {
      const { result } = renderHook(() => useSurfaceJoinPane(null, "top"));
      expect(result.current).toBeNull();

      publish(DRAFT.id, "full");
      expect(result.current).toBeNull();
    });

    it("does not move a task or History when a draft's panel goes full", () => {
      const task = renderHook(() => useSurfaceJoinPane(tabRef("epic"), "top"));
      const history = renderHook(() =>
        useSurfaceJoinPane(tabRef("history"), "top"),
      );

      publish(DRAFT.id, "full");

      expect(task.result.current).toBe("surface");
      expect(history.result.current).toBe("canvas");
    });
  });

  describe("useHeaderItemJoinPane", () => {
    it("answers null for no item, whatever any panel publishes", () => {
      const { result } = renderHook(() => useHeaderItemJoinPane(null));
      expect(result.current).toBeNull();

      publish(DRAFT.id, "full");
      expect(result.current).toBeNull();
    });

    it("moves a lone draft to the canvas pane only while its panel is full", () => {
      const item = headerTabItem(DRAFT_TAB);
      const { result } = renderHook(() => useHeaderItemJoinPane(item));
      expect(result.current).toBe("surface");

      publish(DRAFT.id, "docked");
      expect(result.current).toBe("surface");

      publish(DRAFT.id, "full");
      expect(result.current).toBe("canvas");

      publish(DRAFT.id, null);
      expect(result.current).toBe("surface");
    });

    it("moves a draft's pair with History to the canvas pane only while the panel is full", () => {
      const item = headerSplit(tabMember(DRAFT_TAB), tabMember(HISTORY_TAB));
      const { result } = renderHook(() => useHeaderItemJoinPane(item));
      expect(result.current).toBe("surface");

      publish(DRAFT.id, "docked");
      expect(result.current).toBe("surface");

      publish(DRAFT.id, "full");
      expect(result.current).toBe("canvas");
    });

    it("follows the item it is given: a rerender onto another item reads that item's pane", () => {
      publish(DRAFT.id, "full");
      const initialProps: ItemProps = { item: headerTabItem(DRAFT_TAB) };
      const { result, rerender } = renderHook(
        (props: ItemProps) => useHeaderItemJoinPane(props.item),
        { initialProps },
      );
      expect(result.current).toBe("canvas");

      rerender({ item: headerTabItem(EPIC_TAB) });
      expect(result.current).toBe("surface");

      rerender({ item: null });
      expect(result.current).toBeNull();
    });
  });

  describe("useHeaderSplitJoinPane", () => {
    it("keeps a draft's pair with a task on the surface pane while the draft's panel is full", () => {
      const item = headerSplit(tabMember(DRAFT_TAB), tabMember(EPIC_TAB));
      const { result } = renderHook(() => useHeaderSplitJoinPane(item));

      publish(DRAFT.id, "full");

      expect(result.current).toBe("surface");
    });

    it("moves a draft's pair with an empty slot to the canvas pane only while the panel is full", () => {
      const item = headerSplit(EMPTY_MEMBER, tabMember(DRAFT_TAB));
      const { result } = renderHook(() => useHeaderSplitJoinPane(item));
      expect(result.current).toBe("surface");

      publish(DRAFT.id, "docked");
      expect(result.current).toBe("surface");

      publish(DRAFT.id, "full");
      expect(result.current).toBe("canvas");

      publish(DRAFT.id, null);
      expect(result.current).toBe("surface");
    });
  });
});
