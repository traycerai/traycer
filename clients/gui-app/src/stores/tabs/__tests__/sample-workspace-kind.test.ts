import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
import { sampleWorkspaceTabModule } from "@/stores/tabs/kinds/sample-workspace";
import { ensureSampleWorkspaceTab } from "@/lib/customize/enter-exit";
import {
  emptySystemTabs,
  emptyTabStripLayout,
  flattenLayoutRefs,
  repairLayout,
  tabItemId,
  tabRefKey,
  withoutSampleWorkspace,
  type PersistedTabStripLayout,
} from "@/stores/tabs/layout";
import { migrateTabsPersistedState, useTabsStore } from "@/stores/tabs/store";
import {
  clearDesktopTabsPersistence,
  configureBrowserTabsPersistence,
  consumeDesktopRestoredRoute,
  flushDesktopTabsPersistence,
  hydrateDesktopTabs,
  installDesktopTabsPersistence,
  updateDesktopTabsActiveRoute,
} from "@/stores/tabs/desktop-tabs-persistence";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { useLandingDraftStore } from "@/stores/home/landing-draft-store";
import { useSettingsStore } from "@/stores/settings/settings-store";
import { tabCommandCoordinator } from "@/stores/tabs/tab-command-coordinator";
import type { TabRef } from "@/stores/tabs/types";
import type {
  DesktopPerWindowSnapshot,
  DesktopPerWindowStatePatch,
  DesktopWindowsBridge,
} from "@/lib/windows/types";

const SAMPLE_REF: TabRef = {
  kind: "sample-workspace",
  id: "sample-workspace",
};
const SAMPLE_ITEM_ID = tabItemId(SAMPLE_REF);

const CAPABILITIES = {
  schemaVersion: 2,
  features: ["tab-strip-layout-v2", "active-route-v1"],
} as const;

function emptySnapshot(): DesktopPerWindowSnapshot {
  return {
    epicTabs: [],
    activeTabId: null,
    canvasByTabId: {},
    landingDrafts: [],
    activeLandingDraftId: null,
    tabStripLayout: null,
    activeRoute: null,
  };
}

function acknowledgedBridge(
  updates: DesktopPerWindowStatePatch[],
): Pick<DesktopWindowsBridge, "perWindowState"> {
  let revision = 0;
  return {
    perWindowState: {
      get: () => Promise.resolve(emptySnapshot()),
      capabilities: () => Promise.resolve(CAPABILITIES),
      update: (patch) => {
        updates.push(patch);
        return Promise.resolve({
          capabilities: CAPABILITIES,
          revision: (revision += 1),
        });
      },
      onChange: () => ({ dispose: () => undefined }),
    },
  };
}

function sampleItems(layout: { items: PersistedTabStripLayout["items"] }) {
  return layout.items.filter(
    (item) => item.kind === "tab" && item.ref.kind === "sample-workspace",
  );
}

function resetStores(): void {
  useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
  useLandingDraftStore.setState({ drafts: [], activeDraftId: null });
  useTabsStore.setState({ ...emptyTabStripLayout(), stripOrder: [] });
  useSettingsStore.setState({ homeTabEnabled: false });
  tabCommandCoordinator.resetReconciliationForTesting();
}

beforeEach(() => {
  resetStores();
});

afterEach(() => {
  clearDesktopTabsPersistence();
  configureBrowserTabsPersistence();
  resetStores();
  vi.useRealTimers();
});

