import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { LandingTerminalPersistLifecycleBridge } from "@/providers/landing-terminal-persist-lifecycle-bridge";
import { useAuthStore } from "@/stores/auth/auth-store";
import {
  useLandingTerminalStore,
  type LandingTerminalTabRef,
} from "@/stores/home/landing-terminal-store";
import { landingTerminalsKey } from "@/lib/persist";

vi.mock("@/lib/host", () => ({
  useHostClient: () => ({
    getActiveHostId: () => null,
  }),
  useHostDirectory: () => ({
    findById: () => null,
  }),
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
  useLandingTerminalStore.persist.setOptions({
    name: landingTerminalsKey(null),
  });
  useLandingTerminalStore.getState().resetForTests();
}

describe("<LandingTerminalPersistLifecycleBridge />", () => {
  beforeEach(() => {
    window.localStorage.clear();
    resetAuth("signed-out", null);
    resetStore();
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
      expect(useLandingTerminalStore.persist.getOptions().name).toBe(
        landingTerminalsKey(ALICE_ID),
      );
      expect(useLandingTerminalStore.getState().tabs).toEqual([
        persistedTab(ALICE_ID),
      ]);
    });

    act(() => {
      resetAuth("signed-in", BOB_EMAIL);
    });
    await waitFor(() => {
      expect(useLandingTerminalStore.persist.getOptions().name).toBe(
        landingTerminalsKey(BOB_ID),
      );
      expect(useLandingTerminalStore.getState().tabs).toEqual([
        persistedTab(BOB_ID),
      ]);
    });
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
      expect(useLandingTerminalStore.persist.getOptions().name).toBe(
        landingTerminalsKey(ALICE_ID),
      );
      expect(useLandingTerminalStore.getState().tabs).toEqual([
        persistedTab(ALICE_EMAIL),
      ]);
    });
  });
});
