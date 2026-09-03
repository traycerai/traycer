import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { LandingTerminalPersistLifecycleBridge } from "@/providers/landing-terminal-persist-lifecycle-bridge";
import { useLandingBrowserTombstoneDrain } from "@/providers/landing-browser-tombstone-drain";
import type { LandingBrowserSessionEntries } from "@/components/home/terminal-panel/landing-terminal-authority-fleet";
import type { BrowserSessionsState } from "@/lib/browser-view/sessions/browser-sessions-coordinator";
import { useAuthStore } from "@/stores/auth/auth-store";
import {
  useLandingPanelStore,
  type LandingTerminalTabRef,
} from "@/stores/home/landing-panel-store";
import { landingTerminalsKey } from "@/lib/persist";

const mocks = vi.hoisted(() => ({
  findById: vi.fn<(hostId: string) => { readonly hostId: string } | null>(
    () => null,
  ),
  request: vi.fn(() => Promise.resolve(undefined)),
}));

vi.mock("@/lib/host", () => ({
  useHostClient: () => ({
    getActiveHostId: () => null,
  }),
  useHostDirectory: () => ({
    findById: mocks.findById,
  }),
}));
vi.mock("@/hooks/host/use-host-client-for", () => ({
  buildDialableHostClient: () => ({ request: mocks.request }),
}));

const ALICE_EMAIL = "alice@example.com";
const BOB_EMAIL = "bob@example.com";
const ALICE_ID = `user:${ALICE_EMAIL}`;
const BOB_ID = `user:${BOB_EMAIL}`;

function resetAuth(
  status: "signed-out" | "signing-in" | "signed-in",
  email: string | null,
): void {
  if (status === "signed-in" && email !== null) {
    // userId and email deliberately DIFFER: a fixture that equates them
    // cannot detect email-keyed scoping.
    const userId = `user:${email}`;
    useAuthStore.setState({
      status,
      profile: { userId, userName: email, email },
      contextMetadata: { userId, username: email },
    });
    return;
  }
  useAuthStore.setState({ status, profile: null, contextMetadata: null });
}

function persistedTab(identity: string): LandingTerminalTabRef {
  return {
    kind: "terminal",
    instanceId: `${identity}-instance`,
    sessionId: `${identity}-session`,
    hostId: "host-test",
    cwd: "/workspace/project",
    name: identity,
    titleSource: "default",
  };
}

function persistSnapshot(bucketIdentity: string): void {
  const tab = persistedTab(bucketIdentity);
  window.localStorage.setItem(
    landingTerminalsKey(bucketIdentity),
    JSON.stringify({
      state: {
        tabs: [tab],
        activeInstanceId: tab.instanceId,
        layoutsByLandingPageId: {
          "landing-page": {
            panelOpen: true,
            panelWidthFraction: 0.36,
            maximized: false,
          },
        },
        pendingKills: [],
      },
      version: 1,
    }),
  );
}

function resetStore(): void {
  useLandingPanelStore.persist.setOptions({
    name: landingTerminalsKey(null),
  });
  useLandingPanelStore.getState().resetForTests();
}

/**
 * Publishes this window's browser session states exactly the way the always-
 * mounted recovery bridge does - by mounting the drain. Sign-out runs in a
 * callback in the bridge ABOVE that one, so this is how it reaches them.
 */
function BrowserSessionsPublisher(props: {
  readonly sessions: LandingBrowserSessionEntries;
}): ReactNode {
  useLandingBrowserTombstoneDrain({
    pendingKills: [],
    browserSessions: props.sessions,
  });
  return null;
}

function liveBrowserSessions(
  closeTab: BrowserSessionsState["closeTab"],
): BrowserSessionsState {
  return {
    hostId: "host-test",
    lifecycle: "live",
    inventoryReady: true,
    canMaterializeElectron: false,
    items: [],
    errorMessage: null,
    retry: () => undefined,
    openTab: () => Promise.reject(new Error("not used in this test")),
    closeTab,
    attachTab: () => Promise.reject(new Error("not used in this test")),
  };
}

