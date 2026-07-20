/**
 * T1 pure tests: layout v2 authority, ten invariants through every reducer,
 * v1/v2 migration repair, TAB_KINDS surface exhaustiveness, and multi-group
 * round-trips (ratios, active item, route backing).
 */
import { afterEach, describe, expect, expectTypeOf, it } from "vitest";
import {
  createEmptySplit,
  createLayoutItem,
  emptySystemTabs,
  emptyTabStripLayout,
  findStripItemForRef,
  flattenLayoutRefs,
  flattenStripItemRefs,
  focusLayoutRef,
  focusSplitSide,
  pairLayoutRefs,
  removeLayoutRef,
  repairLayout,
  reorderStripItem,
  replaceFillableSide,
  replaceLayoutRef,
  resizeSplit,
  separateSplit,
  swapSplitSides,
  tabItemId,
  tabRefKey,
  type CanSplitRef,
  type PersistedTabStripLayout,
  type SplitSide,
  type SplitSideName,
  type SplitStripItem,
  type StripItem,
  type SystemTabs,
} from "@/stores/tabs/layout";
import {
  isRegisteredTabKind,
  TAB_KINDS,
  TAB_KINDS_SURFACE_CONTRACT,
  tabSurfaceDescriptor,
  type HeaderTabKind,
} from "@/stores/tabs/registry";
import { epicTabModule } from "@/stores/tabs/kinds/epic";
import { draftTabModule } from "@/stores/tabs/kinds/draft";
import { historyTabModule } from "@/stores/tabs/kinds/history";
import { settingsTabModule } from "@/stores/tabs/kinds/settings";
import {
  EMPTY_LANDING_DRAFT_CONTENT,
  emptyLandingDraftWorkspaceSnapshot,
  type LandingDraftTab,
} from "@/stores/home/landing-draft-store";
import type { EpicViewTab } from "@/stores/epics/canvas/types";
import {
  makeSelectChooserIsFillable,
  makeSelectChooserSide,
  makeSelectHeaderItem,
  selectHeaderMemberRefs,
  selectHeaderStripItemIds,
  selectHostActiveItem,
  selectHostActiveSurfaceRefs,
  selectHostFocusedRef,
  selectHostRouteBackingRef,
} from "@/stores/tabs/selectors";
import { migrateTabsPersistedState, useTabsStore } from "@/stores/tabs/store";
import type {
  SystemTab,
  TabRef,
  TabSurfaceDescriptor,
} from "@/stores/tabs/types";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const EPIC_A: TabRef = { kind: "epic", id: "epic-tab-a" };
const EPIC_B: TabRef = { kind: "epic", id: "epic-tab-b" };
const EPIC_C: TabRef = { kind: "epic", id: "epic-tab-c" };
const EPIC_D: TabRef = { kind: "epic", id: "epic-tab-d" };
const DRAFT_A: TabRef = { kind: "draft", id: "draft-a" };
const HISTORY: TabRef = { kind: "history", id: "history" };
const SETTINGS: TabRef = { kind: "settings", id: "settings" };
const EPIC_SOURCE: EpicViewTab = {
  tabId: "epic-tab",
  epicId: "epic",
  name: "Epic",
};
const DRAFT_SOURCE: LandingDraftTab = {
  id: "draft",
  content: EMPTY_LANDING_DRAFT_CONTENT,
  selection: null,
  lastTouchedAt: 0,
  settings: null,
  composerMode: "chat",
  workspace: emptyLandingDraftWorkspaceSnapshot(),
};
const HISTORY_SOURCE: SystemTab = {
  id: "history",
  kind: "history",
  name: "History",
  lastPath: null,
};
const SETTINGS_SOURCE: SystemTab = {
  id: "settings",
  kind: "settings",
  name: "Settings",
  lastPath: null,
};

const allowAllSplits: CanSplitRef = (ref) =>
  tabSurfaceDescriptor(ref.kind).splitEligibility === "eligible";

const denyAllSplits: CanSplitRef = (_ref) => false;

function tabItem(ref: TabRef, id: string): StripItem {
  return { kind: "tab", id, ref };
}

function defaultTabItem(ref: TabRef): StripItem {
  return tabItem(ref, tabItemId(ref));
}

function splitItem(fields: {
  readonly id: string;
  readonly left: SplitSide;
  readonly right: SplitSide;
  readonly focusedSide: SplitSideName;
  readonly routeBackingSide: SplitSideName;
  readonly leftRatio: number;
}): SplitStripItem {
  return { kind: "split", ...fields };
}

function layoutOf(
  items: ReadonlyArray<StripItem>,
  activeItemId: string | null,
  systemTabs: SystemTabs,
): PersistedTabStripLayout {
  return {
    version: 2,
    items,
    activeItemId,
    systemTabs,
  };
}

function withTabs(refs: ReadonlyArray<TabRef>): PersistedTabStripLayout {
  return refs.reduce(createLayoutItem, emptyTabStripLayout());
}

function withSystemHistory(
  layout: PersistedTabStripLayout,
): PersistedTabStripLayout {
  return {
    ...layout,
    systemTabs: {
      history: {
        id: "history",
        kind: "history",
        name: "History",
        lastPath: null,
      },
      settings: layout.systemTabs.settings,
    },
  };
}

/**
 * Structural check for the ten layout invariants that can be verified on a
 * pure layout snapshot (descriptor policy is checked at call sites).
 */
function assertLayoutInvariants(layout: PersistedTabStripLayout): void {
  const refs = flattenLayoutRefs(layout);
  const keys = refs.map(tabRefKey);
  expect(new Set(keys).size).toBe(keys.length);

  refs.forEach((ref) => {
    expect(isRegisteredTabKind(ref.kind)).toBe(true);
    if (ref.kind === "history") expect(ref.id).toBe("history");
    if (ref.kind === "settings") expect(ref.id).toBe("settings");
  });

  layout.items
    .filter((item): item is SplitStripItem => item.kind === "split")
    .forEach((item) => {
      expect(item.left).toBeDefined();
      expect(item.right).toBeDefined();
      expect(flattenStripItemRefs(item).length).toBeGreaterThanOrEqual(1);

      const backing = item.routeBackingSide === "left" ? item.left : item.right;
      expect(backing.kind).toBe("tab");

      if (item.left.kind === "tab" && item.right.kind === "tab") {
        expect(tabRefKey(item.left.ref)).not.toBe(tabRefKey(item.right.ref));
      }

      expect(Number.isFinite(item.leftRatio)).toBe(true);
      expect(item.leftRatio).toBeGreaterThan(0);
      expect(item.leftRatio).toBeLessThan(1);
      expect(["left", "right"]).toContain(item.focusedSide);
      expect(["left", "right"]).toContain(item.routeBackingSide);
    });

  if (layout.items.length === 0) {
    expect(layout.activeItemId).toBeNull();
  } else {
    expect(layout.activeItemId).not.toBeNull();
    expect(
      layout.items.filter((item) => item.id === layout.activeItemId),
    ).toHaveLength(1);
  }

  expect(
    refs.filter((ref) => ref.kind === "history").length,
  ).toBeLessThanOrEqual(1);
  expect(
    refs.filter((ref) => ref.kind === "settings").length,
  ).toBeLessThanOrEqual(1);

  const ids = layout.items.map((item) => item.id);
  expect(new Set(ids).size).toBe(ids.length);
  expect(layout.version).toBe(2);
}

