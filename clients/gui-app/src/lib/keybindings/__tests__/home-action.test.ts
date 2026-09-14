/**
 * Locks down the `app.home.open` keybinding action end to end:
 *
 *  - its `ACTION_META` registration (label, category, default chord) and
 *    that the chord doesn't collide with any other action's default chord -
 *    a silent collision would mean one of the two chords never fires;
 *  - `dispatchAction` gates on the `homeTabEnabled` settings flag exactly as
 *    documented in `dispatch.ts` - returning `false` and touching nothing
 *    while the flag is off, so the provider leaves the chord unhandled
 *    instead of swallowing a keypress for a surface this build hasn't got;
 *  - `closeActiveEpic` (the handler behind `epic.close`) falls back to
 *    `router.navigateHome()` when closing the only open Epic tab leaves no
 *    next tab to focus - the one place `app.home.open`'s target is reached
 *    from a path other than the chord itself.
 *
 * Router-stub and canvas-store fixture patterns follow
 * `dispatch-focus-editor.test.ts` and `blank-tab.test.ts` in this directory.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  dispatchAction,
  type KeybindingRouter,
} from "@/lib/keybindings/dispatch";
import {
  ACTION_IDS,
  ACTION_META,
  getDefaultBindings,
  resolveActionDefaultChord,
} from "@/lib/keybindings/actions";
import { findConflict } from "@/lib/keybindings/conflicts";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import {
  resetTabsStoreForTest,
  seedActiveEpicTabInTabsStore,
} from "@/stores/tabs/test-support/tabs-store-fixtures";
import { useSettingsStore } from "@/stores/settings/settings-store";

const SEED_EPIC_ID = "epic-home-action";

/** Mirrors the router stubs in `dispatch-focus-editor.test.ts` / `blank-tab.test.ts`. */
function routerForTab(
  tabId: string,
  homeCalls: { count: number },
): KeybindingRouter {
  return {
    getPathname: () => `/epics/${SEED_EPIC_ID}/${tabId}`,
    navigateHome: () => {
      homeCalls.count += 1;
    },
    navigateSettings: () => undefined,
    navigateToEpic: () => undefined,
    navigateToEpicTab: () => undefined,
    navigateToEpicList: () => undefined,
    navigateSettingsSection: () => undefined,
    navigateToTabIntent: () => undefined,
    goBack: () => undefined,
    goForward: () => undefined,
    isHistoryNavAvailable: () => false,
    canGoBack: () => false,
    canGoForward: () => false,
  };
}

/** A router with no epic-tab context, for the flag-gated dispatch tests. */
function plainRouter(homeCalls: { count: number }): KeybindingRouter {
  return {
    getPathname: () => "/",
    navigateHome: () => {
      homeCalls.count += 1;
    },
    navigateSettings: () => undefined,
    navigateToEpic: () => undefined,
    navigateToEpicTab: () => undefined,
    navigateToEpicList: () => undefined,
    navigateSettingsSection: () => undefined,
    navigateToTabIntent: () => undefined,
    goBack: () => undefined,
    goForward: () => undefined,
    isHistoryNavAvailable: () => false,
    canGoBack: () => false,
    canGoForward: () => false,
  };
}

beforeEach(() => {
  useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
  resetTabsStoreForTest();
  useSettingsStore.setState({ homeTabEnabled: false });
});

afterEach(() => {
  useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
  resetTabsStoreForTest();
  useSettingsStore.setState({ homeTabEnabled: false });
});

describe("ACTION_META['app.home.open']", () => {
  it("registers a chord action labeled 'Go to Home' in the app category with the mod+shift+h default", () => {
    const meta = ACTION_META["app.home.open"];
    expect(meta.kind).toBe("chord");
    expect(meta.label).toBe("Go to Home");
    expect(meta.category).toBe("app");
    expect(resolveActionDefaultChord(meta)).toBe("mod+shift+h");
  });

  it("doesn't collide with any other action's default chord", () => {
    const bindings = getDefaultBindings();
    const candidate = bindings["app.home.open"];
    expect(candidate).not.toBeNull();
    if (candidate === null) return;
    const result = findConflict(bindings, "app.home.open", candidate, []);
    expect(result).toBeNull();
  });

  it("no other action's default chord collides with app.home.open's default, checked from every direction", () => {
    // Belt-and-braces over the single check above: walk every OTHER
    // chord-kind action's own default and confirm none of them resolve to
    // app.home.open's chord either - `findConflict` is symmetric in
    // practice, but this doesn't rely on that.
    const bindings = getDefaultBindings();
    const homeChord = bindings["app.home.open"];
    for (const id of ACTION_IDS) {
      if (id === "app.home.open") continue;
      const meta = ACTION_META[id];
      if (meta.kind !== "chord") continue;
      const chord = bindings[id];
      if (chord === null) continue;
      expect(chord).not.toBe(homeChord);
    }
  });
});

describe("dispatchAction('app.home.open', router)", () => {
  it("calls navigateHome and returns true when homeTabEnabled is on", () => {
    useSettingsStore.setState({ homeTabEnabled: true });
    const homeCalls = { count: 0 };
    const result = dispatchAction("app.home.open", plainRouter(homeCalls));
    expect(result).toBe(true);
    expect(homeCalls.count).toBe(1);
  });

  it("returns false and calls nothing when homeTabEnabled is off", () => {
    useSettingsStore.setState({ homeTabEnabled: false });
    const homeCalls = { count: 0 };
    const result = dispatchAction("app.home.open", plainRouter(homeCalls));
    expect(result).toBe(false);
    expect(homeCalls.count).toBe(0);
  });
});

describe("closeActiveEpic (epic.close) falling back to Home", () => {
  it("returns false when no epic tab is open", () => {
    const homeCalls = { count: 0 };
    const result = dispatchAction("epic.close", plainRouter(homeCalls));
    expect(result).toBe(false);
    expect(homeCalls.count).toBe(0);
  });

  it("calls navigateHome when closing the only open epic tab leaves no next tab to focus", () => {
    const store = useEpicCanvasStore.getState();
    const tabId = store.openEpicTab(SEED_EPIC_ID, "Epic");
    seedActiveEpicTabInTabsStore(tabId);

    const homeCalls = { count: 0 };
    const result = dispatchAction("epic.close", routerForTab(tabId, homeCalls));

    expect(result).toBe(true);
    expect(useEpicCanvasStore.getState().activeTabId).toBeNull();
    expect(homeCalls.count).toBe(1);
  });

  it("navigates to the next epic tab instead of Home when one remains", () => {
    const store = useEpicCanvasStore.getState();
    const firstTabId = store.openEpicTab(SEED_EPIC_ID, "Epic One");
    store.openEpicTab(SEED_EPIC_ID, "Epic Two");
    seedActiveEpicTabInTabsStore(firstTabId);

    const homeCalls = { count: 0 };
    let navigatedTabId: string | null = null;
    const router: KeybindingRouter = {
      ...routerForTab(firstTabId, homeCalls),
      navigateToEpicTab: (tab) => {
        navigatedTabId = tab.tabId;
      },
    };

    const result = dispatchAction("epic.close", router);

    expect(result).toBe(true);
    expect(homeCalls.count).toBe(0);
    expect(navigatedTabId).not.toBeNull();
  });
});
