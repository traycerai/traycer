import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MockRunnerHost } from "@traycer-clients/shared/host-client/mock/mock-runner-host";

// The host-boot splash now reuses the shared <AppHeader>, which
// mounts the real <UserMenu>, <SignInButton>, and
// <NotificationsBell> subtrees. All three reach for a host-runtime
// context that isn't wired up in this unit test (the splash renders
// above the host gate in production, above the router in tests), so
// we stub them here and keep the test focused on the splash's own copy
// and retry wiring.
vi.mock("@/components/layout/header/sign-in-button", () => ({
  SignInButton: () => null,
}));
vi.mock("@/components/notifications/notifications-bell", () => ({
  NotificationsBell: () => null,
}));
vi.mock("@/components/auth/user-menu", () => ({
  UserMenu: (props: {
    userName: string;
    email: string;
    showAppSettings: boolean;
    showSwitchHost: boolean;
  }) => (
    <div data-testid="app-header-user-badge">
      <span>{props.userName}</span>
      <span>{props.email}</span>
    </div>
  ),
}));

import { LocalHostLoading } from "@/components/local-host-loading";
import { TooltipProvider } from "@/components/ui/tooltip";
import { RunnerHostProvider } from "@/providers/runner-host-provider";
import { useAuthStore } from "@/stores/auth/auth-store";

function buildHost(): MockRunnerHost {
  return new MockRunnerHost({
    signInUrl: "https://auth.traycer.invalid/sign-in",
    authnBaseUrl: "http://localhost:5005",
    localHost: null,
    hosts: [],
    workspaceFolderPickerPaths: undefined,
    hasLocalHost: undefined,
    traycerCli: undefined,
  });
}

function buildQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
}

function mountLoading(host: MockRunnerHost, stage: "loading" | "slow"): void {
  render(
    <QueryClientProvider client={buildQueryClient()}>
      <RunnerHostProvider runnerHost={host}>
        <TooltipProvider>
          <LocalHostLoading
            stage={stage}
            progress={null}
            onConfigureShell={() => undefined}
          />
        </TooltipProvider>
      </RunnerHostProvider>
    </QueryClientProvider>,
  );
}

