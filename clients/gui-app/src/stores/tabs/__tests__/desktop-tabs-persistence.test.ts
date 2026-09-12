import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  DesktopPerWindowSnapshot,
  DesktopPerWindowStatePatch,
  DesktopPerWindowStateUpdateAcknowledgement,
  DesktopWindowsBridge,
} from "@/lib/windows/types";
import {
  clearDesktopTabsPersistence,
  commitAppliedDesktopTabsSnapshot,
  configureBrowserTabsPersistence,
  configureDesktopTabsAuthority,
  flushDesktopTabsPersistence,
  hydrateDesktopTabs,
  installDesktopTabsPersistence,
  shouldApplyDesktopTabsSnapshot,
  updateDesktopTabsActiveRoute,
} from "@/stores/tabs/desktop-tabs-persistence";
import {
  emptyTabStripLayout,
  flattenLayoutRefs,
  tabItemId,
} from "@/stores/tabs/layout";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { useLandingDraftStore } from "@/stores/home/landing-draft-store";
import { useSettingsStore } from "@/stores/settings/settings-store";
import { useTabsStore } from "@/stores/tabs/store";
import { tabCommandCoordinator } from "@/stores/tabs/tab-command-coordinator";
import { getTabSplitCompatibility } from "@/stores/tabs/tab-split-compatibility";

const CAPABILITIES = {
  schemaVersion: 2,
  features: ["tab-strip-layout-v2", "active-route-v1"],
} as const;

type DesktopTabsBridge = Pick<DesktopWindowsBridge, "perWindowState">;

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

function tabsStorageKey(): string {
  const name = useTabsStore.persist.getOptions().name;
  if (name === undefined)
    throw new Error("tabs persistence storage key missing");
  return name;
}

function acknowledgedBridge(
  updates: DesktopPerWindowStatePatch[],
): DesktopTabsBridge {
  let revision = 0;
  return {
    perWindowState: {
      get: () => Promise.resolve(emptySnapshot()),
      capabilities: () => Promise.resolve(CAPABILITIES),
      update: (patch) => {
        updates.push(patch);
        const acknowledgement: DesktopPerWindowStateUpdateAcknowledgement = {
          capabilities: CAPABILITIES,
          revision: (revision += 1),
        };
        return Promise.resolve(acknowledgement);
      },
      onChange: () => ({ dispose: () => undefined }),
    },
  };
}

function unacknowledgedBridge(): DesktopTabsBridge {
  return {
    perWindowState: {
      get: () => Promise.resolve(emptySnapshot()),
      capabilities: () => Promise.resolve(CAPABILITIES),
      update: (_patch) => Promise.resolve(),
      onChange: () => ({ dispose: () => undefined }),
    },
  };
}

function resetStores(): void {
  useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
  useLandingDraftStore.setState({ drafts: [], activeDraftId: null });
  useTabsStore.setState({ ...emptyTabStripLayout(), stripOrder: [] });
  useSettingsStore.setState({ homeTabEnabled: false });
  tabCommandCoordinator.resetReconciliationForTesting();
}

/**
 * A snapshot with two epic tabs whose layout selection is Home's - a null
 * `activeItemId` over a populated strip, which only means Home while the flag
 * is on and means "unset" while it is off.
 */
function homeSelectedSnapshot(
  tabA: string,
  tabB: string,
  activeRoute: string,
): DesktopPerWindowSnapshot {
  return {
    ...emptySnapshot(),
    revision: 11,
    epicTabs: [
      { id: tabA, epicId: "epic-a", name: "Alpha" },
      { id: tabB, epicId: "epic-b", name: "Beta" },
    ],
    activeTabId: null,
    tabStripLayout: {
      version: 2,
      items: [
        {
          kind: "tab",
          id: tabItemId({ kind: "epic", id: tabA }),
          ref: { kind: "epic", id: tabA },
        },
        {
          kind: "tab",
          id: tabItemId({ kind: "epic", id: tabB }),
          ref: { kind: "epic", id: tabB },
        },
      ],
      activeItemId: null,
      systemTabs: { history: null, settings: null },
    },
    activeRoute,
  };
}

function openTwoEpicTabs(): { readonly tabA: string; readonly tabB: string } {
  const canvas = useEpicCanvasStore.getState();
  return {
    tabA: canvas.openEpicTabWithId("tab-a", "epic-a", "Alpha"),
    tabB: canvas.openEpicTabWithId("tab-b", "epic-b", "Beta"),
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  resetStores();
});

afterEach(() => {
  clearDesktopTabsPersistence();
  configureBrowserTabsPersistence();
  resetStores();
  vi.useRealTimers();
});

