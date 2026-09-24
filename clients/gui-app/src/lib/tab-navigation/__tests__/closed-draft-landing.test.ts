/**
 * Retained (closed) landing drafts are not restorable tabs: closing or moving
 * away the last visible tab must leave `hasRestoredTabs()` false so the window
 * lands on a fresh draft, and `/draft/new` mints exactly one.
 *
 * Drives the real controller, coordinator, and stores; fakes only the router
 * commit boundary.
 */
import type {
  NavigateOptions,
  UseNavigateResult,
} from "@tanstack/react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __resetTabNavigationControllerForTesting,
  __resetTabNavigationHydrationForTesting,
  tabNavigationController,
} from "@/lib/tab-navigation";
import { hasRestoredTabs } from "@/lib/has-restored-tabs";
import { useSettingsStore } from "@/stores/settings/settings-store";
import { epicPathname } from "@/lib/routes";
import {
  __resetTabSyncCoordinatorForTesting,
  installTabSyncCoordinator,
} from "@/lib/tab-sync/tab-sync-coordinator";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import {
  isOpenLandingDraft,
  useLandingDraftStore,
} from "@/stores/home/landing-draft-store";
import {
  flattenLayoutRefs,
  tabItemId,
  type PersistedTabStripLayout,
} from "@/stores/tabs/layout";
import { tabCommandCoordinator } from "@/stores/tabs/tab-command-coordinator";
import { useTabsStore } from "@/stores/tabs/store";
import type { TabRef } from "@/stores/tabs/types";

const POPULATED_CONTENT = {
  type: "doc",
  content: [{ type: "paragraph", content: [{ type: "text", text: "hello" }] }],
};

function resetStores(): void {
  useTabsStore.setState({
    version: 2,
    items: [],
    activeItemId: null,
    stripOrder: [],
    systemTabs: { history: null, settings: null },
  });
  useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
  useLandingDraftStore.setState({ drafts: [], activeDraftId: null });
  useSettingsStore.setState({ homeTabEnabled: false });
  __resetTabSyncCoordinatorForTesting();
  __resetTabNavigationControllerForTesting();
}

function seedLayout(layout: PersistedTabStripLayout): void {
  useTabsStore.setState({ ...layout, stripOrder: flattenLayoutRefs(layout) });
}

function seedSingleTab(ref: TabRef): void {
  seedLayout({
    version: 2,
    items: [{ kind: "tab", id: tabItemId(ref), ref }],
    activeItemId: tabItemId(ref),
    systemTabs: { history: null, settings: null },
  });
}

/** A populated draft already put away by the user: retained, `closed: true`. */
function retainClosedDraft(): string {
  const id = useLandingDraftStore.getState().createDraft(null);
  useLandingDraftStore.setState((state) => ({
    drafts: state.drafts.map((d) =>
      d.id === id ? { ...d, content: POPULATED_CONTENT, closed: true } : d,
    ),
    activeDraftId: null,
  }));
  return id;
}

function openEpic(epicId: string): { readonly ref: TabRef; pathname: string } {
  const tabId = useEpicCanvasStore.getState().openEpicTab(epicId, epicId);
  return {
    ref: { kind: "epic", id: tabId },
    pathname: epicPathname({ epicId, tabId }),
  };
}

function openDrafts(): number {
  return useLandingDraftStore.getState().drafts.filter(isOpenLandingDraft)
    .length;
}

function makeNavigate(): {
  readonly navigate: UseNavigateResult<string>;
  readonly calls: NavigateOptions[];
} {
  const calls: NavigateOptions[] = [];
  const navigate = ((options: NavigateOptions) => {
    calls.push(options);
    return new Promise<void>(() => undefined);
  }) as UseNavigateResult<string>;
  return { navigate, calls };
}

function observeDraftNew(navigate: UseNavigateResult<string>): void {
  tabNavigationController.observeLocation(
    {
      pathname: "/draft/new",
      state: { __TSR_key: "draft-new", __TSR_index: 0 },
      search: undefined,
    },
    "REPLACE",
    navigate,
  );
}