describe("sample-workspace kind - registration and descriptor", () => {
  it("is registered", () => {
    expect(isRegisteredTabKind("sample-workspace")).toBe(true);
  });

  it("declares the fixed, non-splittable, non-duplicable per-window surface", () => {
    const surface = tabSurfaceDescriptor("sample-workspace");
    expect(surface.splitEligibility).toBe("ineligible");
    expect(surface.duplication).toBe("forbidden");
    expect(surface.singleton).toBe("per-window");
    expect(surface.newWindow).toBe("none");
    expect(surface.readinessScope).toBe("none");
    expect(surface.durableState.owner).toBe("none");
  });

  it("build(null) returns the fixed header tab", () => {
    const tab = sampleWorkspaceTabModule.build(null);
    expect(tab.kind).toBe("sample-workspace");
    expect(tab.id).toBe("sample-workspace");
    expect(tab.name).toBe("Sample workspace");
    expect(tab.canDuplicate).toBe(false);
    expect(tab.canOpenInNewWindow).toBe(false);
    expect(tab.route).toBe("/sample-workspace");
  });

  it("canonicalRoute is /sample-workspace", () => {
    const tab = sampleWorkspaceTabModule.build(null);
    expect(tabSurfaceDescriptor("sample-workspace").canonicalRoute(tab)).toBe(
      "/sample-workspace",
    );
  });

  it("tabDuplicate refuses", () => {
    expect(tabDuplicate(sampleWorkspaceTabModule.build(null))).toBeNull();
  });

  it("tabRequiresCloseConfirm is false and tabEpicId is null", () => {
    const tab = sampleWorkspaceTabModule.build(null);
    expect(tabRequiresCloseConfirm(tab)).toBe(false);
    expect(tabEpicId(tab)).toBeNull();
  });

  it("resolves its own intent and route", () => {
    const tab = sampleWorkspaceTabModule.build(null);
    expect(tabResolveIntent(tab)).toEqual({ kind: "sample-workspace" });
    expect(tabRouteOptions({ kind: "sample-workspace" })).toEqual({
      to: "/sample-workspace",
    });
  });

  it("tabMatchesPath is exact", () => {
    const tab = sampleWorkspaceTabModule.build(null);
    expect(tabMatchesPath(tab, "/sample-workspace")).toBe(true);
    expect(tabMatchesPath(tab, "/sample-workspace/")).toBe(false);
    expect(tabMatchesPath(tab, "/sample-workspace/x")).toBe(false);
    expect(tabMatchesPath(tab, "/settings/general")).toBe(false);
    expect(tabMatchesPath(tab, "/")).toBe(false);
  });

  it("tabRequestClose is a plain close of the strip item", () => {
    ensureSampleWorkspaceTab({ kind: "none" });
    expect(sampleItems(useTabsStore.getState())).toHaveLength(1);

    tabRequestClose(sampleWorkspaceTabModule.build(null));

    expect(sampleItems(useTabsStore.getState())).toHaveLength(0);
  });
});

describe("sample-workspace kind - singleton open", () => {
  it("returns the sample-workspace intent", () => {
    expect(ensureSampleWorkspaceTab({ kind: "none" })).toEqual({
      kind: "sample-workspace",
    });
  });

  it("creates a strip item with the fixed ref/id", () => {
    ensureSampleWorkspaceTab({ kind: "none" });
    const items = sampleItems(useTabsStore.getState());
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      id: SAMPLE_ITEM_ID,
      ref: { ...SAMPLE_REF },
    });
  });

  it("opening twice yields one tab and the same intent", () => {
    const first = ensureSampleWorkspaceTab({ kind: "none" });
    const second = ensureSampleWorkspaceTab({
      kind: "settings-modal",
      section: "layout",
      scrollTop: 0,
    });
    expect(second).toEqual(first);
    expect(sampleItems(useTabsStore.getState())).toHaveLength(1);
  });

  it("only ensures presence - activation is a separate step", () => {
    const epicRef: TabRef = { kind: "epic", id: "epic-tab" };
    useTabsStore.setState({
      ...emptyTabStripLayout(),
      items: [{ kind: "tab", id: tabItemId(epicRef), ref: epicRef }],
      activeItemId: tabItemId(epicRef),
      stripOrder: [epicRef],
    });

    ensureSampleWorkspaceTab({ kind: "none" });

    expect(useTabsStore.getState().activeItemId).toBe(tabItemId(epicRef));
  });
});