function resetTabsStore(): void {
  useTabsStore.setState({
    ...emptyTabStripLayout(),
    stripOrder: [],
  });
}

// ---------------------------------------------------------------------------
// Registry exhaustiveness
// ---------------------------------------------------------------------------

describe("TAB_KINDS surface exhaustiveness", () => {
  it("keeps registry keys, surface contract, and dispatcher aligned", () => {
    const expectedKinds: ReadonlyArray<HeaderTabKind> = [
      "draft",
      "epic",
      "history",
      "settings",
    ];
    expect(Object.keys(TAB_KINDS).length).toBe(expectedKinds.length);
    expectedKinds.forEach((kind) => {
      expect(Object.hasOwn(TAB_KINDS, kind)).toBe(true);
    });

    expect(TAB_KINDS_SURFACE_CONTRACT).toBe(TAB_KINDS);

    expectTypeOf(TAB_KINDS).toHaveProperty("epic");
    expectTypeOf(TAB_KINDS).toHaveProperty("draft");
    expectTypeOf(TAB_KINDS).toHaveProperty("history");
    expectTypeOf(TAB_KINDS).toHaveProperty("settings");

    expectTypeOf(tabSurfaceDescriptor("epic")).toEqualTypeOf<
      TabSurfaceDescriptor<"epic">
    >();
    expectTypeOf(tabSurfaceDescriptor("draft")).toEqualTypeOf<
      TabSurfaceDescriptor<"draft">
    >();
    expectTypeOf(tabSurfaceDescriptor("history")).toEqualTypeOf<
      TabSurfaceDescriptor<"history">
    >();
    expectTypeOf(tabSurfaceDescriptor("settings")).toEqualTypeOf<
      TabSurfaceDescriptor<"settings">
    >();

    expectTypeOf(TAB_KINDS.epic.descriptor.surface).toExtend<
      TabSurfaceDescriptor<"epic">
    >();
    expectTypeOf(TAB_KINDS.draft.descriptor.surface).toExtend<
      TabSurfaceDescriptor<"draft">
    >();
    expectTypeOf(TAB_KINDS.history.descriptor.surface).toExtend<
      TabSurfaceDescriptor<"history">
    >();
    expectTypeOf(TAB_KINDS.settings.descriptor.surface).toExtend<
      TabSurfaceDescriptor<"settings">
    >();

    const headerKinds: ReadonlyArray<HeaderTabKind> = [
      "epic",
      "draft",
      "history",
      "settings",
    ];
    headerKinds.forEach((kind) => {
      const surface = tabSurfaceDescriptor(kind);
      expect(surface).toHaveProperty("splitEligibility");
      expect(surface).toHaveProperty("duplication");
      expect(surface).toHaveProperty("singleton");
      expect(surface).toHaveProperty("newWindow");
      expect(surface).toHaveProperty("readinessScope");
      expect(surface.durableState.eviction).toBe("reconstruct");
      expect(typeof surface.render).toBe("function");
      expect(typeof surface.canonicalRoute).toBe("function");
      expect(tabSurfaceDescriptor(kind)).toEqual(
        TAB_KINDS[kind].descriptor.surface,
      );
    });
  });

  it("isRegisteredTabKind rejects unknown kinds", () => {
    expect(isRegisteredTabKind("epic")).toBe(true);
    expect(isRegisteredTabKind("unknown-kind")).toBe(false);
  });

  /**
   * `duplication` / `newWindow` on the surface descriptor and
   * `canDuplicate` / `canOpenInNewWindow` on the built `HeaderTab` describe
   * the same capability from two places. They must never disagree: split
   * commands read the descriptor while the strip reads the tab, so a drift
   * would let one path offer an action the other refuses.
   */
  it("surface capabilities agree with the built HeaderTab flags", () => {
    const cases = [
      {
        tab: epicTabModule.build(EPIC_SOURCE),
        surface: epicTabModule.descriptor.surface,
        expectedNewWindow: "move",
      },
      {
        tab: draftTabModule.build(DRAFT_SOURCE),
        surface: draftTabModule.descriptor.surface,
        expectedNewWindow: "none",
      },
      {
        tab: historyTabModule.build(HISTORY_SOURCE),
        surface: historyTabModule.descriptor.surface,
        expectedNewWindow: "copy",
      },
      {
        tab: settingsTabModule.build(SETTINGS_SOURCE),
        surface: settingsTabModule.descriptor.surface,
        expectedNewWindow: "copy",
      },
    ];

    cases.forEach((entry) => {
      expect(entry.tab.canDuplicate).toBe(
        entry.surface.duplication === "allowed",
      );
      expect(entry.tab.canOpenInNewWindow).toBe(
        entry.surface.newWindow !== "none",
      );
      expect(entry.surface.newWindow).toBe(entry.expectedNewWindow);
    });
  });
});

// ---------------------------------------------------------------------------
// Invariants through every pure reducer
// ---------------------------------------------------------------------------