describe("desktop tabs persistence", () => {
  it("reconstructs legacy single items when a capable main has no v2 layout", () => {
    const tabId = useEpicCanvasStore
      .getState()
      .openEpicTabWithId("tab-a", "epic-a", "Alpha");

    hydrateDesktopTabs(
      {
        ...emptySnapshot(),
        revision: 7,
        epicTabs: [{ id: tabId, epicId: "epic-a", name: "Alpha" }],
        activeTabId: tabId,
      },
      true,
      null,
    );

    expect(flattenLayoutRefs(useTabsStore.getState())).toEqual([
      { kind: "epic", id: tabId },
    ]);
  });

  it("waits for route and active layout to agree before persisting one projection", async () => {
    const tabA = useEpicCanvasStore
      .getState()
      .openEpicTabWithId("tab-a", "epic-a", "Alpha");
    const tabB = useEpicCanvasStore
      .getState()
      .openEpicTabWithId("tab-b", "epic-b", "Beta");
    useTabsStore.getState().setStripOrder([
      { kind: "epic", id: tabA },
      { kind: "epic", id: tabB },
    ]);
    useTabsStore.getState().focusRef({ kind: "epic", id: tabA });
    const updates: DesktopPerWindowStatePatch[] = [];
    installDesktopTabsPersistence(acknowledgedBridge(updates), 0);

    updateDesktopTabsActiveRoute("/epics/epic-a/tab-a");
    await flushDesktopTabsPersistence();
    useTabsStore.getState().focusRef({ kind: "epic", id: tabB });

    await vi.advanceTimersByTimeAsync(100);
    expect(updates).toHaveLength(1);

    updateDesktopTabsActiveRoute("/epics/epic-b/tab-b");
    await flushDesktopTabsPersistence();

    expect(updates).toHaveLength(2);
    expect(updates[1]).toMatchObject({
      activeRoute: "/epics/epic-b/tab-b",
      tabStripLayout: { activeItemId: "tab:epic:tab-b" },
    });
  });

  it("rejects the flush barrier when desktop does not return a durable acknowledgement", async () => {
    const tabId = useEpicCanvasStore
      .getState()
      .openEpicTabWithId("tab-a", "epic-a", "Alpha");
    useTabsStore.getState().setStripOrder([{ kind: "epic", id: tabId }]);
    installDesktopTabsPersistence(unacknowledgedBridge(), 0);
    updateDesktopTabsActiveRoute("/epics/epic-a/tab-a");

    await expect(flushDesktopTabsPersistence()).rejects.toThrow(
      "Desktop did not acknowledge a durable tab projection",
    );
    expect(getTabSplitCompatibility().supported).toBe(false);
    await expect(flushDesktopTabsPersistence()).rejects.toThrow(
      "disabled after a failed write",
    );
  });

  it("rejects a well-formed acknowledgement older than the negotiated revision", async () => {
    const tabId = useEpicCanvasStore
      .getState()
      .openEpicTabWithId("tab-a", "epic-a", "Alpha");
    useTabsStore.getState().setStripOrder([{ kind: "epic", id: tabId }]);
    const bridge: DesktopTabsBridge = {
      perWindowState: {
        get: () => Promise.resolve(emptySnapshot()),
        capabilities: () => Promise.resolve(CAPABILITIES),
        update: () =>
          Promise.resolve({ capabilities: CAPABILITIES, revision: 4 }),
        onChange: () => ({ dispose: () => undefined }),
      },
    };
    installDesktopTabsPersistence(bridge, 5);
    updateDesktopTabsActiveRoute("/epics/epic-a/tab-a");

    await expect(flushDesktopTabsPersistence()).rejects.toThrow(
      "stale tab projection revision",
    );
    expect(getTabSplitCompatibility().supported).toBe(false);
  });

  it("rejects a write acknowledgement below an already-applied newer main snapshot", async () => {
    const tabA = useEpicCanvasStore
      .getState()
      .openEpicTabWithId("tab-a", "epic-a", "Alpha");
    const tabB = useEpicCanvasStore
      .getState()
      .openEpicTabWithId("tab-b", "epic-b", "Beta");
    useTabsStore.getState().setStripOrder([{ kind: "epic", id: tabA }]);
    let writeCount = 0;
    const bridge: DesktopTabsBridge = {
      perWindowState: {
        get: () => Promise.resolve(emptySnapshot()),
        capabilities: () => Promise.resolve(CAPABILITIES),
        update: () => {
          writeCount += 1;
          return Promise.resolve({
            capabilities: CAPABILITIES,
            revision: writeCount === 1 ? 6 : 7,
          });
        },
        onChange: () => ({ dispose: () => undefined }),
      },
    };
    installDesktopTabsPersistence(bridge, 5);
    updateDesktopTabsActiveRoute("/epics/epic-a/tab-a");
    await expect(flushDesktopTabsPersistence()).resolves.toMatchObject({
      revision: 6,
    });
    const mainSnapshot: DesktopPerWindowSnapshot = {
      ...emptySnapshot(),
      revision: 10,
      tabStripLayout: {
        version: 2,
        items: [
          {
            kind: "tab",
            id: tabItemId({ kind: "epic", id: tabA }),
            ref: { kind: "epic", id: tabA },
          },
          {
            kind: "tab",
            id: tabItemId({ kind: "epic", id: tabB }),
            ref: { kind: "epic", id: tabB },
          },
        ],
        activeItemId: tabItemId({ kind: "epic", id: tabA }),
        systemTabs: { history: null, settings: null },
      },
      activeRoute: "/epics/epic-a/tab-a",
    };

    expect(shouldApplyDesktopTabsSnapshot(mainSnapshot)).toBe(true);
    hydrateDesktopTabs(mainSnapshot, true, null);
    commitAppliedDesktopTabsSnapshot(mainSnapshot);

    await expect(flushDesktopTabsPersistence()).rejects.toThrow(
      "stale tab projection revision",
    );
    expect(getTabSplitCompatibility().supported).toBe(false);
  });

  it("accepts a write acknowledgement newer than a real hydrated main snapshot", async () => {
    const tabA = useEpicCanvasStore
      .getState()
      .openEpicTabWithId("tab-a", "epic-a", "Alpha");
    const tabB = useEpicCanvasStore
      .getState()
      .openEpicTabWithId("tab-b", "epic-b", "Beta");
    useTabsStore.getState().setStripOrder([{ kind: "epic", id: tabA }]);
    let writeCount = 0;
    const bridge: DesktopTabsBridge = {
      perWindowState: {
        get: () => Promise.resolve(emptySnapshot()),
        capabilities: () => Promise.resolve(CAPABILITIES),
        update: () => {
          writeCount += 1;
          return Promise.resolve({
            capabilities: CAPABILITIES,
            revision: writeCount === 1 ? 6 : 11,
          });
        },
        onChange: () => ({ dispose: () => undefined }),
      },
    };
    installDesktopTabsPersistence(bridge, 5);
    updateDesktopTabsActiveRoute("/epics/epic-a/tab-a");
    await expect(flushDesktopTabsPersistence()).resolves.toMatchObject({
      revision: 6,
    });
    const mainSnapshot: DesktopPerWindowSnapshot = {
      ...emptySnapshot(),
      revision: 10,
      tabStripLayout: {
        version: 2,
        items: [
          {
            kind: "tab",
            id: tabItemId({ kind: "epic", id: tabA }),
            ref: { kind: "epic", id: tabA },
          },
          {
            kind: "tab",
            id: tabItemId({ kind: "epic", id: tabB }),
            ref: { kind: "epic", id: tabB },
          },
        ],
        activeItemId: tabItemId({ kind: "epic", id: tabA }),
        systemTabs: { history: null, settings: null },
      },
      activeRoute: "/epics/epic-a/tab-a",
    };

    expect(shouldApplyDesktopTabsSnapshot(mainSnapshot)).toBe(true);
    hydrateDesktopTabs(mainSnapshot, true, null);
    commitAppliedDesktopTabsSnapshot(mainSnapshot);

    await expect(flushDesktopTabsPersistence()).resolves.toMatchObject({
      revision: 11,
    });
    expect(getTabSplitCompatibility().supported).toBe(true);
  });

  it("keeps browser tabs persistence enabled while splits are available", () => {
    const storageKey = tabsStorageKey();
    window.localStorage.removeItem(storageKey);
    configureDesktopTabsAuthority(false);
    configureBrowserTabsPersistence();

    useTabsStore.getState().setStripOrder([{ kind: "epic", id: "tab-a" }]);

    expect(getTabSplitCompatibility().supported).toBe(true);
    expect(window.localStorage.getItem(storageKey)).not.toBeNull();
  });

  it("resolves genuine browser-v1 source actives after hydration with strip-order precedence", async () => {
    const epicId = useEpicCanvasStore
      .getState()
      .openEpicTabWithId("tab-a", "epic-a", "Alpha");
    const draftId = useLandingDraftStore.getState().createDraft(null);
    useLandingDraftStore.getState().clearActiveDraft();
    const storageKey = tabsStorageKey();
    const v1Payload = JSON.stringify({
      state: {
        stripOrder: [
          { kind: "epic", id: epicId },
          { kind: "draft", id: draftId },
        ],
      },
      version: 1,
    });

    window.localStorage.setItem(storageKey, v1Payload);
    await useTabsStore.persist.rehydrate();
    tabCommandCoordinator.installSourceReconciliation();
    expect(useTabsStore.getState().activeItemId).toBe("tab:epic:tab-a");

    useLandingDraftStore.getState().setActiveDraft(draftId);
    window.localStorage.setItem(storageKey, v1Payload);
    await useTabsStore.persist.rehydrate();
    tabCommandCoordinator.setReconciliationReadyPromise(Promise.resolve());
    await Promise.resolve();
    await Promise.resolve();
    expect(useTabsStore.getState().activeItemId).toBe(`tab:draft:${draftId}`);
  });

  it("discards browser-v1 active selection when authoritative desktop-v2 focus wins", async () => {
    const tabId = useEpicCanvasStore
      .getState()
      .openEpicTabWithId("tab-a", "epic-a", "Alpha");
    const storageKey = tabsStorageKey();
    window.localStorage.setItem(
      storageKey,
      JSON.stringify({
        state: { stripOrder: [{ kind: "epic", id: tabId }] },
        version: 1,
      }),
    );
    await useTabsStore.persist.rehydrate();

    hydrateDesktopTabs(
      {
        ...emptySnapshot(),
        revision: 9,
        epicTabs: [{ id: tabId, epicId: "epic-a", name: "Alpha" }],
        activeTabId: tabId,
        tabStripLayout: {
          version: 2,
          items: [
            {
              kind: "split",
              id: "split-a",
              left: { kind: "tab", ref: { kind: "epic", id: tabId } },
              right: { kind: "empty" },
              focusedSide: "right",
              routeBackingSide: "left",
              leftRatio: 0.5,
            },
          ],
          activeItemId: "split-a",
          systemTabs: { history: null, settings: null },
        },
        activeRoute: "/epics/epic-a/tab-a",
      },
      true,
      null,
    );
    tabCommandCoordinator.setReconciliationReadyPromise(Promise.resolve());
    await Promise.resolve();

    const item = useTabsStore.getState().items[0];
    expect(item).toMatchObject({
      kind: "split",
      id: "split-a",
      focusedSide: "right",
      routeBackingSide: "left",
    });
  });

  /**
   * The desktop snapshot is the only path where a Home selection has to survive
   * a round trip through code that knows nothing about it: `repairLayout`
   * resolves a null active id to the first item, and every ref-keyed lookup in
   * this module answers `null` for a surface with no ref. Four private helpers
   * carry Home across that boundary, so the only way any of them can regress is
   * silently - hence both halves of the flag for each.
   */
  describe("Home selection across the desktop snapshot", () => {
    it("restores a Home-selected snapshot with the null selection, both tabs, and the /home route", () => {
      useSettingsStore.setState({ homeTabEnabled: true });
      const { tabA, tabB } = openTwoEpicTabs();

      const hydration = hydrateDesktopTabs(
        homeSelectedSnapshot(tabA, tabB, "/home"),
        true,
        null,
      );

      expect(useTabsStore.getState().activeItemId).toBeNull();
      expect(flattenLayoutRefs(useTabsStore.getState())).toEqual([
        { kind: "epic", id: tabA },
        { kind: "epic", id: tabB },
      ]);
      expect(hydration.route).toBe("/home");
    });

    it("restores the same snapshot onto the first tab with the flag off", () => {
      const { tabA, tabB } = openTwoEpicTabs();

      const hydration = hydrateDesktopTabs(
        homeSelectedSnapshot(tabA, tabB, "/home"),
        true,
        null,
      );

      // The byte-identical-when-off half: `repairLayout`'s own fallback stands,
      // and `routeRef("/home")` names nothing, so the route follows the layout.
      expect(useTabsStore.getState().activeItemId).toBe(
        tabItemId({ kind: "epic", id: tabA }),
      );
      expect(flattenLayoutRefs(useTabsStore.getState())).toEqual([
        { kind: "epic", id: tabA },
        { kind: "epic", id: tabB },
      ]);
      expect(hydration.route).toBe("/epics/epic-a/tab-a");
    });

    it("schedules a layout write while Home is active only once the route agrees", async () => {
      useSettingsStore.setState({ homeTabEnabled: true });
      const { tabA, tabB } = openTwoEpicTabs();
      useTabsStore.getState().setStripOrder([
        { kind: "epic", id: tabA },
        { kind: "epic", id: tabB },
      ]);
      const updates: DesktopPerWindowStatePatch[] = [];
      installDesktopTabsPersistence(acknowledgedBridge(updates), 0);

      // Home selected, but the URL still says `/` - the state a back-step onto
      // the landing route used to leave behind. Incoherent, so nothing is
      // written, and a layout change made here would be lost on quit.
      updateDesktopTabsActiveRoute("/");
      expect(
        tabCommandCoordinator.activateTab({ kind: "home" }),
      ).not.toBeNull();
      await vi.advanceTimersByTimeAsync(100);
      expect(updates).toHaveLength(0);

      updateDesktopTabsActiveRoute("/home");
      await flushDesktopTabsPersistence();

      expect(updates).toHaveLength(1);
      expect(updates[0]).toMatchObject({
        activeRoute: "/home",
        tabStripLayout: { activeItemId: null },
      });
    });
  });
});
