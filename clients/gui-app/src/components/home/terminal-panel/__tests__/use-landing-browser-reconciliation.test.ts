import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, renderHook } from "@testing-library/react";
import type { BrowserSessionsState } from "@/lib/browser-view/sessions/browser-sessions-coordinator";
import {
  recordIndependentPageOpenedTab,
  resetIndependentPageOpensForTests,
} from "@/lib/browser-view/sessions/independent-page-open-registry";
import {
  landingTabRefKey,
  useLandingPanelStore,
  type LandingBrowserTabRef,
} from "@/stores/home/landing-panel-store";
import {
  epicScope,
  independentScope,
  sessionInfo,
  tabInfo,
} from "@/lib/browser-view/sessions/__tests__/browser-session-test-kit";
import {
  defaultLandingBrowserTitle,
  reconcileLandingBrowserTabs,
  useLandingBrowserReconciliation,
  type LandingBrowserReconciliationInput,
} from "../use-landing-browser-reconciliation";

/** This renderer's desktop window, as `useDesktopWindowId` would report it. */
const windowIdHarness = vi.hoisted(() => ({ windowId: null as string | null }));
vi.mock("@/lib/windows/desktop-window-id", () => ({
  useDesktopWindowId: () => windowIdHarness.windowId,
}));

const HOST_ID = "host-a";

function browserTabRef(
  overrides: Partial<LandingBrowserTabRef>,
): LandingBrowserTabRef {
  return {
    kind: "browser",
    instanceId: "instance-1",
    sessionId: "session-1",
    hostId: HOST_ID,
    tabId: "tab-1",
    name: "Stored Name",
    titleSource: "default",
    ...overrides,
  };
}

function baseInput(
  overrides: Partial<LandingBrowserReconciliationInput>,
): LandingBrowserReconciliationInput {
  return {
    tabs: [],
    hostId: HOST_ID,
    sessions: [],
    excludedTabKeys: new Set<string>(),
    // Most scenarios below expect no adoption at all; a scenario that DOES
    // expect one overrides this, so a stray call here is a bug surfacing
    // loudly instead of a silent, wrong instance id.
    mintInstanceId: (): string => {
      throw new Error("mintInstanceId should not be called in this scenario");
    },
    ...overrides,
  };
}

