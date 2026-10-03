/**
 * Held tab cycling activates through explicit demand: a `preview` activation
 * moves the header's selection and marks the target as preview demand, but
 * neither navigates nor records history; the `settled` activation that ends
 * the hold navigates once and records exactly the final target.
 *
 * Drives the real controller, coordinator and stores; fakes only the router
 * commit boundary (same harness shape as `route-bookkeeping-replace.test.ts`).
 */
import type {
  NavigateOptions,
  UseNavigateResult,
} from "@tanstack/react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __resetTabNavigationControllerForTesting,
  activateTabIntent,
  existingEpicTabIntent,
  getTabNavigationDiagnostics,
  tabNavigationController,
} from "@/lib/tab-navigation";
import { epicPathname } from "@/lib/routes";
import {
  __resetTabSyncCoordinatorForTesting,
  installTabSyncCoordinator,
} from "@/lib/tab-sync/tab-sync-coordinator";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { useLandingDraftStore } from "@/stores/home/landing-draft-store";
import {
  flattenLayoutRefs,
  tabActivationHistory,
  tabItemId,
  tabRefKey,
} from "@/stores/tabs/layout";
import {
  hasPreviewDemand,
  topLevelDemand,
  useSurfaceDemandStore,
} from "@/stores/tabs/surface-demand";
import { useTabsStore } from "@/stores/tabs/store";
import type { TabRef } from "@/stores/tabs/types";

interface OpenedEpic {
  readonly epicId: string;
  readonly tabId: string;
  readonly ref: TabRef;
}

function openEpic(epicId: string): OpenedEpic {
  const tabId = useEpicCanvasStore.getState().openEpicTab(epicId, epicId);
  return { epicId, tabId, ref: { kind: "epic", id: tabId } };
}

function seedLayout(tabs: ReadonlyArray<OpenedEpic>, active: OpenedEpic): void {
  const layout = {
    version: 2 as const,
    items: tabs.map((tab) => ({
      kind: "tab" as const,
      id: tabItemId(tab.ref),
      ref: tab.ref,
    })),
    activeItemId: tabItemId(active.ref),
    systemTabs: { history: null, settings: null },
  };
  useTabsStore.setState({ ...layout, stripOrder: flattenLayoutRefs(layout) });
}

function focusedRefKey(): string | null {
  const state = useTabsStore.getState();
  const item = state.items.find(
    (candidate) => candidate.id === state.activeItemId,
  );
  return item !== undefined && item.kind === "tab" ? tabRefKey(item.ref) : null;
}