describe("layout reducers preserve invariants", () => {
  describe("createLayoutItem", () => {
    it("appends a tab, activates it, and is a no-op on duplicates", () => {
      const first = createLayoutItem(emptyTabStripLayout(), EPIC_A);
      assertLayoutInvariants(first);
      expect(first.items).toHaveLength(1);
      expect(first.activeItemId).toBe(tabItemId(EPIC_A));

      const again = createLayoutItem(first, EPIC_A);
      expect(again).toBe(first);

      const second = createLayoutItem(first, EPIC_B);
      assertLayoutInvariants(second);
      expect(flattenLayoutRefs(second).map(tabRefKey)).toEqual([
        tabRefKey(EPIC_A),
        tabRefKey(EPIC_B),
      ]);
      expect(second.activeItemId).toBe(tabItemId(EPIC_B));
    });
  });

  describe("pairLayoutRefs", () => {
    it("forms a complete split from two flat tabs (invariant 2, 5)", () => {
      const next = pairLayoutRefs(
        withTabs([EPIC_A, EPIC_B, DRAFT_A]),
        {
          left: EPIC_A,
          right: EPIC_B,
          splitId: "split-1",
          leftRatio: 0.4,
        },
        allowAllSplits,
      );
      assertLayoutInvariants(next);
      expect(next.items).toHaveLength(2);
      const split = next.items.find(
        (item): item is SplitStripItem => item.kind === "split",
      );
      expect(split).toMatchObject({
        id: "split-1",
        leftRatio: 0.4,
        focusedSide: "right",
        routeBackingSide: "right",
      });
      expect(next.activeItemId).toBe("split-1");
      expect(next.items.some((item) => item.kind === "tab")).toBe(true);
    });

    it("rejects same-ref, missing refs, and descriptor-ineligible refs (inv 5, 7)", () => {
      const base = withTabs([EPIC_A, EPIC_B]);
      expect(
        pairLayoutRefs(
          base,
          {
            left: EPIC_A,
            right: EPIC_A,
            splitId: "s",
            leftRatio: 0.5,
          },
          allowAllSplits,
        ),
      ).toBe(base);
      expect(
        pairLayoutRefs(
          base,
          {
            left: EPIC_A,
            right: EPIC_C,
            splitId: "s",
            leftRatio: 0.5,
          },
          allowAllSplits,
        ),
      ).toBe(base);
      expect(
        pairLayoutRefs(
          base,
          {
            left: EPIC_A,
            right: EPIC_B,
            splitId: "s",
            leftRatio: 0.5,
          },
          denyAllSplits,
        ),
      ).toBe(base);
    });

    it("does not pair members already inside a split (inv 9 edge-split source)", () => {
      const withSplit = pairLayoutRefs(
        withTabs([EPIC_A, EPIC_B, EPIC_C]),
        {
          left: EPIC_A,
          right: EPIC_B,
          splitId: "split-ab",
          leftRatio: 0.5,
        },
        allowAllSplits,
      );
      const attempted = pairLayoutRefs(
        withSplit,
        {
          left: EPIC_A,
          right: EPIC_C,
          splitId: "split-bad",
          leftRatio: 0.5,
        },
        allowAllSplits,
      );
      expect(attempted).toBe(withSplit);
      assertLayoutInvariants(attempted);
    });

    it("falls back to default ratio when pair ratio is invalid (inv 10)", () => {
      const next = pairLayoutRefs(
        withTabs([EPIC_A, EPIC_B]),
        {
          left: EPIC_A,
          right: EPIC_B,
          splitId: "split-ratio",
          leftRatio: 1.5,
        },
        allowAllSplits,
      );
      assertLayoutInvariants(next);
      const split = next.items[0];
      expect(split.kind).toBe("split");
      if (split.kind === "split") expect(split.leftRatio).toBe(0.5);
    });
  });

  describe("createEmptySplit", () => {
    it("creates an incomplete group with stable route backing (inv 2, 4)", () => {
      const next = createEmptySplit(
        withTabs([EPIC_A]),
        {
          ref: EPIC_A,
          splitId: "empty-split",
          populatedSide: "left",
          focusedSide: "right",
          leftRatio: 0.55,
        },
        allowAllSplits,
      );
      assertLayoutInvariants(next);
      expect(next.items[0]).toMatchObject({
        kind: "split",
        id: "empty-split",
        left: { kind: "tab", ref: EPIC_A },
        right: { kind: "empty" },
        focusedSide: "right",
        routeBackingSide: "left",
        leftRatio: 0.55,
      });
    });
  });

  describe("replaceFillableSide", () => {
    it("fills empty and unavailable uniformly and drops unavailable metadata (inv 8)", () => {
      const incomplete = createEmptySplit(
        withTabs([EPIC_A]),
        {
          ref: EPIC_A,
          splitId: "fill-me",
          populatedSide: "left",
          focusedSide: "right",
          leftRatio: 0.5,
        },
        allowAllSplits,
      );
      const withUnavailable: PersistedTabStripLayout = {
        ...incomplete,
        items: incomplete.items.map((item) =>
          item.kind === "split"
            ? {
                ...item,
                right: {
                  kind: "unavailable",
                  previousRef: EPIC_B,
                  label: "Gone",
                },
              }
            : item,
        ),
      };

      const filledUnavailable = replaceFillableSide(
        withUnavailable,
        { splitId: "fill-me", side: "right", ref: DRAFT_A },
        allowAllSplits,
      );
      assertLayoutInvariants(filledUnavailable);
      const split = filledUnavailable.items[0];
      expect(split.kind).toBe("split");
      if (split.kind === "split") {
        expect(split.right).toEqual({ kind: "tab", ref: DRAFT_A });
        expect(Object.hasOwn(split.right, "previousRef")).toBe(false);
        expect(Object.hasOwn(split.right, "label")).toBe(false);
      }

      const blocked = replaceFillableSide(
        filledUnavailable,
        { splitId: "fill-me", side: "left", ref: EPIC_C },
        allowAllSplits,
      );
      expect(blocked).toBe(filledUnavailable);

      // EPIC_B already exists as a flat tab — fill must no-op (inv 1)
      const withSibling = createEmptySplit(
        withTabs([EPIC_A, EPIC_B]),
        {
          ref: EPIC_A,
          splitId: "fill-2",
          populatedSide: "left",
          focusedSide: "right",
          leftRatio: 0.5,
        },
        allowAllSplits,
      );
      const dup = replaceFillableSide(
        withSibling,
        { splitId: "fill-2", side: "right", ref: EPIC_B },
        allowAllSplits,
      );
      expect(findStripItemForRef(dup, EPIC_B)?.kind).toBe("tab");
    });
  });

  describe("focusLayoutRef / focusSplitSide", () => {
    it("activates tab items and focuses split members; empty focus keeps route backing (inv 3, 4)", () => {
      const focusedFlat = focusLayoutRef(withTabs([EPIC_A, EPIC_B]), EPIC_A);
      assertLayoutInvariants(focusedFlat);
      expect(focusedFlat.activeItemId).toBe(tabItemId(EPIC_A));

      const paired = pairLayoutRefs(
        focusedFlat,
        {
          left: EPIC_A,
          right: EPIC_B,
          splitId: "focus-split",
          leftRatio: 0.5,
        },
        allowAllSplits,
      );
      const focusedMember = focusLayoutRef(paired, EPIC_A);
      assertLayoutInvariants(focusedMember);
      const split = focusedMember.items[0];
      expect(split.kind).toBe("split");
      if (split.kind === "split") {
        expect(split.focusedSide).toBe("left");
        expect(split.routeBackingSide).toBe("left");
      }

      const incomplete = createEmptySplit(
        withTabs([EPIC_A]),
        {
          ref: EPIC_A,
          splitId: "focus-empty",
          populatedSide: "left",
          focusedSide: "left",
          leftRatio: 0.5,
        },
        allowAllSplits,
      );
      const focusedEmpty = focusSplitSide(incomplete, {
        splitId: "focus-empty",
        side: "right",
      });
      assertLayoutInvariants(focusedEmpty);
      const emptySplit = focusedEmpty.items[0];
      expect(emptySplit.kind).toBe("split");
      if (emptySplit.kind === "split") {
        expect(emptySplit.focusedSide).toBe("right");
        expect(emptySplit.routeBackingSide).toBe("left");
      }
    });
  });

  describe("resizeSplit / swapSplitSides", () => {
    it("resizes with valid ratios only and swaps sides with inverted ratio (inv 10)", () => {
      const base = pairLayoutRefs(
        withTabs([EPIC_A, EPIC_B]),
        {
          left: EPIC_A,
          right: EPIC_B,
          splitId: "resize-split",
          leftRatio: 0.3,
        },
        allowAllSplits,
      );
      const resized = resizeSplit(base, {
        splitId: "resize-split",
        leftRatio: 0.7,
      });
      assertLayoutInvariants(resized);
      expect(
        resized.items[0]?.kind === "split" && resized.items[0].leftRatio,
      ).toBe(0.7);

      const rejected = resizeSplit(resized, {
        splitId: "resize-split",
        leftRatio: 0,
      });
      expect(rejected).toBe(resized);

      const swapped = swapSplitSides(resized, "resize-split");
      assertLayoutInvariants(swapped);
      const split = swapped.items[0];
      expect(split.kind).toBe("split");
      if (split.kind === "split") {
        expect(split.left).toEqual({ kind: "tab", ref: EPIC_B });
        expect(split.right).toEqual({ kind: "tab", ref: EPIC_A });
        expect(split.leftRatio).toBeCloseTo(0.3);
        expect(split.focusedSide).toBe("left");
        expect(split.routeBackingSide).toBe("left");
      }

      const background = {
        ...swapped,
        items: [...swapped.items, defaultTabItem(EPIC_C)],
        activeItemId: tabItemId(EPIC_C),
      };
      const backgroundSwap = swapSplitSides(background, "resize-split");
      assertLayoutInvariants(backgroundSwap);
      expect(backgroundSwap.activeItemId).toBe(tabItemId(EPIC_C));
    });
  });

  describe("separateSplit", () => {
    it("expands members to flat tabs and activates the focused member", () => {
      const paired = pairLayoutRefs(
        withTabs([EPIC_A, EPIC_B]),
        {
          left: EPIC_A,
          right: EPIC_B,
          splitId: "sep",
          leftRatio: 0.5,
        },
        allowAllSplits,
      );
      const focused = focusLayoutRef(paired, EPIC_A);
      const separated = separateSplit(focused, "sep");
      assertLayoutInvariants(separated);
      expect(separated.items.map((item) => item.kind)).toEqual(["tab", "tab"]);
      expect(separated.activeItemId).toBe(tabItemId(EPIC_A));
    });

    it("separates incomplete groups to a single tab", () => {
      const incomplete = createEmptySplit(
        withTabs([EPIC_A]),
        {
          ref: EPIC_A,
          splitId: "sep-empty",
          populatedSide: "right",
          focusedSide: "left",
          leftRatio: 0.5,
        },
        allowAllSplits,
      );
      const separated = separateSplit(incomplete, "sep-empty");
      assertLayoutInvariants(separated);
      expect(separated.items).toEqual([defaultTabItem(EPIC_A)]);
      expect(separated.activeItemId).toBe(tabItemId(EPIC_A));
    });

    it("preserves a background active item when separating complete or incomplete groups", () => {
      const complete = pairLayoutRefs(
        withTabs([EPIC_A, EPIC_B, EPIC_C]),
        {
          left: EPIC_A,
          right: EPIC_B,
          splitId: "sep-background",
          leftRatio: 0.5,
        },
        allowAllSplits,
      );
      const completeBackground = {
        ...complete,
        activeItemId: tabItemId(EPIC_C),
      };
      const completeSeparated = separateSplit(
        completeBackground,
        "sep-background",
      );
      assertLayoutInvariants(completeSeparated);
      expect(completeSeparated.activeItemId).toBe(tabItemId(EPIC_C));

      const incomplete = createEmptySplit(
        withTabs([EPIC_A, EPIC_C]),
        {
          ref: EPIC_A,
          splitId: "sep-incomplete-background",
          populatedSide: "left",
          focusedSide: "right",
          leftRatio: 0.5,
        },
        allowAllSplits,
      );
      const incompleteBackground = {
        ...incomplete,
        activeItemId: tabItemId(EPIC_C),
      };
      const incompleteSeparated = separateSplit(
        incompleteBackground,
        "sep-incomplete-background",
      );
      assertLayoutInvariants(incompleteSeparated);
      expect(incompleteSeparated.activeItemId).toBe(tabItemId(EPIC_C));
    });
  });

  describe("replaceLayoutRef / removeLayoutRef", () => {
    it("replaces refs inside splits without duplicating", () => {
      const paired = pairLayoutRefs(
        withTabs([EPIC_A, EPIC_B]),
        {
          left: EPIC_A,
          right: EPIC_B,
          splitId: "rep",
          leftRatio: 0.5,
        },
        allowAllSplits,
      );
      const replaced = replaceLayoutRef(paired, {
        previous: EPIC_B,
        next: EPIC_C,
      });
      assertLayoutInvariants(replaced);
      expect(flattenLayoutRefs(replaced).map(tabRefKey)).toEqual([
        tabRefKey(EPIC_A),
        tabRefKey(EPIC_C),
      ]);

      const noDup = replaceLayoutRef(replaced, {
        previous: EPIC_A,
        next: EPIC_C,
      });
      expect(noDup).toBe(replaced);
    });

    it("replaces a flat tab without leaving a dead active item", () => {
      const flat = replaceLayoutRef(withTabs([EPIC_A]), {
        previous: EPIC_A,
        next: EPIC_B,
      });
      assertLayoutInvariants(flat);
      expect(flat.items).toEqual([defaultTabItem(EPIC_B)]);
      expect(flat.activeItemId).toBe(tabItemId(EPIC_B));
      expect(
        flat.items.filter((item) => item.id === flat.activeItemId),
      ).toHaveLength(1);
    });

    it("collapses a split when one member is removed; drops empty groups", () => {
      const paired = pairLayoutRefs(
        withTabs([EPIC_A, EPIC_B, DRAFT_A]),
        {
          left: EPIC_A,
          right: EPIC_B,
          splitId: "rm",
          leftRatio: 0.5,
        },
        allowAllSplits,
      );
      const afterOne = removeLayoutRef(paired, EPIC_A);
      assertLayoutInvariants(afterOne);
      expect(findStripItemForRef(afterOne, EPIC_B)?.kind).toBe("tab");
      expect(afterOne.activeItemId).toBe(tabItemId(EPIC_B));

      const incomplete = createEmptySplit(
        withTabs([EPIC_A]),
        {
          ref: EPIC_A,
          splitId: "rm-empty",
          populatedSide: "left",
          focusedSide: "left",
          leftRatio: 0.5,
        },
        allowAllSplits,
      );
      const cleared = removeLayoutRef(incomplete, EPIC_A);
      assertLayoutInvariants(cleared);
      expect(cleared.items).toEqual([]);
      expect(cleared.activeItemId).toBeNull();
    });

    it("selects the normal neighbor after removing the active leftmost, middle, or rightmost item", () => {
      const base = withTabs([EPIC_A, EPIC_B, EPIC_C]);
      const leftmost = removeLayoutRef(
        { ...base, activeItemId: tabItemId(EPIC_A) },
        EPIC_A,
      );
      const middle = removeLayoutRef(
        { ...base, activeItemId: tabItemId(EPIC_B) },
        EPIC_B,
      );
      const rightmost = removeLayoutRef(
        { ...base, activeItemId: tabItemId(EPIC_C) },
        EPIC_C,
      );

      [leftmost, middle, rightmost].forEach(assertLayoutInvariants);
      expect(leftmost.activeItemId).toBe(tabItemId(EPIC_B));
      expect(middle.activeItemId).toBe(tabItemId(EPIC_A));
      expect(rightmost.activeItemId).toBe(tabItemId(EPIC_B));
    });
  });

  describe("reorderStripItem", () => {
    it("reorders whole groups including incomplete ones as single units (inv 9)", () => {
      const complete = pairLayoutRefs(
        withTabs([EPIC_A, EPIC_B]),
        {
          left: EPIC_A,
          right: EPIC_B,
          splitId: "g1",
          leftRatio: 0.4,
        },
        allowAllSplits,
      );
      const withDraft = createLayoutItem(complete, DRAFT_A);
      const incomplete = createEmptySplit(
        withDraft,
        {
          ref: DRAFT_A,
          splitId: "g2",
          populatedSide: "left",
          focusedSide: "right",
          leftRatio: 0.6,
        },
        allowAllSplits,
      );
      const withHistory = withSystemHistory(
        createLayoutItem(incomplete, HISTORY),
      );
      assertLayoutInvariants(withHistory);

      const reordered = reorderStripItem(withHistory, {
        itemId: "g2",
        targetIndex: 0,
      });
      assertLayoutInvariants(reordered);
      expect(reordered.items.map((item) => item.id)).toEqual([
        "g2",
        "g1",
        tabItemId(HISTORY),
      ]);
      expect(reordered.items.find((item) => item.id === "g1")?.kind).toBe(
        "split",
      );
      expect(reordered.items.find((item) => item.id === "g2")?.kind).toBe(
        "split",
      );
    });

    it("prefers an exact tab item id over a colliding raw split alias", () => {
      const tabId = tabItemId(EPIC_A);
      const paired = pairLayoutRefs(
        withTabs([EPIC_A, EPIC_B, EPIC_C]),
        {
          left: EPIC_B,
          right: EPIC_C,
          splitId: tabId,
          leftRatio: 0.5,
        },
        allowAllSplits,
      );
      const unchanged = reorderStripItem(paired, {
        itemId: tabId,
        targetIndex: 0,
      });
      const movedAfterSplit = reorderStripItem(paired, {
        itemId: tabId,
        targetIndex: 2,
      });

      [paired, unchanged, movedAfterSplit].forEach(assertLayoutInvariants);
      expect(unchanged.items.map((item) => item.id)).toEqual([
        tabId,
        `split:${tabId}`,
      ]);
      expect(movedAfterSplit.items.map((item) => item.id)).toEqual([
        `split:${tabId}`,
        tabId,
      ]);
    });
  });

  describe("repairLayout", () => {
    it("repairs duplicates, invalid ratios, dead active ids, zero-member groups, invalid route backing (inv 10)", () => {
      const malformed = layoutOf(
        [
          tabItem(EPIC_A, "tab-a"),
          tabItem(EPIC_A, "dup-a"),
          splitItem({
            id: "bad-split",
            left: { kind: "tab", ref: EPIC_B },
            right: { kind: "tab", ref: EPIC_B },
            focusedSide: "left",
            routeBackingSide: "right",
            leftRatio: 2,
          }),
          splitItem({
            id: "zero-member",
            left: { kind: "empty" },
            right: { kind: "empty" },
            focusedSide: "left",
            routeBackingSide: "left",
            leftRatio: 0.5,
          }),
          splitItem({
            id: "bad-backing",
            left: { kind: "empty" },
            right: { kind: "tab", ref: DRAFT_A },
            focusedSide: "left",
            routeBackingSide: "left",
            leftRatio: 0.5,
          }),
        ],
        "missing-active",
        {
          history: {
            id: "history",
            kind: "history",
            name: "History",
            lastPath: null,
          },
          settings: null,
        },
      );

      const repaired = repairLayout(malformed, isRegisteredTabKind);
      assertLayoutInvariants(repaired);

      expect(flattenLayoutRefs(repaired).map(tabRefKey)).toEqual([
        tabRefKey(EPIC_A),
        tabRefKey(EPIC_B),
        tabRefKey(DRAFT_A),
      ]);
      expect(repaired.activeItemId).toBe(repaired.items[0]?.id);

      const badBacking = repaired.items.find(
        (item) => item.id === "bad-backing",
      );
      expect(badBacking?.kind).toBe("split");
      if (badBacking?.kind === "split") {
        expect(badBacking.routeBackingSide).toBe("right");
        expect(badBacking.leftRatio).toBe(0.5);
      }

      const fixedRatio = repaired.items.find((item) => item.id === "bad-split");
      expect(fixedRatio?.kind).toBe("split");
      if (fixedRatio?.kind === "split") {
        expect(fixedRatio.leftRatio).toBe(0.5);
        expect(fixedRatio.right.kind).toBe("empty");
        expect(fixedRatio.routeBackingSide).toBe("left");
      }

      expect(repaired.items.some((item) => item.id === "zero-member")).toBe(
        false,
      );
      expect(repaired.systemTabs.history?.kind).toBe("history");
    });

    it("remaps active ids only to retained items after duplicate and empty entries are dropped", () => {
      const duplicateRef = repairLayout(
        layoutOf(
          [tabItem(EPIC_A, "kept"), tabItem(EPIC_A, "duplicate")],
          "duplicate",
          emptySystemTabs(),
        ),
        isRegisteredTabKind,
      );
      const emptySplit = repairLayout(
        layoutOf(
          [
            splitItem({
              id: "same",
              left: { kind: "empty" },
              right: { kind: "empty" },
              focusedSide: "left",
              routeBackingSide: "left",
              leftRatio: 0.5,
            }),
            tabItem(EPIC_A, "same"),
          ],
          "same",
          emptySystemTabs(),
        ),
        isRegisteredTabKind,
      );

      [duplicateRef, emptySplit].forEach(assertLayoutInvariants);
      expect(duplicateRef.activeItemId).toBe(tabItemId(EPIC_A));
      expect(emptySplit.activeItemId).toBe(tabItemId(EPIC_A));
    });

    it("dedupes hydrated split ids while keeping the active item addressable", () => {
      const repaired = repairLayout(
        layoutOf(
          [
            splitItem({
              id: "same",
              left: { kind: "tab", ref: EPIC_A },
              right: { kind: "tab", ref: EPIC_B },
              focusedSide: "left",
              routeBackingSide: "left",
              leftRatio: 0.5,
            }),
            splitItem({
              id: "same",
              left: { kind: "tab", ref: EPIC_C },
              right: { kind: "tab", ref: EPIC_D },
              focusedSide: "right",
              routeBackingSide: "right",
              leftRatio: 0.5,
            }),
          ],
          "same",
          emptySystemTabs(),
        ),
        isRegisteredTabKind,
      );

      assertLayoutInvariants(repaired);
      expect(repaired.items.map((item) => item.id)).toEqual(["same", "same-2"]);
      expect(repaired.activeItemId).toBe("same");
    });

    it("drops unknown kinds via migration, dedupes item ids, normalizes system tabs, and strips system refs without systemTabs", () => {
      const migrated = migrateTabsPersistedState({
        version: 2,
        activeItemId: "same",
        items: [
          { kind: "tab", id: "same", ref: EPIC_A },
          { kind: "tab", id: "same", ref: EPIC_B },
          { kind: "tab", id: "ghost", ref: { kind: "ghost", id: "x" } },
          { kind: "tab", id: "hist", ref: HISTORY },
        ],
        systemTabs: {
          history: {
            id: "wrong",
            kind: "history",
            name: "H",
            lastPath: "/history",
          },
          settings: {
            id: "wrong",
            kind: "settings",
            name: "S",
            lastPath: null,
          },
        },
      });
      assertLayoutInvariants(migrated);
      expect(flattenLayoutRefs(migrated).map(tabRefKey)).toEqual([
        tabRefKey(EPIC_A),
        tabRefKey(EPIC_B),
        tabRefKey(HISTORY),
      ]);
      expect(migrated.systemTabs.history?.id).toBe("history");
      expect(migrated.systemTabs.settings?.id).toBe("settings");

      // History/settings strip members require matching systemTabs entries.
      const orphanSystem = repairLayout(
        layoutOf(
          [defaultTabItem(HISTORY), defaultTabItem(SETTINGS)],
          tabItemId(HISTORY),
          emptySystemTabs(),
        ),
        isRegisteredTabKind,
      );
      assertLayoutInvariants(orphanSystem);
      expect(orphanSystem.items).toEqual([]);
      expect(orphanSystem.activeItemId).toBeNull();
    });
  });
});