describe("reconcileLandingBrowserTabs", () => {
  it("adopts a tab present in the host's snapshot with no matching store ref", () => {
    const session = sessionInfo({
      sessionId: "session-1",
      hostId: HOST_ID,
      scope: independentScope(),
      tabs: [
        tabInfo({
          tabId: "tab-1",
          url: "https://example.com/",
          title: "Example Page",
        }),
      ],
    });

    const result = reconcileLandingBrowserTabs(
      baseInput({
        sessions: [session],
        mintInstanceId: () => "minted-instance-1",
      }),
    );

    const adopted: LandingBrowserTabRef = {
      kind: "browser",
      instanceId: "minted-instance-1",
      hostId: HOST_ID,
      sessionId: "session-1",
      tabId: "tab-1",
      name: "Example Page",
      titleSource: "default",
    };
    expect(result.adoptedTabs).toEqual([adopted]);
    expect(result.tabs).toEqual([adopted]);
    expect(result.removedInstanceIds).toEqual([]);
    expect(result.collapseWhenEmpty).toBe(false);
  });

  it("drops a store ref absent from a ready snapshot", () => {
    const ref = browserTabRef({ instanceId: "gone-instance" });

    const result = reconcileLandingBrowserTabs(
      baseInput({ tabs: [ref], sessions: [] }),
    );

    expect(result.tabs).toEqual([]);
    expect(result.removedInstanceIds).toEqual(["gone-instance"]);
    expect(result.collapseWhenEmpty).toBe(true);
    expect(result.adoptedTabs).toEqual([]);
  });

  it("keeps a manual title untouched but re-syncs a default one to the live title", () => {
    const manualRef = browserTabRef({
      instanceId: "manual-instance",
      tabId: "tab-manual",
      name: "My Custom Name",
      titleSource: "manual",
    });
    const defaultRef = browserTabRef({
      instanceId: "default-instance",
      tabId: "tab-default",
      name: "Stale Title",
      titleSource: "default",
    });
    const session = sessionInfo({
      sessionId: "session-1",
      hostId: HOST_ID,
      scope: independentScope(),
      tabs: [
        tabInfo({
          tabId: "tab-manual",
          title: "Different Live Title",
          url: "https://manual.example/",
        }),
        tabInfo({
          tabId: "tab-default",
          title: "Fresh Title",
          url: "https://default.example/",
        }),
      ],
    });

    const result = reconcileLandingBrowserTabs(
      baseInput({ tabs: [manualRef, defaultRef], sessions: [session] }),
    );

    const manualResult = result.tabs.find(
      (tab) => tab.instanceId === "manual-instance",
    );
    const defaultResult = result.tabs.find(
      (tab) => tab.instanceId === "default-instance",
    );
    expect(manualResult?.name).toBe("My Custom Name");
    expect(defaultResult?.name).toBe("Fresh Title");
  });

  it("drops a tombstoned tab and does not re-adopt it even though the snapshot still lists it", () => {
    // The regression this pins: a tombstoned tab is still in the host's
    // inventory until the close lands, so "absent from the snapshot" is NOT
    // what keeps it out of the panel - the exclusion set is.
    const ref = browserTabRef({ instanceId: "tombstoned-instance" });
    const key = landingTabRefKey(ref);
    const session = sessionInfo({
      sessionId: "session-1",
      hostId: HOST_ID,
      scope: independentScope(),
      tabs: [
        tabInfo({
          tabId: "tab-1",
          title: "Still Open On The Host",
          url: "https://example.com/",
        }),
      ],
    });

    const result = reconcileLandingBrowserTabs(
      baseInput({
        tabs: [ref],
        sessions: [session],
        excludedTabKeys: new Set([key]),
      }),
    );

    expect(result.tabs).toEqual([]);
    expect(result.adoptedTabs).toEqual([]);
    expect(result.removedInstanceIds).toEqual(["tombstoned-instance"]);
    expect(result.collapseWhenEmpty).toBe(true);
  });

  it("never adopts, and never treats as evidence of life, a session on a different host or an epic-scoped session on the same host", () => {
    // Both extra sessions below share this ref's sessionId/tabId on purpose:
    // `landingTabRefKey` builds the lookup key from `input.hostId`, not
    // `session.hostId`, so nothing but the initial host+scope filter stands
    // between a same-id foreign-host or epic-scoped session and a false
    // match that would incorrectly keep this ref alive.
    const ref = browserTabRef({
      instanceId: "existing-instance",
      sessionId: "shared-session-id",
      tabId: "shared-tab-id",
    });
    const foreignHostSession = sessionInfo({
      sessionId: "shared-session-id",
      hostId: "host-b",
      scope: independentScope(),
      tabs: [tabInfo({ tabId: "shared-tab-id" })],
    });
    const epicScopedSameHostSession = sessionInfo({
      sessionId: "shared-session-id",
      hostId: HOST_ID,
      scope: epicScope("epic-1"),
      tabs: [tabInfo({ tabId: "shared-tab-id" })],
    });

    const result = reconcileLandingBrowserTabs(
      baseInput({
        tabs: [ref],
        sessions: [foreignHostSession, epicScopedSameHostSession],
      }),
    );

    // Correctly gone: no independent, same-host session actually has it.
    expect(result.tabs).toEqual([]);
    expect(result.removedInstanceIds).toEqual(["existing-instance"]);
    expect(result.collapseWhenEmpty).toBe(true);
    // Neither the foreign-host nor the epic-scoped session contributed one.
    expect(result.adoptedTabs).toEqual([]);
  });

  it("keeps the same ref identity and reports no collapse when nothing changed", () => {
    const ref = browserTabRef({
      instanceId: "steady-instance",
      name: "Steady Title",
      titleSource: "default",
    });
    const session = sessionInfo({
      sessionId: "session-1",
      hostId: HOST_ID,
      scope: independentScope(),
      tabs: [
        tabInfo({
          tabId: "tab-1",
          title: "Steady Title",
          url: "https://steady.example/",
        }),
      ],
    });

    const result = reconcileLandingBrowserTabs(
      baseInput({ tabs: [ref], sessions: [session] }),
    );

    expect(result.tabs).toEqual([ref]);
    expect(result.tabs.at(0)).toBe(ref);
    expect(result.collapseWhenEmpty).toBe(false);
    expect(result.removedInstanceIds).toEqual([]);
    expect(result.adoptedTabs).toEqual([]);
  });
});

