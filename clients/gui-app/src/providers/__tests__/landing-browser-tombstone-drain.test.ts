import { describe, expect, it } from "vitest";
import type { LandingBrowserPendingKill } from "@/stores/home/landing-panel-store";
import type { BrowserSessionsState } from "@/lib/browser-view/sessions/browser-sessions-coordinator";
import {
  independentScope,
  sessionInfo,
  tabInfo,
} from "@/lib/browser-view/sessions/__tests__/browser-session-test-kit";
import { landingBrowserTombstoneDecision } from "../landing-browser-tombstone-drain";

const HOST_ID = "host-a";

function pendingKill(
  overrides: Partial<LandingBrowserPendingKill>,
): LandingBrowserPendingKill {
  return {
    kind: "browser",
    hostId: HOST_ID,
    sessionId: "session-1",
    tabId: "tab-1",
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

describe("landingBrowserTombstoneDecision", () => {
  it("waits when no sessions state is mounted for the device yet", () => {
    const action = landingBrowserTombstoneDecision({
      pending: pendingKill({}),
      sessions: null,
      attemptedGeneration: null,
      generation: 1,
    });

    expect(action).toBe("wait");
  });

  it("waits when the inventory is not ready, even with an empty items array", () => {
    // The regression this guards: an empty `items` on a connecting stream
    // must not be read as "the tab is gone" - `inventoryReady` is the gate,
    // never the array's length.
    const sessions = sessionsState({ inventoryReady: false, items: [] });

    const action = landingBrowserTombstoneDecision({
      pending: pendingKill({}),
      sessions,
      attemptedGeneration: null,
      generation: 1,
    });

    expect(action).toBe("wait");
  });

  it("closes when ready, the tab is present, and nothing has been attempted yet", () => {
    const session = sessionInfo({
      sessionId: "session-1",
      hostId: HOST_ID,
      scope: independentScope(),
      tabs: [tabInfo({ tabId: "tab-1" })],
    });
    const sessions = sessionsState({ items: [session] });

    const action = landingBrowserTombstoneDecision({
      pending: pendingKill({}),
      sessions,
      attemptedGeneration: null,
      generation: 1,
    });

    expect(action).toBe("close");
  });

  it("clears when ready and the tab is absent", () => {
    const sessions = sessionsState({ items: [] });

    const action = landingBrowserTombstoneDecision({
      pending: pendingKill({}),
      sessions,
      attemptedGeneration: null,
      generation: 1,
    });

    expect(action).toBe("clear");
  });

  it("waits when a close was already attempted on this same generation", () => {
    const session = sessionInfo({
      sessionId: "session-1",
      hostId: HOST_ID,
      scope: independentScope(),
      tabs: [tabInfo({ tabId: "tab-1" })],
    });
    const sessions = sessionsState({ items: [session] });

    const action = landingBrowserTombstoneDecision({
      pending: pendingKill({}),
      sessions,
      attemptedGeneration: 3,
      generation: 3,
    });

    expect(action).toBe("wait");
  });

  it("re-arms the close when the generation has advanced since the last attempt", () => {
    // A new stream incarnation re-arms the send: the close may have gone
    // down with the socket, and the fresh inventory is a new answer rather
    // than the one already acted on.
    const session = sessionInfo({
      sessionId: "session-1",
      hostId: HOST_ID,
      scope: independentScope(),
      tabs: [tabInfo({ tabId: "tab-1" })],
    });
    const sessions = sessionsState({ items: [session] });

    const action = landingBrowserTombstoneDecision({
      pending: pendingKill({}),
      sessions,
      attemptedGeneration: 2,
      generation: 3,
    });

    expect(action).toBe("close");
  });

  it("treats the tab as absent when the matching sessionId belongs to a different host", () => {
    const session = sessionInfo({
      sessionId: "session-1",
      hostId: "host-other",
      scope: independentScope(),
      tabs: [tabInfo({ tabId: "tab-1" })],
    });
    const sessions = sessionsState({ items: [session] });

    const action = landingBrowserTombstoneDecision({
      pending: pendingKill({}),
      sessions,
      attemptedGeneration: null,
      generation: 1,
    });

    expect(action).toBe("clear");
  });
});