// ---------------------------------------------------------------------------
// Migration: valid + malformed v1 (stripOrder) and v2 (items)
// ---------------------------------------------------------------------------

describe("migrateTabsPersistedState", () => {
  it("returns an empty v2 layout for non-objects", () => {
    const empty = migrateTabsPersistedState(null);
    expect(empty.version).toBe(2);
    expect(empty.items).toEqual([]);
    expect(empty.activeItemId).toBeNull();
    expect(empty.systemTabs).toEqual(emptySystemTabs());
    expect(flattenLayoutRefs(empty)).toEqual([]);

    expect(migrateTabsPersistedState("nope").items).toEqual([]);
    expect(migrateTabsPersistedState(undefined).items).toEqual([]);
  });

  it("migrates valid v1 stripOrder into flat tab items", () => {
    const migrated = migrateTabsPersistedState({
      stripOrder: [EPIC_A, DRAFT_A, HISTORY],
      systemTabs: {
        history: {
          id: "history",
          kind: "history",
          name: "History",
          lastPath: "/history",
        },
        settings: null,
      },
    });
    assertLayoutInvariants(migrated);
    expect(migrated.version).toBe(2);
    expect(migrated.items.map((item) => item.kind)).toEqual([
      "tab",
      "tab",
      "tab",
    ]);
    expect(flattenLayoutRefs(migrated)).toEqual([EPIC_A, DRAFT_A, HISTORY]);
    expect(migrated.activeItemId).toBe(tabItemId(HISTORY));
    expect(migrated.systemTabs.history?.lastPath).toBe("/history");
  });

  it("repairs malformed v1 stripOrder (unknown kinds, bad ids, duplicates)", () => {
    const migrated = migrateTabsPersistedState({
      stripOrder: [
        EPIC_A,
        EPIC_A,
        { kind: "epic" },
        { kind: "ghost", id: "x" },
        { kind: "history", id: "not-history" },
        HISTORY,
        null,
        "string",
      ],
      // Malformed systemTabs → empty after parse; orphan HISTORY strip ref is
      // then removed by repair (system singleton must be backed by systemTabs).
      systemTabs: { history: "bad", settings: { kind: "settings" } },
    });
    assertLayoutInvariants(migrated);
    expect(flattenLayoutRefs(migrated)).toEqual([EPIC_A]);
    expect(migrated.systemTabs).toEqual(emptySystemTabs());
  });

  it("hydrates valid v2 layouts with complete and incomplete groups", () => {
    const payload = {
      version: 2,
      activeItemId: "split-complete",
      systemTabs: {
        history: null,
        settings: {
          id: "settings",
          kind: "settings",
          name: "Settings",
          lastPath: "/settings/general",
        },
      },
      items: [
        {
          kind: "split",
          id: "split-complete",
          left: { kind: "tab", ref: EPIC_A },
          right: { kind: "tab", ref: EPIC_B },
          focusedSide: "left",
          routeBackingSide: "left",
          leftRatio: 0.35,
        },
        {
          kind: "split",
          id: "split-incomplete",
          left: {
            kind: "unavailable",
            previousRef: EPIC_C,
            label: "Missing epic",
          },
          right: { kind: "tab", ref: DRAFT_A },
          focusedSide: "left",
          routeBackingSide: "right",
          leftRatio: 0.6,
        },
        {
          kind: "tab",
          id: "tab:settings:settings",
          ref: SETTINGS,
        },
      ],
    };

    const migrated = migrateTabsPersistedState(payload);
    assertLayoutInvariants(migrated);
    expect(migrated.activeItemId).toBe("split-complete");
    expect(migrated.items).toHaveLength(3);

    const complete = migrated.items[0];
    expect(complete.kind).toBe("split");
    if (complete.kind === "split") {
      expect(complete.leftRatio).toBe(0.35);
      expect(complete.focusedSide).toBe("left");
      expect(complete.routeBackingSide).toBe("left");
    }

    const incomplete = migrated.items[1];
    expect(incomplete.kind).toBe("split");
    if (incomplete.kind === "split") {
      expect(incomplete.left).toEqual({
        kind: "unavailable",
        previousRef: EPIC_C,
        label: "Missing epic",
      });
      expect(incomplete.routeBackingSide).toBe("right");
      expect(incomplete.leftRatio).toBe(0.6);
    }

    expect(migrated.systemTabs.settings?.lastPath).toBe("/settings/general");
  });

  it("repairs malformed v2 payloads while keeping parseable items", () => {
    const migrated = migrateTabsPersistedState({
      version: 2,
      activeItemId: "does-not-exist",
      items: [
        {
          kind: "tab",
          id: "ok",
          ref: EPIC_A,
        },
        {
          kind: "split",
          id: "drop-me",
          focusedSide: "left",
          routeBackingSide: "left",
          leftRatio: 0.5,
        },
        {
          kind: "split",
          id: "fix-ratio",
          left: { kind: "tab", ref: EPIC_B },
          right: { kind: "empty" },
          focusedSide: "right",
          routeBackingSide: "left",
          leftRatio: -1,
        },
        {
          kind: "tab",
          id: "dup",
          ref: EPIC_A,
        },
        {
          kind: "tab",
          id: "bad-kind",
          ref: { kind: "nope", id: "x" },
        },
        null,
        { kind: "tab" },
      ],
      systemTabs: {
        history: {
          id: "history",
          kind: "history",
          name: "History",
          lastPath: null,
        },
        settings: null,
      },
    });

    assertLayoutInvariants(migrated);
    expect(flattenLayoutRefs(migrated).map(tabRefKey)).toEqual([
      tabRefKey(EPIC_A),
      tabRefKey(EPIC_B),
    ]);
    expect(migrated.activeItemId).toBe(tabItemId(EPIC_A));
    const fixed = migrated.items.find((item) => item.id === "fix-ratio");
    expect(fixed?.kind).toBe("split");
    if (fixed?.kind === "split") {
      expect(fixed.leftRatio).toBe(0.5);
      expect(fixed.focusedSide).toBe("right");
      expect(fixed.routeBackingSide).toBe("left");
    }
  });

  it("repairs malformed split fields independently without losing valid members", () => {
    const invalidRatio = migrateTabsPersistedState({
      items: [
        {
          kind: "split",
          id: "recover-ratio",
          left: { kind: "tab", ref: EPIC_A },
          right: { kind: "tab", ref: EPIC_B },
          focusedSide: "left",
          routeBackingSide: "left",
          leftRatio: null,
        },
      ],
    });
    const invalidBacking = migrateTabsPersistedState({
      items: [
        {
          kind: "split",
          id: "recover-backing",
          left: { kind: "tab", ref: EPIC_A },
          right: { kind: "tab", ref: EPIC_B },
          focusedSide: "left",
          routeBackingSide: "middle",
          leftRatio: 0.4,
        },
      ],
    });
    const unknownPartner = migrateTabsPersistedState({
      items: [
        {
          kind: "split",
          id: "recover-member",
          left: { kind: "tab", ref: { kind: "unknown", id: "gone" } },
          right: { kind: "tab", ref: EPIC_B },
          focusedSide: "left",
          routeBackingSide: "middle",
          leftRatio: null,
        },
      ],
    });

    [invalidRatio, invalidBacking, unknownPartner].forEach(
      assertLayoutInvariants,
    );
    expect(flattenLayoutRefs(invalidRatio).map(tabRefKey)).toEqual([
      tabRefKey(EPIC_A),
      tabRefKey(EPIC_B),
    ]);
    expect(flattenLayoutRefs(invalidBacking).map(tabRefKey)).toEqual([
      tabRefKey(EPIC_A),
      tabRefKey(EPIC_B),
    ]);
    expect(flattenLayoutRefs(unknownPartner)).toEqual([EPIC_B]);
  });

  it("normalizes a colliding hydrated split id before creating its tab-shaped peer", () => {
    const hydrated = migrateTabsPersistedState({
      items: [
        {
          kind: "split",
          id: tabItemId(EPIC_B),
          left: { kind: "tab", ref: EPIC_A },
          right: { kind: "empty" },
          focusedSide: "right",
          routeBackingSide: "left",
          leftRatio: 0.5,
        },
      ],
    });
    const created = createLayoutItem(hydrated, EPIC_B);

    assertLayoutInvariants(created);
    expect(created.activeItemId).toBe(tabItemId(EPIC_B));
    expect(
      created.items.filter((item) => item.id === tabItemId(EPIC_B)),
    ).toHaveLength(1);
    expect(created.items[0]?.id).not.toBe(tabItemId(EPIC_B));

    const paired = pairLayoutRefs(
      withTabs([EPIC_A, EPIC_B, EPIC_C]),
      {
        left: EPIC_A,
        right: EPIC_B,
        splitId: tabItemId(EPIC_C),
        leftRatio: 0.5,
      },
      allowAllSplits,
    );
    const empty = createEmptySplit(
      withTabs([EPIC_A, EPIC_B]),
      {
        ref: EPIC_A,
        splitId: tabItemId(EPIC_B),
        populatedSide: "left",
        focusedSide: "right",
        leftRatio: 0.5,
      },
      allowAllSplits,
    );
    const separated = separateSplit(paired, tabItemId(EPIC_C));

    [paired, empty, separated].forEach(assertLayoutInvariants);
    expect(paired.items[0]?.id).not.toBe(tabItemId(EPIC_C));
    expect(empty.items[0]?.id).not.toBe(tabItemId(EPIC_B));
    expect(separated.items.map((item) => item.kind)).toEqual([
      "tab",
      "tab",
      "tab",
    ]);
  });

  it("allocates fresh ids for splits created with the same requested id", () => {
    const first = pairLayoutRefs(
      withTabs([EPIC_A, EPIC_B, EPIC_C, EPIC_D]),
      {
        left: EPIC_A,
        right: EPIC_B,
        splitId: "same",
        leftRatio: 0.5,
      },
      allowAllSplits,
    );
    const second = pairLayoutRefs(
      first,
      {
        left: EPIC_C,
        right: EPIC_D,
        splitId: "same",
        leftRatio: 0.5,
      },
      allowAllSplits,
    );

    assertLayoutInvariants(second);
    expect(second.items.map((item) => item.id)).toEqual(["same", "same-2"]);
    expect(second.activeItemId).toBe("same-2");
  });

  it("prefers v2 items over legacy stripOrder when items array is present", () => {
    const migrated = migrateTabsPersistedState({
      items: [{ kind: "tab", id: "from-v2", ref: EPIC_A }],
      stripOrder: [EPIC_B, DRAFT_A],
      activeItemId: "from-v2",
    });
    expect(flattenLayoutRefs(migrated)).toEqual([EPIC_A]);
  });
});