describe("sample-workspace kind - persistence exclusion", () => {
  const epicRef: TabRef = { kind: "epic", id: "tab-a" };

  function layoutWithSample(): PersistedTabStripLayout {
    return {
      version: 2,
      items: [
        { kind: "tab", id: tabItemId(epicRef), ref: epicRef },
        { kind: "tab", id: SAMPLE_ITEM_ID, ref: { ...SAMPLE_REF } },
      ],
      activeItemId: SAMPLE_ITEM_ID,
      systemTabs: emptySystemTabs(),
      activationHistory: [],
    };
  }

  it("withoutSampleWorkspace removes it and reselects a neighbour", () => {
    const stripped = withoutSampleWorkspace(layoutWithSample());
    expect(sampleItems(stripped)).toHaveLength(0);
    expect(stripped.items).toHaveLength(1);
    expect(stripped.activeItemId).toBe(tabItemId(epicRef));
  });

  it("withoutSampleWorkspace is a no-op when the tab is absent", () => {
    const layout = {
      ...layoutWithSample(),
      items: layoutWithSample().items.slice(0, 1),
      activeItemId: tabItemId(epicRef),
    };
    expect(withoutSampleWorkspace(layout)).toEqual(layout);
  });
  const SAMPLE_KEY = tabRefKey(SAMPLE_REF);
  const EPIC_KEY = tabRefKey(epicRef);

  it("withoutSampleWorkspace drops the sample's customization and a group only it belonged to", () => {
    const layout: PersistedTabStripLayout = {
      ...layoutWithSample(),
      customizations: {
        [SAMPLE_KEY]: { color: null, icon: null, groupId: "sample-only" },
        [EPIC_KEY]: { color: "#8ab4f8", icon: null, groupId: null },
      },
      groups: {
        "sample-only": { name: "Studio", color: "#c58af9", collapsed: false },
      },
    };

    const stripped = withoutSampleWorkspace(layout);

    expect(sampleItems(stripped)).toHaveLength(0);
    expect(stripped.customizations).toEqual({
      [EPIC_KEY]: { color: "#8ab4f8", icon: null, groupId: null },
    });
    expect(stripped.groups).toEqual({});
    expect(JSON.stringify(stripped)).not.toContain("sample-workspace");
  });

  it("withoutSampleWorkspace keeps a shared group for its remaining members", () => {
    const layout: PersistedTabStripLayout = {
      ...layoutWithSample(),
      customizations: {
        [SAMPLE_KEY]: { color: null, icon: null, groupId: "shared" },
        [EPIC_KEY]: { color: null, icon: null, groupId: "shared" },
      },
      groups: {
        shared: { name: "Work", color: "#81c995", collapsed: false },
      },
    };

    const stripped = withoutSampleWorkspace(layout);

    expect(stripped.groups).toEqual({
      shared: { name: "Work", color: "#81c995", collapsed: false },
    });
    expect(stripped.customizations).toEqual({
      [EPIC_KEY]: { color: null, icon: null, groupId: "shared" },
    });
  });

  it("the browser persist partialize carries no sample customization or group", () => {
    useTabsStore.setState({
      ...emptyTabStripLayout(),
      ...layoutWithSample(),
      stripOrder: [epicRef, SAMPLE_REF],
      customizations: {
        [SAMPLE_KEY]: { color: "#ff8bcb", icon: null, groupId: "sample-only" },
      },
      groups: {
        "sample-only": { name: "Studio", color: "#c58af9", collapsed: false },
      },
    });

    const persisted = useTabsStore.persist
      .getOptions()
      .partialize?.(useTabsStore.getState());

    expect(JSON.stringify(persisted)).not.toContain("sample-workspace");
    expect(JSON.stringify(persisted)).not.toContain("sample-only");
  });

  it("the browser persist partialize never contains it", () => {
    useTabsStore.setState({
      ...emptyTabStripLayout(),
      ...layoutWithSample(),
      stripOrder: [epicRef, SAMPLE_REF],
    });
    const partialize = useTabsStore.persist.getOptions().partialize;
    expect(partialize).toBeDefined();
    const persisted = partialize?.(useTabsStore.getState());
    expect(JSON.stringify(persisted)).not.toContain("sample-workspace");
  });

  it("the desktop projection never contains it", async () => {
    vi.useFakeTimers();
    const tabId = useEpicCanvasStore
      .getState()
      .openEpicTabWithId("tab-a", "epic-a", "Alpha");
    const realEpic: TabRef = { kind: "epic", id: tabId };
    useTabsStore.getState().setStripOrder([realEpic]);
    useTabsStore.getState().ensurePresent(SAMPLE_REF);
    useTabsStore.getState().focusRef(realEpic);
    const updates: DesktopPerWindowStatePatch[] = [];
    installDesktopTabsPersistence(acknowledgedBridge(updates), 0);

    updateDesktopTabsActiveRoute("/epics/epic-a/tab-a");
    await flushDesktopTabsPersistence();

    expect(updates.length).toBeGreaterThan(0);
    for (const update of updates) {
      expect(JSON.stringify(update.tabStripLayout ?? null)).not.toContain(
        "sample-workspace",
      );
    }
    // The in-memory strip still has it - only the write drops it.
    expect(sampleItems(useTabsStore.getState())).toHaveLength(1);
  });

  it("a projection written while the sample tab is ACTIVE does not leave a dangling active id", async () => {
    vi.useFakeTimers();
    const tabId = useEpicCanvasStore
      .getState()
      .openEpicTabWithId("tab-a", "epic-a", "Alpha");
    useTabsStore.getState().setStripOrder([{ kind: "epic", id: tabId }]);
    useTabsStore.getState().ensurePresent(SAMPLE_REF);
    useTabsStore.getState().focusRef(SAMPLE_REF);
    const updates: DesktopPerWindowStatePatch[] = [];
    installDesktopTabsPersistence(acknowledgedBridge(updates), 0);

    updateDesktopTabsActiveRoute("/sample-workspace");
    await flushDesktopTabsPersistence();

    for (const update of updates) {
      const layout = update.tabStripLayout;
      expect(JSON.stringify(layout ?? null)).not.toContain("sample-workspace");
    }
  });
});

