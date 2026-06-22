import "../../../../__tests__/test-browser-apis";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { MockRunnerHost } from "@traycer-clients/shared/host-client/mock/mock-runner-host";
import { HeaderNotificationsBell } from "@/components/layout/header/app-header";
import { TooltipProvider } from "@/components/ui/tooltip";
import { RunnerHostProvider } from "@/providers/runner-host-provider";
import { useAuthStore } from "@/stores/auth/auth-store";
import { __resetNotificationsStoreForTests } from "@/stores/notifications/notifications-store";

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
    useAuthStore.getState().setSignedOut();
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