function historyKeys(): ReadonlyArray<string> {
  return tabActivationHistory(useTabsStore.getState()).map(tabRefKey);
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

interface ControlledNavigate {
  readonly navigate: UseNavigateResult<string>;
  readonly calls: NavigateOptions[];
  readonly rejectLast: () => void;
}

/** Records every requested route and lets the test fail the latest one. */
function makeControlledNavigate(): ControlledNavigate {
  const calls: NavigateOptions[] = [];
  const rejectors: Array<() => void> = [];
  const navigate = ((options: NavigateOptions) => {
    calls.push(options);
    return new Promise<void>((_resolve, reject) => {
      rejectors.push(() => reject(new Error("navigation rejected")));
    });
  }) as UseNavigateResult<string>;
  return {
    navigate,
    calls,
    rejectLast: () => rejectors[rejectors.length - 1](),
  };
}

/** The history state the router would commit for a recorded navigation. */
function committedState(options: NavigateOptions): Record<string, unknown> {
  const updater = options.state;
  if (typeof updater !== "function") {
    throw new Error("expected navigate state updater function");
  }
  return { ...updater({ key: "k", __TSR_key: "k", __TSR_index: 1 }) };
}

function intentFor(tab: OpenedEpic, demand: "preview" | "settled") {
  return {
    ...existingEpicTabIntent({
      epicId: tab.epicId,
      tabId: tab.tabId,
      focus: undefined,
    }),
    demand,
  };
}

function resetAll(): void {
  useTabsStore.setState({
    version: 2,
    items: [],
    activeItemId: null,
    stripOrder: [],
    systemTabs: { history: null, settings: null },
  });
  useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
  useLandingDraftStore.setState({ drafts: [], activeDraftId: null });
  useSurfaceDemandStore.setState(useSurfaceDemandStore.getInitialState(), true);
  __resetTabSyncCoordinatorForTesting();
  __resetTabNavigationControllerForTesting();
}

describe("tab activation demand", () => {
  beforeEach(async () => {
    resetAll();
    installTabSyncCoordinator({ readyPromise: Promise.resolve() });
    await Promise.resolve();
    await Promise.resolve();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetAll();
  });

  it("previews move the selection and mark demand without navigating or recording history", () => {
    const a = openEpic("epic-a");
    const b = openEpic("epic-b");
    const c = openEpic("epic-c");
    seedLayout([a, b, c], a);
    const historyBefore = historyKeys();
    const { navigate, calls } = makeNavigate();

    expect(
      activateTabIntent(navigate, intentFor(b, "preview"), undefined),
    ).toBe(true);
    expect(
      activateTabIntent(navigate, intentFor(c, "preview"), undefined),
    ).toBe(true);

    expect(calls).toHaveLength(0);
    expect(getTabNavigationDiagnostics().pendingTokenCount).toBe(0);
    expect(focusedRefKey()).toBe(tabRefKey(c.ref));
    // Only the tab the cursor is on has demand; B was left behind.
    expect(topLevelDemand(tabRefKey(c.ref))).toBe("preview");
    expect(topLevelDemand(tabRefKey(b.ref))).toBeNull();
    expect(historyKeys()).toEqual(historyBefore);
  });

  it("settling after previews navigates once and records only the final target", () => {
    const a = openEpic("epic-a");
    const b = openEpic("epic-b");
    const c = openEpic("epic-c");
    seedLayout([a, b, c], a);
    const { navigate, calls } = makeNavigate();

    activateTabIntent(navigate, intentFor(b, "preview"), undefined);
    activateTabIntent(navigate, intentFor(c, "preview"), undefined);
    expect(
      activateTabIntent(navigate, intentFor(c, "settled"), undefined),
    ).toBe(true);

    expect(calls).toHaveLength(1);
    expect(hasPreviewDemand()).toBe(false);
    expect(focusedRefKey()).toBe(tabRefKey(c.ref));
    expect(historyKeys()[0]).toBe(tabRefKey(c.ref));
    expect(historyKeys()).not.toContain(tabRefKey(b.ref));
  });

  it("a plain activation with no demand settles like an explicit settled one", () => {
    const a = openEpic("epic-a");
    const b = openEpic("epic-b");
    seedLayout([a, b], a);
    const { navigate, calls } = makeNavigate();

    expect(
      activateTabIntent(
        navigate,
        existingEpicTabIntent({
          epicId: b.epicId,
          tabId: b.tabId,
          focus: undefined,
        }),
        undefined,
      ),
    ).toBe(true);

    expect(calls).toHaveLength(1);
    expect(hasPreviewDemand()).toBe(false);
    expect(historyKeys()[0]).toBe(tabRefKey(b.ref));
  });

  it("a pending settled navigation that rejects cannot steal the cursor from a later preview", async () => {
    const a = openEpic("epic-a");
    const b = openEpic("epic-b");
    const c = openEpic("epic-c");
    seedLayout([a, b, c], a);
    const nav = makeControlledNavigate();
    // A is the committed origin: the controller has observed its location, so
    // a wrong rejection repair has something to restore.
    tabNavigationController.observeLocation(
      {
        pathname: epicPathname({ epicId: a.epicId, tabId: a.tabId }),
        state: { key: "origin", __TSR_key: "origin", __TSR_index: 0 },
        search: undefined,
      },
      "PUSH",
      nav.navigate,
    );
    expect(nav.calls).toHaveLength(0);

    expect(
      activateTabIntent(nav.navigate, intentFor(b, "settled"), undefined),
    ).toBe(true);
    expect(nav.calls).toHaveLength(1);
    // The hold continues before B's route commits.
    expect(
      activateTabIntent(nav.navigate, intentFor(c, "preview"), undefined),
    ).toBe(true);

    nav.rejectLast();
    await Promise.resolve();
    await Promise.resolve();

    expect(focusedRefKey()).toBe(tabRefKey(c.ref));
    expect(topLevelDemand(tabRefKey(c.ref))).toBe("preview");
    // Nothing wrote the preview's route.
    expect(nav.calls).toHaveLength(1);
  });

  it("a duplicate acknowledgement of a pending settled navigation neither writes the preview route nor moves the cursor", () => {
    const a = openEpic("epic-a");
    const b = openEpic("epic-b");
    const c = openEpic("epic-c");
    seedLayout([a, b, c], a);
    const nav = makeControlledNavigate();

    activateTabIntent(nav.navigate, intentFor(b, "settled"), undefined);
    activateTabIntent(nav.navigate, intentFor(c, "preview"), undefined);

    const acknowledgement = {
      pathname: epicPathname({ epicId: b.epicId, tabId: b.tabId }),
      state: committedState(nav.calls[0]),
      search: undefined,
    };
    tabNavigationController.observeLocation(
      acknowledgement,
      "PUSH",
      nav.navigate,
    );
    tabNavigationController.observeLocation(
      acknowledgement,
      "PUSH",
      nav.navigate,
    );

    expect(focusedRefKey()).toBe(tabRefKey(c.ref));
    expect(topLevelDemand(tabRefKey(c.ref))).toBe("preview");
    expect(nav.calls).toHaveLength(1);
  });
});