describe("sample-workspace kind - restore ignores it", () => {
  it("migrateTabsPersistedState drops a hand-written sample ref", () => {
    const migrated = migrateTabsPersistedState({
      items: [{ kind: "tab", id: SAMPLE_ITEM_ID, ref: { ...SAMPLE_REF } }],
      activeItemId: SAMPLE_ITEM_ID,
      systemTabs: { history: null, settings: null },
    });
    expect(sampleItems(migrated)).toHaveLength(0);
    expect(migrated.items).toEqual([]);
  });

  it("hydrateDesktopTabs ignores a persisted sample ref and its route", () => {
    const tabId = useEpicCanvasStore
      .getState()
      .openEpicTabWithId("tab-a", "epic-a", "Alpha");
    const epic: TabRef = { kind: "epic", id: tabId };

    hydrateDesktopTabs(
      {
        ...emptySnapshot(),
        revision: 3,
        epicTabs: [{ id: tabId, epicId: "epic-a", name: "Alpha" }],
        activeTabId: tabId,
        tabStripLayout: {
          version: 2,
          items: [
            { kind: "tab", id: tabItemId(epic), ref: { ...epic } },
            { kind: "tab", id: SAMPLE_ITEM_ID, ref: { ...SAMPLE_REF } },
          ],
          activeItemId: SAMPLE_ITEM_ID,
          systemTabs: { history: null, settings: null },
        },
        activeRoute: "/sample-workspace",
      },
      true,
      null,
    );

    expect(flattenLayoutRefs(useTabsStore.getState())).toEqual([epic]);
    expect(consumeDesktopRestoredRoute()).not.toBe("/sample-workspace");
  });
});

describe("sample-workspace kind - repairLayout", () => {
  const isKnown = isRegisteredTabKind;

  it("keeps the canonical ref", () => {
    const layout: PersistedTabStripLayout = {
      version: 2,
      items: [{ kind: "tab", id: SAMPLE_ITEM_ID, ref: { ...SAMPLE_REF } }],
      activeItemId: SAMPLE_ITEM_ID,
      systemTabs: emptySystemTabs(),
      activationHistory: [],
    };
    expect(repairLayout(layout, isKnown).items).toHaveLength(1);
  });

  it("drops a ref with any other id", () => {
    const bad: TabRef = { kind: "sample-workspace", id: "second" };
    const layout: PersistedTabStripLayout = {
      version: 2,
      items: [{ kind: "tab", id: tabItemId(bad), ref: bad }],
      activeItemId: tabItemId(bad),
      systemTabs: emptySystemTabs(),
      activationHistory: [],
    };
    expect(repairLayout(layout, isKnown).items).toEqual([]);
  });
});