describe("<LocalHostLoading />", () => {
  afterEach(() => {
    cleanup();
    useAuthStore.getState().setSignedOut();
  });

  it('renders identity, spinner, heading, and no Retry or [host] logs hint on stage="loading"', () => {
    useAuthStore.getState().setSignedIn(
      {
        userId: "test-user",
        userName: "Test User",
        email: "test@example.com",
      },
      { userId: "test-user", username: "Test User" },
      [],
    );
    mountLoading(buildHost(), "loading");

    const root = screen.getByTestId("local-host-loading");
    expect(root.getAttribute("data-stage")).toBe("loading");

    // Identity sourced from auth store.
    const identity = screen.getByTestId("app-header-user-badge");
    expect(identity.textContent).toContain("Test User");
    expect(identity.textContent).toContain("test@example.com");

    // Spinner is visible.
    expect(screen.queryByTestId("local-host-loading-spinner")).not.toBeNull();

    // Primary heading.
    expect(root.textContent).toContain("Starting local Traycer Host…");

    // No slow-start surface on the loading stage.
    expect(screen.queryByTestId("local-host-loading-slow-copy")).toBeNull();
    expect(screen.queryByTestId("local-host-retry")).toBeNull();
    expect(root.textContent).not.toContain("[host]");
  });

  it('renders identity, spinner, slow-start copy, and a working Retry on stage="slow"', async () => {
    useAuthStore.getState().setSignedIn(
      {
        userId: "test-user",
        userName: "Test User",
        email: "test@example.com",
      },
      { userId: "test-user", username: "Test User" },
      [],
    );
    const host = buildHost();
    mountLoading(host, "slow");

    const root = screen.getByTestId("local-host-loading");
    expect(root.getAttribute("data-stage")).toBe("slow");

    // Identity and spinner remain visible on the slow stage.
    expect(screen.queryByTestId("app-header-user-badge")).not.toBeNull();
    expect(screen.queryByTestId("local-host-loading-spinner")).not.toBeNull();

    // Slow-start copy tells the user the bootstrap is taking longer than
    // usual; the live bootstrap.log tail above gives the actual diagnostics.
    const slow = screen.getByTestId("local-host-loading-slow-copy");
    expect(slow.textContent).toContain("longer than expected");

    // Retry wires to runnerHost.requestHostRespawn().
    const retry = screen.getByTestId("local-host-retry");
    expect(host.requestHostRespawnCalls).toBe(0);
    fireEvent.click(retry);
    await waitFor(() => {
      expect(host.requestHostRespawnCalls).toBe(1);
    });
  });

  it("sources identity from useAuthStore profile (email fallback for initials)", () => {
    useAuthStore.getState().setSignedIn(
      {
        userId: "test-user",
        userName: "",
        email: "alice@example.com",
      },
      { userId: "test-user", username: "alice@example.com" },
      [],
    );
    mountLoading(buildHost(), "loading");

    const identity = screen.getByTestId("app-header-user-badge");
    expect(identity.textContent).toContain("alice@example.com");
  });

  it("omits the identity badge when the auth store has no resolved profile (defensive)", () => {
    useAuthStore.getState().setSignedOut();
    mountLoading(buildHost(), "loading");

    expect(screen.queryByTestId("app-header-user-badge")).toBeNull();
    // The centered waiting panel still renders.
    expect(screen.queryByTestId("local-host-loading")).not.toBeNull();
    expect(screen.queryByTestId("local-host-loading-spinner")).not.toBeNull();
  });

  it("renders host download progress with percentage and byte count", () => {
    useAuthStore.getState().setSignedIn(
      {
        userId: "test-user",
        userName: "Test User",
        email: "test@example.com",
      },
      { userId: "test-user", username: "Test User" },
      [],
    );
    render(
      <QueryClientProvider client={buildQueryClient()}>
        <RunnerHostProvider runnerHost={buildHost()}>
          <TooltipProvider>
            <LocalHostLoading
              stage="loading"
              progress={{
                stage: "download",
                percent: 42,
                bytes: 104_857_600,
                totalBytes: 250_609_664,
                message: "downloading host 1.2.3",
              }}
              onConfigureShell={() => undefined}
            />
          </TooltipProvider>
        </RunnerHostProvider>
      </QueryClientProvider>,
    );

    const root = screen.getByTestId("local-host-loading");
    expect(root.textContent).toContain("Downloading Traycer Host…");
    expect(root.textContent).toContain("downloading host 1.2.3");
    expect(root.textContent).toContain("100 MB of 239 MB");
    expect(root.textContent).toContain("42%");
    const progress = screen.getByRole("progressbar");
    expect(progress.getAttribute("aria-valuenow")).toBe("42");
  });

  it("uses setup copy for non-download progress without byte counts", () => {
    useAuthStore.getState().setSignedIn(
      {
        userId: "test-user",
        userName: "Test User",
        email: "test@example.com",
      },
      { userId: "test-user", username: "Test User" },
      [],
    );
    render(
      <QueryClientProvider client={buildQueryClient()}>
        <RunnerHostProvider runnerHost={buildHost()}>
          <TooltipProvider>
            <LocalHostLoading
              stage="loading"
              progress={{
                stage: "extract",
                percent: 80,
                bytes: null,
                totalBytes: null,
                message: "extracting host runtime",
              }}
              onConfigureShell={() => undefined}
            />
          </TooltipProvider>
        </RunnerHostProvider>
      </QueryClientProvider>,
    );

    const root = screen.getByTestId("local-host-loading");
    expect(root.textContent).toContain("Setting up Traycer Host…");
    expect(root.textContent).toContain("Setting up…");
    expect(root.textContent).toContain("80%");
    expect(root.textContent).not.toContain("Downloading…");
  });
});