describe("defaultLandingBrowserTitle", () => {
  it("falls back to the url when the live title is null", () => {
    expect(
      defaultLandingBrowserTitle({ title: null, url: "https://a.example/" }),
    ).toBe("https://a.example/");
  });

  it("falls back to the url when the live title is whitespace-only", () => {
    expect(
      defaultLandingBrowserTitle({ title: "   ", url: "https://b.example/" }),
    ).toBe("https://b.example/");
  });

  it("uses the live title when it is present", () => {
    expect(
      defaultLandingBrowserTitle({
        title: "Real Title",
        url: "https://c.example/",
      }),
    ).toBe("Real Title");
  });
});

function sessionsState(
  overrides: Partial<BrowserSessionsState>,
): BrowserSessionsState {
  return {
    hostId: HOST_ID,
    lifecycle: "live",
    inventoryReady: true,
    canMaterializeElectron: false,
    items: [],
    errorMessage: null,
    retry: () => undefined,
    openTab: () => Promise.reject(new Error("not used in this test")),
    closeTab: () => Promise.reject(new Error("not used in this test")),
    attachTab: () => Promise.reject(new Error("not used in this test")),
    moveTab: () => Promise.reject(new Error("not used in this test")),
    ...overrides,
  };
}

function storedBrowserTab(instanceId: string, tabId: string): void {
  useLandingPanelStore.getState().addTab({
    kind: "browser",
    instanceId,
    hostId: HOST_ID,
    sessionId: "session-1",
    tabId,
    name: "example.com",
    titleSource: "default",
  });
}

/**
 * The pure function above is the RULES; this is the wiring. Both halves are
 * load-bearing and neither implies the other: the `enabled` gate and the
 * `inventoryReady` gate live only here, and so does the one call that reaches
 * the store under a host and a kind.
 */
