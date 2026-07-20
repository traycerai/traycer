import "../../../__tests__/test-browser-apis";
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

function resetAuth(
  status: "signed-out" | "signing-in" | "signed-in",
  email: string | null,
): void {
  if (status === "signed-in" && email !== null) {
    useAuthStore.setState({
      status,
      profile: { userId: email, userName: email, email },
      contextMetadata: { userId: email, username: email },
    });
    return;
  }
  useAuthStore.setState({ status, profile: null, contextMetadata: null });
}

function persistedTab(email: string): LandingTerminalTabRef {
  return {
    instanceId: `${email}-instance`,
    sessionId: `${email}-session`,
    hostId: "host-test",
    cwd: "/workspace/project",
    name: email,
    titleSource: "default",
  };
}

function persistSnapshot(email: string): void {
  const tab = persistedTab(email);
  window.localStorage.setItem(
    landingTerminalsKey(email),
    JSON.stringify({
      state: {
        tabs: [tab],
        activeInstanceId: tab.instanceId,
        panelOpen: true,
        panelWidthFraction: 0.36,
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
    persistSnapshot("alice@example.com");
    persistSnapshot("bob@example.com");
    render(
      <LandingTerminalPersistLifecycleBridge>
        <div />
      </LandingTerminalPersistLifecycleBridge>,
    );

    act(() => {
      resetAuth("signed-in", "alice@example.com");
    });
    await waitFor(() => {
      expect(useLandingTerminalStore.persist.getOptions().name).toBe(
        landingTerminalsKey("alice@example.com"),
      );
      expect(useLandingTerminalStore.getState().tabs).toEqual([
        persistedTab("alice@example.com"),
      ]);
    });

    act(() => {
      resetAuth("signed-in", "bob@example.com");
    });
    await waitFor(() => {
      expect(useLandingTerminalStore.persist.getOptions().name).toBe(
        landingTerminalsKey("bob@example.com"),
      );
      expect(useLandingTerminalStore.getState().tabs).toEqual([
        persistedTab("bob@example.com"),
      ]);
    });
  });
});
