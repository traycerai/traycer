import { describe, expect, it } from "vitest";
import type { LandingBrowserTabRef } from "@/stores/home/landing-panel-store";
import type { BrowserSessionsState } from "@/lib/browser-view/sessions/browser-sessions-coordinator";
import {
  independentScope,
  sessionInfo,
  tabInfo,
} from "@/lib/browser-view/sessions/__tests__/browser-session-test-kit";
import {
  LANDING_BROWSER_WATCHED_HOST_CAP,
  landingBrowserWatchedHostIds,
  selectLandingBrowserViewModel,
} from "../landing-browser-presentation";

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

describe("landingBrowserWatchedHostIds", () => {
  it("pins the target and the active tab's host first, ahead of any budget fill", () => {
    const result = landingBrowserWatchedHostIds({
      targetHostId: "target",
      activeBrowserHostId: "active",
      recentlyActivatedHostIds: [],
      tabHostIds: ["active", "strip-1"],
      panelWatching: true,
    });

    expect(result).toEqual(["target", "active", "strip-1"]);
  });

  it("caps the watched set at LANDING_BROWSER_WATCHED_HOST_CAP even with more tab hosts than budget", () => {
    const result = landingBrowserWatchedHostIds({
      targetHostId: "target",
      activeBrowserHostId: "active",
      recentlyActivatedHostIds: [],
      tabHostIds: ["active", "h1", "h2", "h3", "h4", "h5"],
      panelWatching: true,
    });

    // Redden: an unbounded fill would carry every one of the six tab hosts
    // through, for a set of seven with the target.
    expect(result).toHaveLength(LANDING_BROWSER_WATCHED_HOST_CAP);
    expect(result).toEqual(["target", "active", "h1", "h2"]);
  });

  it("returns the target alone when the panel is not watching (collapsed or backgrounded)", () => {
    const result = landingBrowserWatchedHostIds({
      targetHostId: "target",
      activeBrowserHostId: "active",
      recentlyActivatedHostIds: ["recent-1"],
      tabHostIds: ["h1", "h2"],
      panelWatching: false,
    });

    // Redden: reading past the `panelWatching` short-circuit would pull the
    // active host and the strip fill in too.
    expect(result).toEqual(["target"]);
  });

  it("fills the remaining budget from recency before falling back to strip order", () => {
    const result = landingBrowserWatchedHostIds({
      targetHostId: "target",
      activeBrowserHostId: null,
      recentlyActivatedHostIds: ["recent-1", "recent-2"],
      tabHostIds: ["strip-1", "strip-2", "recent-1"],
      panelWatching: true,
    });

    // Redden: filling from `tabHostIds` first (or ignoring recency entirely)
    // would put `strip-1` ahead of `recent-2`, or drop `recent-2` past the cap.
    expect(result).toEqual(["target", "recent-1", "recent-2", "strip-1"]);
  });

  it("never includes a null target", () => {
    const result = landingBrowserWatchedHostIds({
      targetHostId: null,
      activeBrowserHostId: "active",
      recentlyActivatedHostIds: [],
      tabHostIds: ["active", "h1"],
      panelWatching: true,
    });

    // Redden: an unconditional push would land a literal `null` in the list.
    expect(result).toEqual(["active", "h1"]);
  });

  it("evicts the least recently activated non-pinned host once the budget is full", () => {
    const result = landingBrowserWatchedHostIds({
      targetHostId: "target",
      activeBrowserHostId: "active",
      recentlyActivatedHostIds: ["r1", "r2", "r3"],
      tabHostIds: ["active", "r1", "r2", "r3", "new-host"],
      panelWatching: true,
    });

    // Redden: without the cap, `r3` and `new-host` would both make it in.
    expect(result).toEqual(["target", "active", "r1", "r2"]);
    expect(result).not.toContain("r3");
    expect(result).not.toContain("new-host");
  });
});

