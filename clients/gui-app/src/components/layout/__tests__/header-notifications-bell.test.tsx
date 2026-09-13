import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { MockRunnerHost } from "@traycer-clients/shared/host-client/mock/mock-runner-host";
import { mockLocalHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import { HeaderNotificationsBell } from "@/components/layout/header/app-header";
import { TooltipProvider } from "@/components/ui/tooltip";
import { RunnerHostProvider } from "@/providers/runner-host-provider";
import { useAuthStore } from "@/stores/auth/auth-store";
import { __resetHostNotificationsStoreForTests } from "@/stores/notifications/host-notifications-store";
import { __resetNotificationsStoreForTests } from "@/stores/notifications/notifications-store";

const activeHostIdRef = vi.hoisted(() => ({
  value: null as string | null,
}));

const directoryRef = vi.hoisted(() => ({
  value: null as {
    findById: (hostId: string) => typeof mockLocalHostEntry | null;
  } | null,
}));

vi.mock("@/hooks/host/use-addressable-host-id", () => ({
  useAddressableHostId: () => activeHostIdRef.value,
}));

// The notification centre reads its host from `useNotificationResolveHost` (the local
// host that owns the streams), not from the app-wide active host. Projected
// from this suite's existing host ref so the scenario it was already
// describing is unchanged.
vi.mock("@/hooks/notifications/use-notification-host", () => ({
  useNotificationResolveHostId: () => activeHostIdRef.value,
  useNotificationResolveHost: () => ({
    hostId: activeHostIdRef.value,
    client: null,
  }),
}));

vi.mock("@/hooks/host/use-host-directory-entry", () => ({
  useHostDirectoryEntry: (hostId: string) => {
    if (hostId.length === 0 || directoryRef.value === null) return null;
    return directoryRef.value.findById(hostId);
  },
}));

function createRunnerHost(): MockRunnerHost {
  return new MockRunnerHost({
    signInUrl: "https://example.com",
    authnBaseUrl: "https://auth.example.com",
    localHost: null,
    hosts: [],
    workspaceFolderPickerPaths: undefined,
    hasLocalHost: undefined,
    traycerCli: undefined,
  });
}

describe("HeaderNotificationsBell auth gate", () => {
  beforeEach(() => {
    __resetNotificationsStoreForTests();
    __resetHostNotificationsStoreForTests();
    useAuthStore.getState().setSignedOut();
    activeHostIdRef.value = mockLocalHostEntry.hostId;
    directoryRef.value = {
      findById: (hostId) =>
        hostId === mockLocalHostEntry.hostId ? mockLocalHostEntry : null,
    };
  });

  afterEach(() => {
    cleanup();
    useAuthStore.getState().setSignedOut();
  });

  it("does not render the bell while signed-out", () => {
    const runnerHost = createRunnerHost();
    render(
      <RunnerHostProvider runnerHost={runnerHost}>
        <TooltipProvider>
          <HeaderNotificationsBell />
        </TooltipProvider>
      </RunnerHostProvider>,
    );
    expect(screen.queryByTestId("notifications-bell")).toBeNull();
  });

  it("renders the bell for an unverified session - the local lanes need their only desktop entry point", () => {
    // The session provider keeps the host-notification and agent-activity
    // lanes running under `unverified` and withholds only the cloud lanes;
    // gating the bell on the cloud verdict left those lanes with no way in.
    useAuthStore
      .getState()
      .setUnverifiedSession(
        { userId: "test-user", userName: "U", email: "u@example.com" },
        { userId: "test-user", username: "U" },
      );
    const runnerHost = createRunnerHost();
    render(
      <RunnerHostProvider runnerHost={runnerHost}>
        <TooltipProvider>
          <HeaderNotificationsBell />
        </TooltipProvider>
      </RunnerHostProvider>,
    );
    expect(screen.getByTestId("notifications-bell")).not.toBeNull();
  });

  it("renders the bell once the user transitions to signed-in", () => {
    const runnerHost = createRunnerHost();
    render(
      <RunnerHostProvider runnerHost={runnerHost}>
        <TooltipProvider>
          <HeaderNotificationsBell />
        </TooltipProvider>
      </RunnerHostProvider>,
    );
    expect(screen.queryByTestId("notifications-bell")).toBeNull();

    act(() => {
      useAuthStore
        .getState()
        .setSignedIn(
          { userId: "test-user", userName: "U", email: "u@example.com" },
          { userId: "test-user", username: "U" },
          [],
        );
    });

    expect(screen.getByTestId("notifications-bell")).not.toBeNull();
  });

  it("dismisses the bell on sign-out", () => {
    useAuthStore
      .getState()
      .setSignedIn(
        { userId: "test-user", userName: "U", email: "u@example.com" },
        { userId: "test-user", username: "U" },
        [],
      );
    const runnerHost = createRunnerHost();
    render(
      <RunnerHostProvider runnerHost={runnerHost}>
        <TooltipProvider>
          <HeaderNotificationsBell />
        </TooltipProvider>
      </RunnerHostProvider>,
    );
    expect(screen.getByTestId("notifications-bell")).not.toBeNull();

    act(() => {
      useAuthStore.getState().setSignedOut();
    });

    expect(screen.queryByTestId("notifications-bell")).toBeNull();
  });
});
