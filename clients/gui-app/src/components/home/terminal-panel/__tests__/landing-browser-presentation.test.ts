import { describe, expect, it } from "vitest";
import type { LandingBrowserTabRef } from "@/stores/home/landing-panel-store";
import type { BrowserSessionsState } from "@/lib/browser-view/sessions/browser-sessions-coordinator";
import {
  independentScope,
  sessionInfo,
  tabInfo,
} from "@/lib/browser-view/sessions/__tests__/browser-session-test-kit";
import { selectLandingBrowserViewModel } from "../landing-browser-presentation";

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

describe("selectLandingBrowserViewModel", () => {
  it("reports runtime-unknown with the stored title when sessions is null", () => {
    const tab = browserTabRef({ name: "Stored Title" });

    const result = selectLandingBrowserViewModel({ tab, sessions: null });

    expect(result).toEqual({
      displayTitle: "Stored Title",
      address: null,
      isDormant: false,
      isRuntimeUnknown: true,
    });
  });

  it("reports runtime-unknown with the stored title when the inventory is not ready, even with an empty items array", () => {
    const tab = browserTabRef({ name: "Stored Title" });
    const sessions = sessionsState({ inventoryReady: false, items: [] });

    const result = selectLandingBrowserViewModel({ tab, sessions });

    expect(result).toEqual({
      displayTitle: "Stored Title",
      address: null,
      isDormant: false,
      isRuntimeUnknown: true,
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

    const result = selectLandingBrowserViewModel({ tab, sessions });

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

    const result = selectLandingBrowserViewModel({ tab, sessions });

    expect(result.displayTitle).toBe("My Manual Title");
    expect(result.address).toBe("https://live.example/");
    expect(result.isRuntimeUnknown).toBe(false);
  });

  it("reports the stored title with runtime known - not unknown - once the session is gone", () => {
    const tab = browserTabRef({ name: "Stored Name" });
    const sessions = sessionsState({ items: [] });

    const result = selectLandingBrowserViewModel({ tab, sessions });

    expect(result).toEqual({
      displayTitle: "Stored Name",
      address: null,
      isDormant: false,
      isRuntimeUnknown: false,
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

    const result = selectLandingBrowserViewModel({ tab, sessions });

    expect(result).toEqual({
      displayTitle: "Stored Name",
      address: null,
      isDormant: false,
      isRuntimeUnknown: false,
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

    const result = selectLandingBrowserViewModel({ tab, sessions });

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

    const result = selectLandingBrowserViewModel({ tab, sessions });

    expect(result.isDormant).toBe(true);
  });
});
