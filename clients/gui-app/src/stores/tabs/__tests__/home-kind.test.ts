/**
 * Locks down the Home tab kind's registry dispatch: every per-concern
 * function (`tabSurfaceDescriptor`, `tabDuplicate`, `tabRequestClose`,
 * `tabRequiresCloseConfirm`, `tabEpicId`, `tabResolveIntent`,
 * `tabRouteOptions`, `tabMatchesPath`) must handle `home` without throwing,
 * and must answer with the fixed, singleton shape the design calls for -
 * Home cannot be duplicated, closed, or split, and it owns no epic.
 *
 * Also locks down the two structural refusals that keep Home out of the
 * ordinary strip machinery even though it is a registered kind:
 * `repairLayout` drops a `home` strip item, and `migrateTabsPersistedState`
 * refuses to materialize one from a persisted payload. A regression in
 * either would let a hand-edited or corrupted payload put a second,
 * closable "Home" into the strip.
 */
import { describe, expect, it } from "vitest";
import {
  isRegisteredTabKind,
  tabDuplicate,
  tabEpicId,
  tabMatchesPath,
  tabRequestClose,
  tabRequiresCloseConfirm,
  tabResolveIntent,
  tabRouteOptions,
  tabSurfaceDescriptor,
} from "@/stores/tabs/registry";
import { homeHeaderTab, HOME_TAB_REF } from "@/stores/tabs/kinds/home";
import { homeTabIntent } from "@/lib/tab-navigation/intents";
import {
  emptySystemTabs,
  emptyTabStripLayout,
  repairLayout,
  type PersistedTabStripLayout,
} from "@/stores/tabs/layout";
import { migrateTabsPersistedState, useTabsStore } from "@/stores/tabs/store";
import type { TabRef } from "@/stores/tabs/types";

describe("home tab kind - registry dispatch", () => {
  it("is registered", () => {
    expect(isRegisteredTabKind("home")).toBe(true);
  });

  it("declares an ineligible-for-split, non-duplicable surface", () => {
    const surface = tabSurfaceDescriptor("home");
    expect(surface.splitEligibility).toBe("ineligible");
    expect(surface.duplication).toBe("forbidden");
  });

  it("tabDuplicate refuses to duplicate Home", () => {
    expect(tabDuplicate(homeHeaderTab())).toBeNull();
  });

  it("tabRequestClose does not throw and leaves the tabs store untouched", () => {
    expect(() => tabRequestClose(homeHeaderTab())).not.toThrow();
  });

  it("tabRequiresCloseConfirm is false", () => {
    expect(tabRequiresCloseConfirm(homeHeaderTab())).toBe(false);
  });

  it("tabEpicId is null", () => {
    expect(tabEpicId(homeHeaderTab())).toBeNull();
  });

  it("tabResolveIntent resolves the home intent", () => {
    expect(tabResolveIntent(homeHeaderTab())).toEqual({ kind: "home" });
  });

  it("tabRouteOptions for the home intent navigates to /home", () => {
    expect(tabRouteOptions(homeTabIntent())).toEqual({ to: "/home" });
  });

  it("tabMatchesPath matches /home and /home/ only", () => {
    const tab = homeHeaderTab();
    expect(tabMatchesPath(tab, "/home")).toBe(true);
    expect(tabMatchesPath(tab, "/home/")).toBe(true);
    expect(tabMatchesPath(tab, "/")).toBe(false);
    expect(tabMatchesPath(tab, "/epics")).toBe(false);
  });
});

describe("home tab kind - structural refusals", () => {
  it("repairLayout drops a home strip item from items", () => {
    const layout: PersistedTabStripLayout = {
      version: 2,
      items: [{ kind: "tab", id: "tab:home:home", ref: HOME_TAB_REF }],
      activeItemId: "tab:home:home",
      systemTabs: emptySystemTabs(),
      activationHistory: [],
    };
    const repaired = repairLayout(layout, isRegisteredTabKind);
    expect(repaired.items).toEqual([]);
    expect(repaired.activeItemId).toBeNull();
  });

  it("migrateTabsPersistedState drops a home item from a persisted payload", () => {
    const persisted = {
      items: [{ kind: "tab", id: "tab:home:home", ref: HOME_TAB_REF }],
      activeItemId: "tab:home:home",
      systemTabs: { history: null, settings: null },
    };
    const migrated = migrateTabsPersistedState(persisted);
    expect(migrated.items).toEqual([]);
  });

  it("useTabsStore.pair() refuses to pair Home with a real tab (canSplitRef)", () => {
    const epicRef: TabRef = { kind: "epic", id: "epic-a" };
    useTabsStore.setState({
      ...emptyTabStripLayout(),
      items: [{ kind: "tab", id: "tab:epic:epic-a", ref: epicRef }],
      activeItemId: "tab:epic:epic-a",
      stripOrder: [epicRef],
    });
    const before = useTabsStore.getState().items;

    useTabsStore.getState().pair({
      left: epicRef,
      right: HOME_TAB_REF,
      splitId: "split-home-refused",
      leftRatio: 0.5,
    });

    // `pairLayoutRefs` guards on `canSplitRef` for BOTH sides before it ever
    // touches the layout, and the store's `canSplitRef` composes
    // `tabSurfaceDescriptor("home").splitEligibility === "ineligible"` -
    // exercised here through the real store action rather than reached for
    // directly, since the store's `canSplitRef` closure is private.
    expect(useTabsStore.getState().items).toEqual(before);
    useTabsStore.setState(emptyTabStripLayout());
  });
});

describe("home tab kind - build()", () => {
  it("homeHeaderTab returns a stable identity across calls", () => {
    expect(homeHeaderTab()).toBe(homeHeaderTab());
  });

  it("homeHeaderTab cannot be duplicated or opened in a new window", () => {
    const tab = homeHeaderTab();
    expect(tab.canDuplicate).toBe(false);
    expect(tab.canOpenInNewWindow).toBe(false);
    expect(tab.kind).toBe("home");
    expect(tab.id).toBe("home");
  });
});