describe("useLandingBrowserReconciliation", () => {
  afterEach(() => {
    cleanup();
    useLandingPanelStore.getState().resetForTests();
    resetIndependentPageOpensForTests();
    windowIdHarness.windowId = null;
    vi.restoreAllMocks();
  });

  it("writes nothing while the device's inventory is not ready", () => {
    // The hook's own comment: a connecting stream reports an empty `items`,
    // which is indistinguishable from "this device has no browser tabs" -
    // acting on it drops every browser tab in the panel on every reconnect.
    storedBrowserTab("browser-1", "tab-1");
    const apply = vi.spyOn(
      useLandingPanelStore.getState(),
      "applyReconciliationSlice",
    );

    renderHook(() =>
      useLandingBrowserReconciliation({
        hostId: HOST_ID,
        sessions: sessionsState({ inventoryReady: false, items: [] }),
        enabled: true,
      }),
    );

    expect(apply).not.toHaveBeenCalled();
    expect(
      useLandingPanelStore.getState().tabs.map((tab) => tab.instanceId),
    ).toEqual(["browser-1"]);
  });

  it("writes nothing when this arm only reports", () => {
    // Two surfaces mount the fleet and share one coordinator; only one may
    // write. Two writers on one slice would each adopt and drop against a
    // snapshot the other had already acted on.
    storedBrowserTab("browser-1", "tab-1");
    const apply = vi.spyOn(
      useLandingPanelStore.getState(),
      "applyReconciliationSlice",
    );

    renderHook(() =>
      useLandingBrowserReconciliation({
        hostId: HOST_ID,
        sessions: sessionsState({ items: [] }),
        enabled: false,
      }),
    );

    expect(apply).not.toHaveBeenCalled();
    expect(
      useLandingPanelStore.getState().tabs.map((tab) => tab.instanceId),
    ).toEqual(["browser-1"]);
  });

  it("applies exactly one slice, keyed by this device and the browser kind", () => {
    storedBrowserTab("browser-1", "tab-1");
    const apply = vi.spyOn(
      useLandingPanelStore.getState(),
      "applyReconciliationSlice",
    );
    const session = sessionInfo({
      sessionId: "session-1",
      hostId: HOST_ID,
      scope: independentScope(),
      tabs: [
        tabInfo({
          tabId: "tab-1",
          title: "Fresh Title",
          url: "https://example.com/",
        }),
      ],
    });

    renderHook(() =>
      useLandingBrowserReconciliation({
        hostId: HOST_ID,
        sessions: sessionsState({ items: [session] }),
        enabled: true,
      }),
    );

    expect(apply).toHaveBeenCalledTimes(1);
    expect(apply.mock.calls[0]?.[0]).toBe(HOST_ID);
    expect(apply.mock.calls[0]?.[1]).toBe("browser");
    expect(useLandingPanelStore.getState().tabs).toEqual([
      {
        kind: "browser",
        instanceId: "browser-1",
        hostId: HOST_ID,
        sessionId: "session-1",
        tabId: "tab-1",
        name: "Fresh Title",
        titleSource: "default",
      },
    ]);
  });

  // The independent half of the `tabOpened` route: the stream records the
  // identity because it cannot reach a surface, and this pass is the surface.
  it("activates a tab the page opened, and only that one", () => {
    storedBrowserTab("browser-1", "tab-1");
    useLandingPanelStore.getState().activateTab("browser-1");
    recordIndependentPageOpenedTab({
      hostId: HOST_ID,
      sessionId: "session-1",
      tabId: "popup-tab",
      openerTabId: "tab-1",
      raisedWhileFocused: true,
    });
    const session = sessionInfo({
      sessionId: "session-1",
      hostId: HOST_ID,
      scope: independentScope(),
      tabs: [
        tabInfo({ tabId: "tab-1", url: "https://example.com/" }),
        // Adopted in the same pass and NOT recorded - another window's tab, or
        // a reconnect's snapshot. It must not move the selection.
        tabInfo({ tabId: "other-tab", url: "https://other.example/" }),
        tabInfo({ tabId: "popup-tab", url: "https://example.com/next" }),
      ],
    });

    renderHook(() =>
      useLandingBrowserReconciliation({
        hostId: HOST_ID,
        sessions: sessionsState({ items: [session] }),
        enabled: true,
      }),
    );

    const popup = useLandingPanelStore
      .getState()
      .tabs.find((tab) => tab.kind === "browser" && tab.tabId === "popup-tab");
    expect(popup).not.toBeUndefined();
    expect(useLandingPanelStore.getState().activeInstanceId).toBe(
      popup?.instanceId,
    );
  });

  // `tabOpened` reaches every window's stream, so every window records the
  // popup and adopts it. Only the window whose reader raised it moves its
  // panel onto it, and which window that is depends on where the popup - or,
  // for a headless one, its opener - is on screen.
  it("activates a page-opened tab only in the window whose reader raised it", () => {
    interface Pass {
      readonly thisWindowId: string | null;
      /** The row this window's panel is on when the popup arrives. */
      readonly activeRow: "opener" | "other-tab" | "other-session";
      readonly popupBoundWindowId: string | null;
      readonly openerBoundWindowId: string | null;
      /** `false`: the device could not name the opener (`noopener`, gone). */
      readonly openerNamed: boolean;
      /** Whether this window held focus as the frame arrived. */
      readonly focused: boolean;
    }
    const pass = (input: Pass): boolean => {
      useLandingPanelStore.getState().resetForTests();
      windowIdHarness.windowId = input.thisWindowId;
      storedBrowserTab("browser-opener", "opener-tab");
      storedBrowserTab("browser-other", "other-tab");
      useLandingPanelStore.getState().addTab({
        kind: "browser",
        instanceId: "browser-elsewhere",
        hostId: HOST_ID,
        sessionId: "session-2",
        tabId: "elsewhere-tab",
        name: "elsewhere.example",
        titleSource: "default",
      });
      const rowInstanceIds: Record<Pass["activeRow"], string> = {
        opener: "browser-opener",
        "other-tab": "browser-other",
        "other-session": "browser-elsewhere",
      };
      useLandingPanelStore
        .getState()
        .activateTab(rowInstanceIds[input.activeRow]);
      recordIndependentPageOpenedTab({
        hostId: HOST_ID,
        sessionId: "session-1",
        tabId: "popup-tab",
        openerTabId: input.openerNamed ? "opener-tab" : null,
        raisedWhileFocused: input.focused,
      });
      const sessions = [
        sessionInfo({
          sessionId: "session-1",
          hostId: HOST_ID,
          scope: independentScope(),
          tabs: [
            tabInfo({
              tabId: "opener-tab",
              url: "https://example.com/",
              boundWindowId: input.openerBoundWindowId,
            }),
            tabInfo({ tabId: "other-tab", url: "https://other.example/" }),
            tabInfo({
              tabId: "popup-tab",
              url: "https://example.com/next",
              boundWindowId: input.popupBoundWindowId,
            }),
          ],
        }),
        sessionInfo({
          sessionId: "session-2",
          hostId: HOST_ID,
          scope: independentScope(),
          tabs: [
            tabInfo({
              tabId: "elsewhere-tab",
              url: "https://elsewhere.example/",
            }),
          ],
        }),
      ];
      const view = renderHook(() =>
        useLandingBrowserReconciliation({
          hostId: HOST_ID,
          sessions: sessionsState({ items: sessions }),
          enabled: true,
        }),
      );
      const state = useLandingPanelStore.getState();
      const popup = state.tabs.find(
        (tab) => tab.kind === "browser" && tab.tabId === "popup-tab",
      );
      // Adopted either way: the panel lists the device's tabs, whoever
      // raised them.
      expect(popup).not.toBeUndefined();
      view.unmount();
      return state.activeInstanceId === popup?.instanceId;
    };
    const native = (
      thisWindowId: string | null,
      activeRow: Pass["activeRow"],
      focused: boolean,
    ): boolean =>
      pass({
        thisWindowId,
        activeRow,
        popupBoundWindowId: "window-a",
        openerBoundWindowId: "window-a",
        openerNamed: true,
        focused,
      });
    const headless = (input: {
      readonly thisWindowId: string | null;
      readonly activeRow: Pass["activeRow"];
      readonly openerNamed: boolean;
      readonly focused: boolean;
    }): boolean =>
      pass({
        ...input,
        popupBoundWindowId: null,
        openerBoundWindowId: null,
      });

    // A native popup is born in its opener's window; that window follows it
    // whatever row its panel was on, and no other window does. The device
    // has already named the window, so focus adds nothing - the reader's
    // click was in a native guest view, not in this document.
    expect(native("window-a", "other-tab", false)).toBe(true);
    expect(native("window-b", "opener", true)).toBe(false);

    // A headless popup reaches every window. The one whose reader was on the
    // opener raised it; a window on another tab of the same device did not.
    expect(
      headless({
        thisWindowId: "window-a",
        activeRow: "opener",
        openerNamed: true,
        focused: true,
      }),
    ).toBe(true);
    expect(
      headless({
        thisWindowId: "window-b",
        activeRow: "other-tab",
        openerNamed: true,
        focused: true,
      }),
    ).toBe(false);
    // The strip is shared, so a second window can be on the opener too. It
    // did not hold focus when the frame arrived, so it did not raise it.
    expect(
      headless({
        thisWindowId: "window-b",
        activeRow: "opener",
        openerNamed: true,
        focused: false,
      }),
    ).toBe(false);
    // A shell with no window id (the browser build) is still a reader.
    expect(
      headless({
        thisWindowId: null,
        activeRow: "opener",
        openerNamed: true,
        focused: true,
      }),
    ).toBe(true);

    // A headless popup from a NATIVE opener: the opener's window raised it,
    // even if that window's panel had moved on to another row.
    expect(
      pass({
        thisWindowId: "window-a",
        activeRow: "other-tab",
        popupBoundWindowId: null,
        openerBoundWindowId: "window-a",
        openerNamed: true,
        focused: true,
      }),
    ).toBe(true);
    expect(
      pass({
        thisWindowId: "window-b",
        activeRow: "opener",
        popupBoundWindowId: null,
        openerBoundWindowId: "window-a",
        openerNamed: true,
        focused: true,
      }),
    ).toBe(false);

    // Opener unknown (`noopener`): the focused window looking at that session
    // is the best answer left. One on another session did not raise it, and
    // neither did a second window on the same session that was not focused -
    // the case where "some active tab of that session" alone picked both.
    expect(
      headless({
        thisWindowId: "window-a",
        activeRow: "other-tab",
        openerNamed: false,
        focused: true,
      }),
    ).toBe(true);
    expect(
      headless({
        thisWindowId: "window-a",
        activeRow: "other-session",
        openerNamed: false,
        focused: true,
      }),
    ).toBe(false);
    expect(
      headless({
        thisWindowId: "window-b",
        activeRow: "other-tab",
        openerNamed: false,
        focused: false,
      }),
    ).toBe(false);
  });

  it("leaves the selection alone for tabs nobody at this keyboard opened", () => {
    storedBrowserTab("browser-1", "tab-1");
    useLandingPanelStore.getState().activateTab("browser-1");
    const session = sessionInfo({
      sessionId: "session-1",
      hostId: HOST_ID,
      scope: independentScope(),
      tabs: [
        tabInfo({ tabId: "tab-1", url: "https://example.com/" }),
        tabInfo({ tabId: "other-tab", url: "https://other.example/" }),
      ],
    });

    renderHook(() =>
      useLandingBrowserReconciliation({
        hostId: HOST_ID,
        sessions: sessionsState({ items: [session] }),
        enabled: true,
      }),
    );

    expect(useLandingPanelStore.getState().tabs).toHaveLength(2);
    expect(useLandingPanelStore.getState().activeInstanceId).toBe("browser-1");
  });

  it("leaves the device's terminal tabs alone across a browser pass that drops every browser tab", () => {
    useLandingPanelStore.getState().addTab({
      kind: "terminal",
      instanceId: "terminal-1",
      sessionId: "terminal-session",
      hostId: HOST_ID,
      cwd: "/workspace/project",
      name: "project",
      titleSource: "default",
    });
    storedBrowserTab("browser-1", "tab-1");

    renderHook(() =>
      useLandingBrowserReconciliation({
        hostId: HOST_ID,
        sessions: sessionsState({ items: [] }),
        enabled: true,
      }),
    );

    expect(
      useLandingPanelStore.getState().tabs.map((tab) => tab.instanceId),
    ).toEqual(["terminal-1"]);
  });
});
