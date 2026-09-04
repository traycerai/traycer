import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import {
  useLandingPanelStore,
  type LandingBrowserPendingKill,
} from "@/stores/home/landing-panel-store";
import type { BrowserSessionsState } from "@/lib/browser-view/sessions/browser-sessions-coordinator";
import {
  epicScope,
  independentScope,
  sessionInfo,
  tabInfo,
} from "@/lib/browser-view/sessions/__tests__/browser-session-test-kit";
import {
  landingBrowserTombstoneDecision,
  useLandingBrowserTombstoneDrain,
} from "../landing-browser-tombstone-drain";

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
    moveTab: () => Promise.reject(new Error("not used in this test")),
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

  it("treats the tab as absent when the session with those ids is epic-scoped", () => {
    // The scope term its two siblings carry. Inert while the only publisher is
    // the fleet's independent provider - which is why the ids here are made
    // IDENTICAL to the tombstone's, so nothing but the scope stands between
    // this and a real `closeTab` at a stranger's live tab.
    const session = sessionInfo({
      sessionId: "session-1",
      hostId: HOST_ID,
      scope: epicScope("epic-1"),
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

/**
 * The decision function is pinned above GIVEN a generation. These drive the
 * hook, which is where the generation is DERIVED - so a false-to-true edge that
 * stopped bumping would leave every case above green while no close was ever
 * re-armed.
 */
describe("useLandingBrowserTombstoneDrain", () => {
  afterEach(() => {
    cleanup();
    useLandingPanelStore.getState().resetForTests();
  });

  function liveSessionsWithTab(
    closeTab: BrowserSessionsState["closeTab"],
  ): BrowserSessionsState {
    return sessionsState({
      closeTab,
      items: [
        sessionInfo({
          sessionId: "session-1",
          hostId: HOST_ID,
          scope: independentScope(),
          tabs: [tabInfo({ tabId: "tab-1" })],
        }),
      ],
    });
  }

  it("sends nothing while the device's inventory is not ready", async () => {
    const closeTab = vi.fn(() => Promise.resolve());
    const pending = pendingKill({});
    useLandingPanelStore.setState({ pendingKills: [pending] });
    renderHook(() =>
      useLandingBrowserTombstoneDrain({
        pendingKills: [pending],
        browserSessions: {
          [HOST_ID]: sessionsState({ closeTab, inventoryReady: false }),
        },
      }),
    );

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(closeTab).not.toHaveBeenCalled();
    // Not cleared either: an unready inventory is not evidence of anything.
    expect(useLandingPanelStore.getState().pendingKills).toEqual([pending]);
  });

  it("re-arms a failed close on the next stream incarnation, and not before", async () => {
    // The whole mechanism in one case: a close goes out, the device answers
    // with a rejection (or the socket took it down), and the mark stays on that
    // generation - so nothing re-sends until the stream drops and comes back,
    // which is the only event that makes the inventory a NEW answer.
    const closeTab = vi.fn(() => Promise.reject(new Error("socket closed")));
    const pending = pendingKill({});
    const view = renderHook(
      (sessions: BrowserSessionsState) =>
        useLandingBrowserTombstoneDrain({
          pendingKills: [pending],
          browserSessions: { [HOST_ID]: sessions },
        }),
      { initialProps: liveSessionsWithTab(closeTab) },
    );

    await waitFor(() => {
      expect(closeTab).toHaveBeenCalledTimes(1);
    });
    expect(closeTab).toHaveBeenCalledWith("session-1", "tab-1");

    // A fresh state object with the same readiness is not a new incarnation.
    view.rerender(liveSessionsWithTab(closeTab));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(closeTab).toHaveBeenCalledTimes(1);

    // Drop, then return: only the false -> true edge advances the generation.
    view.rerender(sessionsState({ closeTab, inventoryReady: false }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(closeTab).toHaveBeenCalledTimes(1);

    view.rerender(liveSessionsWithTab(closeTab));
    await waitFor(() => {
      expect(closeTab).toHaveBeenCalledTimes(2);
    });
  });

  it("clears the tombstone without a close once a ready inventory no longer lists the tab", async () => {
    const closeTab = vi.fn(() => Promise.resolve());
    const pending = pendingKill({});
    useLandingPanelStore.setState({ pendingKills: [pending] });
    renderHook(() =>
      useLandingBrowserTombstoneDrain({
        pendingKills: [pending],
        browserSessions: { [HOST_ID]: sessionsState({ closeTab, items: [] }) },
      }),
    );

    await waitFor(() => {
      expect(useLandingPanelStore.getState().pendingKills).toEqual([]);
    });
    expect(closeTab).not.toHaveBeenCalled();
  });
});
