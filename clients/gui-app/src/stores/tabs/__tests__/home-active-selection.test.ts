/**
 * Locks down "Home is active" == `activeItemId === null`.
 *
 * That state only means Home while `homeTabEnabled` is on - with the flag
 * off, a populated strip must never legitimately sit on a null selection, so
 * every commit boundary (`committedLayout`, `repairLayout`,
 * `migrateTabsPersistedState`) has to keep resolving null back to the first
 * item exactly as it did before Home existed. Getting this wrong either stops
 * Home from working (flag on) or strands a real user's strip with nothing
 * selected (flag off) - so both sides of the flag are exercised for every
 * commit path below, not just the "happy" one.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { useLandingDraftStore } from "@/stores/home/landing-draft-store";
import { useSettingsStore } from "@/stores/settings/settings-store";
import {
  emptyTabStripLayout,
  flattenLayoutRefs,
  type PersistedTabStripLayout,
} from "@/stores/tabs/layout";
import { isRegisteredTabKind } from "@/stores/tabs/registry";
import {
  layoutHomeIsActive,
  migrateTabsPersistedState,
  readTabStripLayout,
  useTabsStore,
} from "@/stores/tabs/store";
import { tabCommandCoordinator } from "@/stores/tabs/tab-command-coordinator";
import {
  __resetTabSyncCoordinatorForTesting,
  installTabSyncCoordinator,
} from "@/lib/tab-sync/tab-sync-coordinator";
import type { TabRef } from "@/stores/tabs/types";

function resetStores(): void {
  useTabsStore.setState({
    ...emptyTabStripLayout(),
    stripOrder: [],
  });
  useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
  useLandingDraftStore.setState({ drafts: [], activeDraftId: null });
  useSettingsStore.setState({ homeTabEnabled: false });
  __resetTabSyncCoordinatorForTesting();
}

describe("home active selection", () => {
  beforeEach(async () => {
    resetStores();
    installTabSyncCoordinator({ readyPromise: Promise.resolve() });
    await Promise.resolve();
    await Promise.resolve();
  });

  afterEach(() => {
    resetStores();
  });

  it("flag ON: a null activeItemId survives repair() and stripOrder still lists the items", () => {
    useSettingsStore.setState({ homeTabEnabled: true });
    const epicRef: TabRef = { kind: "epic", id: "epic-a" };
    useTabsStore.setState({
      version: 2,
      items: [{ kind: "tab", id: "tab:epic:epic-a", ref: epicRef }],
      activeItemId: null,
      systemTabs: { history: null, settings: null },
      activationHistory: [],
      stripOrder: [epicRef],
    });

    useTabsStore.getState().repair();

    const state = useTabsStore.getState();
    expect(state.activeItemId).toBeNull();
    expect(state.stripOrder).toEqual([epicRef]);
    expect(layoutHomeIsActive(readTabStripLayout())).toBe(true);
  });

  it("flag OFF: the same null-activeItemId seed resolves to the first item after repair() - byte-identical to pre-Home behavior", () => {
    useSettingsStore.setState({ homeTabEnabled: false });
    const epicRef: TabRef = { kind: "epic", id: "epic-a" };
    useTabsStore.setState({
      version: 2,
      items: [{ kind: "tab", id: "tab:epic:epic-a", ref: epicRef }],
      activeItemId: null,
      systemTabs: { history: null, settings: null },
      activationHistory: [],
      stripOrder: [epicRef],
    });

    useTabsStore.getState().repair();

    const state = useTabsStore.getState();
    expect(state.activeItemId).toBe("tab:epic:epic-a");
    expect(layoutHomeIsActive(readTabStripLayout())).toBe(false);
  });

  it("flag ON: activateTab({ kind: 'home' }) selects Home, leaves items untouched, and clears the epic canvas's active id", () => {
    useSettingsStore.setState({ homeTabEnabled: true });
    const activation = tabCommandCoordinator.activateTab({
      kind: "epic",
      epicId: "epic-a",
      tabId: null,
      name: "A",
    });
    expect(activation).not.toBeNull();
    const itemsBeforeHome = useTabsStore.getState().items;
    expect(useEpicCanvasStore.getState().activeTabId).not.toBeNull();

    const homeActivation = tabCommandCoordinator.activateTab({ kind: "home" });

    expect(homeActivation).not.toBeNull();
    expect(homeActivation?.ref).toEqual({ kind: "home", id: "home" });
    expect(useTabsStore.getState().activeItemId).toBeNull();
    expect(useTabsStore.getState().items).toEqual(itemsBeforeHome);
    expect(useEpicCanvasStore.getState().activeTabId).toBeNull();
  });

  it("flag ON: activateTab({ kind: 'home' }) clears the landing draft store's active draft id", () => {
    useSettingsStore.setState({ homeTabEnabled: true });
    const activation = tabCommandCoordinator.activateTab({
      kind: "draft",
      draftId: null,
      settings: null,
      create: true,
    });
    expect(activation).not.toBeNull();
    expect(useLandingDraftStore.getState().activeDraftId).not.toBeNull();

    const homeActivation = tabCommandCoordinator.activateTab({ kind: "home" });

    expect(homeActivation?.ref).toEqual({ kind: "home", id: "home" });
    expect(useTabsStore.getState().activeItemId).toBeNull();
    expect(useLandingDraftStore.getState().activeDraftId).toBeNull();
  });

  it("flag OFF: activateTab({ kind: 'home' }) returns null and leaves the layout unchanged", () => {
    useSettingsStore.setState({ homeTabEnabled: false });
    tabCommandCoordinator.activateTab({
      kind: "epic",
      epicId: "epic-a",
      tabId: null,
      name: "A",
    });
    const before: PersistedTabStripLayout = readTabStripLayout();

    const homeActivation = tabCommandCoordinator.activateTab({ kind: "home" });

    expect(homeActivation).toBeNull();
    expect(readTabStripLayout()).toEqual(before);
  });

  it("opening a real tab after Home was active re-selects that tab", () => {
    useSettingsStore.setState({ homeTabEnabled: true });
    const activation = tabCommandCoordinator.activateTab({
      kind: "epic",
      epicId: "epic-a",
      tabId: null,
      name: "A",
    });
    expect(activation).not.toBeNull();
    if (activation === null) return;

    tabCommandCoordinator.activateTab({ kind: "home" });
    expect(useTabsStore.getState().activeItemId).toBeNull();

    const reopened = tabCommandCoordinator.activateTab({
      kind: "ref",
      ref: activation.ref,
    });

    expect(reopened).not.toBeNull();
    expect(useTabsStore.getState().activeItemId).not.toBeNull();
    expect(flattenLayoutRefs(readTabStripLayout())).toContainEqual(
      activation.ref,
    );
  });

  it("migrateTabsPersistedState keeps a null activeItemId when the flag is on", () => {
    useSettingsStore.setState({ homeTabEnabled: true });
    const persisted = {
      items: [
        {
          kind: "tab",
          id: "tab:epic:epic-a",
          ref: { kind: "epic", id: "epic-a" },
        },
      ],
      activeItemId: null,
      systemTabs: { history: null, settings: null },
    };

    const migrated = migrateTabsPersistedState(persisted);

    expect(migrated.activeItemId).toBeNull();
    expect(migrated.items).toHaveLength(1);
  });

  it("migrateTabsPersistedState resolves the same payload to the first item when the flag is off", () => {
    useSettingsStore.setState({ homeTabEnabled: false });
    const persisted = {
      items: [
        {
          kind: "tab",
          id: "tab:epic:epic-a",
          ref: { kind: "epic", id: "epic-a" },
        },
      ],
      activeItemId: null,
      systemTabs: { history: null, settings: null },
    };

    const migrated = migrateTabsPersistedState(persisted);

    expect(migrated.activeItemId).toBe("tab:epic:epic-a");
  });

  it("isRegisteredTabKind still resolves ordinary kinds (sanity check on the guard used throughout)", () => {
    expect(isRegisteredTabKind("epic")).toBe(true);
    expect(isRegisteredTabKind("home")).toBe(true);
    expect(isRegisteredTabKind("not-a-kind")).toBe(false);
  });
});