// ---------------------------------------------------------------------------
// Multi-group round-trip: ratios, active item, route backing + selectors
// ---------------------------------------------------------------------------

describe("multi-group round-trip", () => {
  afterEach(() => {
    resetTabsStore();
  });

  it("preserves ratios, active item, and route backing across reducer sequences", () => {
    let layout = withTabs([EPIC_A, EPIC_B, DRAFT_A, HISTORY]);
    layout = withSystemHistory(layout);

    layout = pairLayoutRefs(
      layout,
      {
        left: EPIC_A,
        right: EPIC_B,
        splitId: "group-complete",
        leftRatio: 0.42,
      },
      allowAllSplits,
    );
    layout = createEmptySplit(
      layout,
      {
        ref: DRAFT_A,
        splitId: "group-incomplete",
        populatedSide: "right",
        focusedSide: "left",
        leftRatio: 0.61,
      },
      allowAllSplits,
    );
    // EPIC_C is not already on the strip, so fill is allowed (inv 1).
    layout = replaceFillableSide(
      layout,
      {
        splitId: "group-incomplete",
        side: "left",
        ref: EPIC_C,
      },
      allowAllSplits,
    );
    layout = resizeSplit(layout, {
      splitId: "group-complete",
      leftRatio: 0.33,
    });
    layout = reorderStripItem(layout, {
      itemId: "group-incomplete",
      targetIndex: 0,
    });
    layout = swapSplitSides(layout, "group-complete");
    // Extra singleton coexists with groups; re-focus incomplete afterward so
    // active item / route backing stay on the incomplete group for selectors.
    layout = createLayoutItem(layout, EPIC_D);
    layout = focusSplitSide(layout, {
      splitId: "group-incomplete",
      side: "right",
    });

    assertLayoutInvariants(layout);

    const beforeRepair = structuredClone(layout);
    const afterRepair = repairLayout(layout, isRegisteredTabKind);
    assertLayoutInvariants(afterRepair);

    expect(afterRepair.activeItemId).toBe(beforeRepair.activeItemId);
    expect(afterRepair.items.map((item) => item.id)).toEqual(
      beforeRepair.items.map((item) => item.id),
    );

    const complete = afterRepair.items.find(
      (item) => item.id === "group-complete",
    );
    expect(complete?.kind).toBe("split");
    if (complete?.kind === "split") {
      expect(complete.leftRatio).toBeCloseTo(0.67);
      expect(complete.left).toEqual({ kind: "tab", ref: EPIC_B });
      expect(complete.right).toEqual({ kind: "tab", ref: EPIC_A });
    }

    const incomplete = afterRepair.items.find(
      (item) => item.id === "group-incomplete",
    );
    expect(incomplete?.kind).toBe("split");
    if (incomplete?.kind === "split") {
      expect(incomplete.leftRatio).toBe(0.61);
      expect(incomplete.focusedSide).toBe("right");
      expect(incomplete.routeBackingSide).toBe("right");
      expect(incomplete.left).toEqual({ kind: "tab", ref: EPIC_C });
      expect(incomplete.right).toEqual({ kind: "tab", ref: DRAFT_A });
    }

    const persisted = {
      version: 2,
      items: afterRepair.items,
      activeItemId: afterRepair.activeItemId,
      systemTabs: afterRepair.systemTabs,
    };
    const rehydrated = migrateTabsPersistedState(persisted);
    assertLayoutInvariants(rehydrated);
    expect(rehydrated.activeItemId).toBe(afterRepair.activeItemId);
    expect(rehydrated.items).toEqual(afterRepair.items);
    expect(rehydrated.systemTabs.history?.id).toBe("history");

    const projectedStripOrder = flattenLayoutRefs(rehydrated);
    useTabsStore.setState({
      version: rehydrated.version,
      items: rehydrated.items,
      activeItemId: rehydrated.activeItemId,
      systemTabs: rehydrated.systemTabs,
      stripOrder: projectedStripOrder,
    });
    const storeState = useTabsStore.getState();

    expect(selectHeaderStripItemIds(storeState)).toEqual(
      rehydrated.items.map((item) => item.id),
    );
    expect(selectHeaderMemberRefs(storeState)).toEqual(projectedStripOrder);
    expect(selectHostActiveItem(storeState)?.id).toBe(rehydrated.activeItemId);
    expect(selectHostActiveSurfaceRefs(storeState).map(tabRefKey)).toEqual([
      tabRefKey(EPIC_C),
      tabRefKey(DRAFT_A),
    ]);
    expect(selectHostFocusedRef(storeState)).toEqual(DRAFT_A);
    expect(selectHostRouteBackingRef(storeState)).toEqual(DRAFT_A);
    expect(makeSelectHeaderItem("group-complete")(storeState)?.kind).toBe(
      "split",
    );
    expect(
      makeSelectChooserSide("group-incomplete", "left")(storeState),
    ).toEqual({ kind: "tab", ref: EPIC_C });
    expect(
      makeSelectChooserIsFillable("group-incomplete", "left")(storeState),
    ).toBe(false);

    const separated = separateSplit(rehydrated, "group-incomplete");
    assertLayoutInvariants(separated);
    expect(separated.items.some((item) => item.id === "group-incomplete")).toBe(
      false,
    );
  });
});
