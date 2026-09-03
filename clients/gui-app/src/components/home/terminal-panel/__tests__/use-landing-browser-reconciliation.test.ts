import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, renderHook } from "@testing-library/react";
import type { BrowserSessionsState } from "@/lib/browser-view/sessions/browser-sessions-coordinator";
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