describe("selectLandingBrowserViewModel", () => {
  it("reports runtime-unknown with the stored title when sessions is null", () => {
    const tab = browserTabRef({ name: "Stored Title" });

    const result = selectLandingBrowserViewModel({
      tab,
      sessions: null,
      watchedHostIds: [HOST_ID],
    });

    expect(result).toEqual({
      displayTitle: "Stored Title",
      address: null,
      isDormant: false,
      isRuntimeUnknown: true,
      isUnwatched: false,
    });
  });

  it("reports runtime-unknown with the stored title when the inventory is not ready, even with an empty items array", () => {
    const tab = browserTabRef({ name: "Stored Title" });
    const sessions = sessionsState({ inventoryReady: false, items: [] });

    const result = selectLandingBrowserViewModel({
      tab,
      sessions,
      watchedHostIds: [HOST_ID],
    });

    expect(result).toEqual({
      displayTitle: "Stored Title",
      address: null,
      isDormant: false,
      isRuntimeUnknown: true,
      isUnwatched: false,
    });
  });

  it("reads the live title and address once ready and present", () => {
    const tab = browserTabRef({ name: "Stale", titleSource: "default" });
    const session = sessionInfo({
      sessionId: "session-1",
      hostId: HOST_ID,
      scope: independentScope(),
      tabs: [
        tabInfo({
          tabId: "tab-1",
          title: "Live Title",
          url: "https://live.example/",
        }),
      ],
    });
    const sessions = sessionsState({ items: [session] });

    const result = selectLandingBrowserViewModel({
      tab,
      sessions,
      watchedHostIds: [HOST_ID],
    });

    expect(result.displayTitle).toBe("Live Title");
    expect(result.address).toBe("https://live.example/");
    expect(result.isRuntimeUnknown).toBe(false);
  });

  it("keeps the stored manual title over the live one once ready and present", () => {
    const tab = browserTabRef({
      name: "My Manual Title",
      titleSource: "manual",
    });
    const session = sessionInfo({
      sessionId: "session-1",
      hostId: HOST_ID,
      scope: independentScope(),
      tabs: [
        tabInfo({
          tabId: "tab-1",
          title: "Live Title",
          url: "https://live.example/",
        }),
      ],
    });
    const sessions = sessionsState({ items: [session] });

    const result = selectLandingBrowserViewModel({
      tab,
      sessions,
      watchedHostIds: [HOST_ID],
    });

    expect(result.displayTitle).toBe("My Manual Title");
    expect(result.address).toBe("https://live.example/");
    expect(result.isRuntimeUnknown).toBe(false);
  });

  it("reports the stored title with runtime known - not unknown - once the session is gone", () => {
    const tab = browserTabRef({ name: "Stored Name" });
    const sessions = sessionsState({ items: [] });

    const result = selectLandingBrowserViewModel({
      tab,
      sessions,
      watchedHostIds: [HOST_ID],
    });

    expect(result).toEqual({
      displayTitle: "Stored Name",
      address: null,
      isDormant: false,
      isRuntimeUnknown: false,
      isUnwatched: false,
    });
  });

  it("reports the stored title with runtime known - not unknown - once the tab is gone from a present session", () => {
    const tab = browserTabRef({ name: "Stored Name" });
    const session = sessionInfo({
      sessionId: "session-1",
      hostId: HOST_ID,
      scope: independentScope(),
      tabs: [],
    });
    const sessions = sessionsState({ items: [session] });

    const result = selectLandingBrowserViewModel({
      tab,
      sessions,
      watchedHostIds: [HOST_ID],
    });

    expect(result).toEqual({
      displayTitle: "Stored Name",
      address: null,
      isDormant: false,
      isRuntimeUnknown: false,
      isUnwatched: false,
    });
  });

  it("is dormant when the live tab's own status is dormant", () => {
    const tab = browserTabRef({});
    const session = sessionInfo({
      sessionId: "session-1",
      hostId: HOST_ID,
      scope: independentScope(),
      runtime: { kind: "headless", revision: 1 },
      tabs: [tabInfo({ tabId: "tab-1", status: "dormant" })],
    });
    const sessions = sessionsState({ items: [session] });

    const result = selectLandingBrowserViewModel({
      tab,
      sessions,
      watchedHostIds: [HOST_ID],
    });

    expect(result.isDormant).toBe(true);
  });

  it("is dormant when the session's runtime kind is dormant, even though the tab itself reads ready", () => {
    const tab = browserTabRef({});
    const session = sessionInfo({
      sessionId: "session-1",
      hostId: HOST_ID,
      scope: independentScope(),
      runtime: { kind: "dormant", revision: 1 },
      tabs: [tabInfo({ tabId: "tab-1", status: "ready" })],
    });
    const sessions = sessionsState({ items: [session] });

    const result = selectLandingBrowserViewModel({
      tab,
      sessions,
      watchedHostIds: [HOST_ID],
    });

    expect(result.isDormant).toBe(true);
  });

  it("returns the stored name with every other flag false, and isUnwatched true, for a host outside the watched list - even against a fully live inventory that would otherwise win", () => {
    const tab = browserTabRef({ name: "Stored Name" });
    const session = sessionInfo({
      sessionId: "session-1",
      hostId: HOST_ID,
      scope: independentScope(),
      tabs: [
        tabInfo({
          tabId: "tab-1",
          title: "Live Title",
          url: "https://live.example/",
        }),
      ],
    });
    const sessions = sessionsState({ items: [session] });

    const result = selectLandingBrowserViewModel({
      tab,
      sessions,
      watchedHostIds: [],
    });

    // Redden: reading the inventory before the watched check would report the
    // live title and address instead of the stored, unwatched shape.
    expect(result).toEqual({
      displayTitle: "Stored Name",
      address: null,
      isDormant: false,
      isRuntimeUnknown: false,
      isUnwatched: true,
    });
  });
});
