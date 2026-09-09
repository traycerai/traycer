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
    connectionGeneration: 0,
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

type WatchedArgs = Parameters<typeof landingBrowserWatchedHostIds>[0];

/**
 * A Start Page on screen with its panel open and nothing being opened, which is
 * where every case below stands unless it says otherwise. The two visibility
 * flags are independent inputs and each case sets exactly the ones it is about.
 */
function watched(overrides: Partial<WatchedArgs>): ReadonlyArray<string> {
  return landingBrowserWatchedHostIds({
    targetHostId: "target",
    activeBrowserHostId: null,
    recentlyActivatedHostIds: [],
    tabHostIds: [],
    paneVisible: true,
    panelWatching: true,
    pendingOpenHostIds: [],
    ...overrides,
  });
}

describe("landingBrowserWatchedHostIds", () => {
  it("pins the target and the active tab's host first, ahead of any budget fill", () => {
    const result = watched({
      activeBrowserHostId: "active",
      tabHostIds: ["active", "strip-1"],
    });

    expect(result).toEqual(["target", "active", "strip-1"]);
  });

  it("caps the watched set at LANDING_BROWSER_WATCHED_HOST_CAP even with more tab hosts than budget", () => {
    const result = watched({
      activeBrowserHostId: "active",
      tabHostIds: ["active", "h1", "h2", "h3", "h4", "h5"],
    });

    // Redden: an unbounded fill would carry every one of the six tab hosts
    // through, for a set of seven with the target.
    expect(result).toHaveLength(LANDING_BROWSER_WATCHED_HOST_CAP);
    expect(result).toEqual(["target", "active", "h1", "h2"]);
  });

  // Split from a single "collapsed or backgrounded" case that asserted the
  // target survived BOTH. Half of that was the leak: the two states differ in
  // whether anything can still reach the device, so they get a case each.
  it("keeps the target for a COLLAPSED panel on a visible page", () => {
    const result = watched({
      activeBrowserHostId: "active",
      recentlyActivatedHostIds: ["recent-1"],
      tabHostIds: ["h1", "h2"],
      panelWatching: false,
    });

    // Redden: reading past the `panelWatching` short-circuit would pull the
    // active host and the strip fill in too. The target itself stays because
    // `app.browser.new` and the chooser's cap count both still work collapsed.
    expect(result).toEqual(["target"]);
  });

  it("releases the target for a BACKGROUNDED page, whose chords cannot reach it", () => {
    const result = watched({
      activeBrowserHostId: "active",
      recentlyActivatedHostIds: ["recent-1"],
      tabHostIds: ["h1", "h2"],
      paneVisible: false,
      panelWatching: false,
    });

    // Redden: adding the target above the `paneVisible` gate - which is where
    // it was - leaves a retained Start Page holding one of the window's twelve
    // streams for a device nothing on screen can ask anything of.
    expect(result).toEqual([]);
  });

  it("holds a device with an unanswered open through a background", () => {
    const result = watched({
      paneVisible: false,
      panelWatching: false,
      pendingOpenHostIds: ["opening"],
    });

    // Redden: releasing on visibility alone unmounts the coordinator the open's
    // `mutationFn` reads when it RUNS, so the ask is refused - or lands a tab
    // on the device that this window never rows.
    expect(result).toEqual(["opening"]);
  });

  it("releases a device whose open has settled", () => {
    const result = watched({
      paneVisible: false,
      panelWatching: false,
      pendingOpenHostIds: [],
    });

    // The other direction, and the one that makes the carve-out a carve-out
    // rather than a second leak: nothing outstanding, nothing held.
    expect(result).toEqual([]);
  });

  it("does not duplicate a pending device that is already watched", () => {
    const result = watched({
      activeBrowserHostId: "active",
      tabHostIds: ["active"],
      pendingOpenHostIds: ["target", "active"],
    });

    expect(result).toEqual(["target", "active"]);
  });

  /**
   * An ACCEPTED open is never evicted, not even by the routing target.
   *
   * Found by execution rather than by reading: with the cap's worth of pending
   * devices and the target elsewhere, ordering the target first took a slot and
   * dropped the last accepted open - the lost-tab failure the carve-out exists
   * to prevent, reintroduced by the cap that bounds it.
   */
  it("keeps every device with an accepted open, dropping the target instead", () => {
    const pending = Array.from(
      { length: LANDING_BROWSER_WATCHED_HOST_CAP },
      (_unused, index) => `open-${index + 1}`,
    );
    const result = watched({
      targetHostId: "target-elsewhere",
      pendingOpenHostIds: pending,
      panelWatching: false,
    });

    // Redden: pinning the target ahead of the pending loop drops `open-4`.
    for (const hostId of pending) expect(result).toContain(hostId);
    expect(result).not.toContain("target-elsewhere");
    expect(result).toHaveLength(LANDING_BROWSER_WATCHED_HOST_CAP);
  });

  it("never adds a pin past the cap once the budget is spent on holds", () => {
    const result = watched({
      targetHostId: "target-elsewhere",
      activeBrowserHostId: "active-elsewhere",
      recentlyActivatedHostIds: ["r1", "r2"],
      tabHostIds: ["t1", "t2"],
      pendingOpenHostIds: ["open-1", "open-2", "open-3", "open-4"],
    });

    // Redden: an unguarded `add(activeBrowserHostId)` makes this the cap plus
    // one, which is a stream the window budget was not asked for. The holds
    // themselves are never what gives way.
    expect(result).toHaveLength(LANDING_BROWSER_WATCHED_HOST_CAP);
    expect(result).not.toContain("target-elsewhere");
    expect(result).not.toContain("active-elsewhere");
  });

  /**
   * Handed more holds than the budget allows, this PRESERVES them and gives up
   * a slot instead of dropping one.
   *
   * The previous shape broke the loop at the cap, which made the backstop's
   * failure mode the exact catastrophe it guards against: an accepted open
   * losing its coordinator, chosen by sort order rather than by age. The cap
   * now lives where the set is mutated (`reserveLandingBrowserOpen`), so this
   * input is unreachable through the openers - and if it is ever reached, one
   * stream too many is bounded and recoverable where a lost tab is not.
   */
  it("keeps every hold it is handed, even past the budget", () => {
    const pending = [
      "open-1",
      "open-2",
      "open-3",
      "open-4",
      "open-5",
      "open-6",
    ];
    const result = watched({
      targetHostId: null,
      pendingOpenHostIds: pending,
      panelWatching: false,
    });

    // Redden: `if (watched.length >= CAP) break` over this loop drops two
    // devices that are still answering.
    for (const hostId of pending) expect(result).toContain(hostId);
  });

  it("fills the remaining budget from recency before falling back to strip order", () => {
    const result = watched({
      recentlyActivatedHostIds: ["recent-1", "recent-2"],
      tabHostIds: ["strip-1", "strip-2", "recent-1"],
    });

    // Redden: filling from `tabHostIds` first (or ignoring recency entirely)
    // would put `strip-1` ahead of `recent-2`, or drop `recent-2` past the cap.
    expect(result).toEqual(["target", "recent-1", "recent-2", "strip-1"]);
  });

  it("never includes a null target", () => {
    const result = watched({
      targetHostId: null,
      activeBrowserHostId: "active",
      tabHostIds: ["active", "h1"],
    });

    // Redden: an unconditional push would land a literal `null` in the list.
    expect(result).toEqual(["active", "h1"]);
  });

  it("evicts the least recently activated non-pinned host once the budget is full", () => {
    const result = watched({
      activeBrowserHostId: "active",
      recentlyActivatedHostIds: ["r1", "r2", "r3"],
      tabHostIds: ["active", "r1", "r2", "r3", "new-host"],
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