describe("<LandingTerminalPersistLifecycleBridge />", () => {
  beforeEach(() => {
    window.localStorage.clear();
    resetAuth("signed-out", null);
    resetStore();
    mocks.findById.mockReset();
    mocks.findById.mockReturnValue(null);
    mocks.request.mockReset();
    mocks.request.mockImplementation(() => Promise.resolve(undefined));
  });

  afterEach(() => {
    cleanup();
    window.localStorage.clear();
    resetAuth("signed-out", null);
    resetStore();
  });

  it("retargets on identity switch without cross-user terminal tabs", async () => {
    persistSnapshot(ALICE_ID);
    persistSnapshot(BOB_ID);
    render(
      <LandingTerminalPersistLifecycleBridge>
        <div />
      </LandingTerminalPersistLifecycleBridge>,
    );

    act(() => {
      resetAuth("signed-in", ALICE_EMAIL);
    });
    await waitFor(() => {
      expect(useLandingPanelStore.persist.getOptions().name).toBe(
        landingTerminalsKey(ALICE_ID),
      );
      expect(useLandingPanelStore.getState().tabs).toEqual([
        persistedTab(ALICE_ID),
      ]);
    });

    act(() => {
      resetAuth("signed-in", BOB_EMAIL);
    });
    await waitFor(() => {
      expect(useLandingPanelStore.persist.getOptions().name).toBe(
        landingTerminalsKey(BOB_ID),
      );
      expect(useLandingPanelStore.getState().tabs).toEqual([
        persistedTab(BOB_ID),
      ]);
    });
  });

  // The defect this pins: `drainTombstones` walked the MIXED tombstone list and
  // sent `terminal.kill` for every row. A browser tombstone's `sessionId` names
  // the device's shared browser session - a host-minted id nothing proves
  // disjoint from terminal ids - so on a collision it killed a live PTY, while
  // the close it was written to carry was never sent and went with the store.
  it("routes each tombstone kind to its own boundary at sign-out", async () => {
    mocks.findById.mockReturnValue({ hostId: "host-test" });
    const closeTab = vi.fn(() => Promise.resolve());
    const sessions = { "host-test": liveBrowserSessions(closeTab) };
    render(
      <LandingTerminalPersistLifecycleBridge>
        <BrowserSessionsPublisher sessions={sessions} />
      </LandingTerminalPersistLifecycleBridge>,
    );

    act(() => {
      resetAuth("signed-in", ALICE_EMAIL);
    });
    await waitFor(() => {
      expect(useLandingPanelStore.persist.getOptions().name).toBe(
        landingTerminalsKey(ALICE_ID),
      );
    });

    act(() => {
      useLandingPanelStore.setState({
        pendingKills: [
          {
            kind: "terminal",
            hostId: "host-test",
            sessionId: "terminal-session",
            hostAuthorityAcknowledged: true,
            pendingCreate: false,
          },
          {
            kind: "browser",
            hostId: "host-test",
            sessionId: "browser-session",
            tabId: "browser-tab",
          },
        ],
      });
    });

    act(() => {
      resetAuth("signed-out", null);
    });

    await waitFor(() => {
      expect(mocks.request).toHaveBeenCalledTimes(1);
    });
    expect(mocks.request).toHaveBeenCalledWith("terminal.kill", {
      sessionId: "terminal-session",
    });
    // The browser session id never reaches the terminal boundary, whatever the
    // call count says.
    for (const call of mocks.request.mock.calls) {
      expect(JSON.stringify(call)).not.toContain("browser-session");
    }
    expect(closeTab).toHaveBeenCalledTimes(1);
    expect(closeTab).toHaveBeenCalledWith("browser-session", "browser-tab");
  });

  // The other half of the ruling: a device with no stream in this window has
  // nowhere to send the close, so the tombstone goes with the store rather
  // than travelling a second path that does not exist.
  it("drops a browser tombstone whose device has no live stream in this window", async () => {
    mocks.findById.mockReturnValue({ hostId: "host-test" });
    const closeTab = vi.fn(() => Promise.resolve());
    const sessions = {
      "host-test": {
        ...liveBrowserSessions(closeTab),
        inventoryReady: false,
      },
    };
    render(
      <LandingTerminalPersistLifecycleBridge>
        <BrowserSessionsPublisher sessions={sessions} />
      </LandingTerminalPersistLifecycleBridge>,
    );

    act(() => {
      resetAuth("signed-in", ALICE_EMAIL);
    });
    await waitFor(() => {
      expect(useLandingPanelStore.persist.getOptions().name).toBe(
        landingTerminalsKey(ALICE_ID),
      );
    });
    act(() => {
      useLandingPanelStore.setState({
        pendingKills: [
          {
            kind: "browser",
            hostId: "host-test",
            sessionId: "browser-session",
            tabId: "browser-tab",
          },
        ],
      });
    });

    act(() => {
      resetAuth("signed-out", null);
    });

    await waitFor(() => {
      expect(useLandingPanelStore.getState().pendingKills).toEqual([]);
    });
    expect(closeTab).not.toHaveBeenCalled();
    expect(mocks.request).not.toHaveBeenCalled();
  });

  it("adopts the legacy email-keyed bucket into the signed-in user's canonical bucket", async () => {
    // Seeds ONLY the legacy (email-keyed) bucket, so a successful load can
    // only be explained by the one-shot adoption path onto the userId key.
    persistSnapshot(ALICE_EMAIL);
    render(
      <LandingTerminalPersistLifecycleBridge>
        <div />
      </LandingTerminalPersistLifecycleBridge>,
    );

    act(() => {
      resetAuth("signed-in", ALICE_EMAIL);
    });

    await waitFor(() => {
      expect(useLandingPanelStore.persist.getOptions().name).toBe(
        landingTerminalsKey(ALICE_ID),
      );
      expect(useLandingPanelStore.getState().tabs).toEqual([
        persistedTab(ALICE_EMAIL),
      ]);
    });
  });
});