describe("retained closed drafts do not count as restored tabs", () => {
  beforeEach(async () => {
    resetStores();
    installTabSyncCoordinator({ readyPromise: Promise.resolve() });
    await Promise.resolve();
    await Promise.resolve();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetStores();
  });

  it("closing the last populated draft retains it but leaves nothing restorable", () => {
    const id = useLandingDraftStore.getState().createDraft(null);
    useLandingDraftStore.setState((state) => ({
      drafts: state.drafts.map((d) =>
        d.id === id ? { ...d, content: POPULATED_CONTENT } : d,
      ),
    }));
    tabCommandCoordinator.reconcileFromSourceStores();
    expect(hasRestoredTabs()).toBe(true);

    expect(tabCommandCoordinator.closeRef({ kind: "draft", id })).toBe(true);

    const retained = useLandingDraftStore
      .getState()
      .drafts.find((d) => d.id === id);
    expect(retained?.closed).toBe(true);
    expect(useTabsStore.getState().stripOrder).toHaveLength(0);
    expect(hasRestoredTabs()).toBe(false);
  });

  it("closing the last epic with a previously closed draft leaves nothing restorable", () => {
    retainClosedDraft();
    const epic = openEpic("epic-a");
    seedSingleTab(epic.ref);
    expect(hasRestoredTabs()).toBe(true);

    expect(tabCommandCoordinator.closeRef(epic.ref)).toBe(true);

    expect(useLandingDraftStore.getState().drafts).toHaveLength(1);
    expect(hasRestoredTabs()).toBe(false);
  });

  it("moving the last epic to another window (removeMovedRef) leaves nothing restorable", () => {
    retainClosedDraft();
    const epic = openEpic("epic-a");
    seedSingleTab(epic.ref);

    expect(tabCommandCoordinator.removeMovedRef(epic.ref)).toBe(true);

    expect(useLandingDraftStore.getState().drafts).toHaveLength(1);
    expect(hasRestoredTabs()).toBe(false);
  });

  it("still counts an open draft", () => {
    useLandingDraftStore.getState().createDraft(null);
    expect(hasRestoredTabs()).toBe(true);
  });

  it("still counts a restored epic tab", () => {
    seedSingleTab(openEpic("epic-a").ref);
    expect(hasRestoredTabs()).toBe(true);
  });

  it("still counts a system tab", () => {
    const settingsRef: TabRef = { kind: "settings", id: "settings" };
    seedLayout({
      version: 2,
      items: [{ kind: "tab", id: tabItemId(settingsRef), ref: settingsRef }],
      activeItemId: tabItemId(settingsRef),
      systemTabs: {
        history: null,
        settings: {
          id: "settings",
          kind: "settings",
          name: "Settings",
          lastPath: "/settings/providers",
        },
      },
    });
    expect(hasRestoredTabs()).toBe(true);
  });
});

describe("/draft/new with retained closed drafts", () => {
  beforeEach(async () => {
    resetStores();
    installTabSyncCoordinator({ readyPromise: Promise.resolve() });
    await Promise.resolve();
    await Promise.resolve();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetStores();
  });

  it("creates exactly one fresh draft and routes to it", () => {
    const retainedId = retainClosedDraft();
    const nav = makeNavigate();

    observeDraftNew(nav.navigate);

    const drafts = useLandingDraftStore.getState().drafts;
    expect(drafts).toHaveLength(2);
    const fresh = drafts.find((d) => d.id !== retainedId);
    expect(fresh?.closed).toBe(false);
    expect(openDrafts()).toBe(1);
    expect(nav.calls).toHaveLength(1);
    expect(fresh).toBeDefined();
    expect(nav.calls[0].to).toBe("/draft/$draftId");
    expect(nav.calls[0].params).toEqual({ draftId: fresh?.id });
    expect(nav.calls[0].replace).toBe(true);
  });

  it("defers creation until hydration is ready, then mints exactly one draft", () => {
    retainClosedDraft();
    __resetTabNavigationHydrationForTesting();
    const nav = makeNavigate();

    observeDraftNew(nav.navigate);

    expect(useLandingDraftStore.getState().drafts).toHaveLength(1);
    expect(nav.calls).toHaveLength(0);

    tabNavigationController.setHydrationReady(true, nav.navigate);

    expect(useLandingDraftStore.getState().drafts).toHaveLength(2);
    expect(openDrafts()).toBe(1);
    expect(nav.calls).toHaveLength(1);
    expect(nav.calls[0].to).toBe("/draft/$draftId");
  });

  it("does not add a draft over a populated layout", () => {
    retainClosedDraft();
    const epic = openEpic("epic-a");
    seedSingleTab(epic.ref);
    const before = useLandingDraftStore.getState().drafts.length;
    const nav = makeNavigate();

    observeDraftNew(nav.navigate);

    expect(useLandingDraftStore.getState().drafts).toHaveLength(before);
    expect(openDrafts()).toBe(0);
  });
});
