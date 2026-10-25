import type { AuthenticatedUser } from "@traycer/protocol/auth";
import type { EnvironmentSecret } from "@traycer/protocol/host/environment-schemas";
import type { HostListItem } from "@traycer/protocol/host/host-status";
import type { ProviderCliState } from "@traycer/protocol/host/provider-schemas";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  userSubscription,
  userWith,
} from "@/lib/sandboxes/__tests__/auth-user-fixture";
import {
  profile,
  provider,
} from "@/components/settings/panels/permissions/__tests__/judge-test-support";
import { useSettingsEnvironmentPickStore } from "@/stores/settings/settings-environment-pick-store";

const mocks = vi.hoisted(() => ({
  providers: [] as ProviderCliState[],
  secrets: [] as EnvironmentSecret[],
  tasks: [] as readonly { readonly id: string }[],
  hosts: [] as HostListItem[],
  user: null as AuthenticatedUser | null,
  staged: null as { readonly target: { readonly kind: string } } | null,
  openLink: vi.fn(() => Promise.resolve()),
}));

vi.mock("@/lib/links/open-link", () => ({
  useOpenLink: () => mocks.openLink,
}));

vi.mock("@/hooks/providers/use-providers-list-query", () => ({
  useProvidersListForClient: () => ({
    data: { providers: mocks.providers },
  }),
}));

vi.mock("@/hooks/host/use-host-query", () => ({
  useHostQuery: () => ({ data: { secrets: mocks.secrets } }),
}));

vi.mock("@/hooks/host/use-host-supports-method", () => ({
  useHostMethodSupport: () => true,
}));

vi.mock("@/hooks/host/use-requester-host-id", () => ({
  useRequesterHostId: () => "host-1",
}));

vi.mock("@/hooks/epics/use-cloud-epic-tasks-query", () => ({
  useCloudEpicTasksQuery: () => ({ tasks: mocks.tasks }),
}));

vi.mock("@/hooks/auth/use-registered-hosts-query", () => ({
  useRegisteredHosts: () => ({ data: { hosts: mocks.hosts } }),
}));

vi.mock("@/hooks/auth/use-auth-user-query", () => ({
  useAuthUser: () => ({ data: mocks.user }),
}));

vi.mock("@/lib/sandboxes/staged-sandbox-in-window", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@/lib/sandboxes/staged-sandbox-in-window")
    >();
  return {
    ...actual,
    useStagedSandboxInThisWindow: () => mocks.staged,
  };
});

vi.mock("@/lib/host", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/host")>();
  return {
    ...actual,
    useOptionalHostClient: () => ({}),
    useHostBinding: () => null,
  };
});

vi.mock("@/providers/use-runner-host", () => ({
  useRunnerHostOrNull: () => ({ signInUrl: "https://traycer.ai/sign-in" }),
}));

const navigateMock = vi.hoisted(() => vi.fn());
const activateTabIntentMock = vi.hoisted(() =>
  vi.fn((_navigate: unknown, _intent: unknown, _options: unknown) => true),
);
const setSectionMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/tab-navigation", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/tab-navigation")>();
  return { ...actual, activateTabIntent: activateTabIntentMock };
});

vi.mock("@tanstack/react-router", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@tanstack/react-router")>();
  return { ...actual, useNavigate: () => navigateMock };
});

vi.mock("@/stores/tabs/system-tab-modal-bridge", () => ({
  getSystemTabModalApi: () => ({
    isOverlayActive: () => true,
    setSection: setSectionMock,
    openSettings: vi.fn(),
  }),
}));

import { GettingStartedSettingsPanel } from "@/components/settings/panels/getting-started-settings-panel";

function storedKeyProvider(): ProviderCliState {
  return {
    ...provider("claude-code", [profile("work", "managed")]),
    apiKey: { supported: true, configured: true, source: "stored" },
  };
}

function secret(): EnvironmentSecret {
  return {
    secretId: "secret-1",
    name: "DEPLOY_KEY",
    kind: "api_key",
    protocol: null,
    destinations: [],
    mode: "brokered",
    state: "live",
    currentVersionId: "v1",
    revoked: false,
    updatedAt: 1,
  };
}

function personalHost(hostId: string): HostListItem {
  return {
    hostId,
    displayName: hostId,
    platform: "linux",
    kind: "personal",
    publicKey: `pk-${hostId}`,
    createdAt: "2026-10-01T00:00:00.000Z",
    status: {
      connectivity: "connectable",
      viewerReachability: "unknown",
      clientCloud: "ok",
      updateState: "current",
      appVersion: "1.5.0",
      lastSeenAt: "2026-10-09T00:00:00.000Z",
    },
    updatePolicy: "manual",
    sandboxState: "awake",
    sandboxFrozen: false,
    profile: "agent",
    owner: { kind: "user", id: "u1" },
  };
}

function zeroUser(): AuthenticatedUser {
  return userWith(
    userSubscription({
      totalPlanCredits: 0,
      consumedFromPlan: 0,
      bonusCredits: 0,
      consumedFromBonus: 0,
      bundleRemaining: 0,
    }),
    [],
  );
}

function positiveUser(): AuthenticatedUser {
  return userWith(
    userSubscription({
      totalPlanCredits: 100,
      consumedFromPlan: 30,
      bonusCredits: 0,
      consumedFromBonus: 0,
      bundleRemaining: 0,
    }),
    [],
  );
}

describe("GettingStartedSettingsPanel", () => {
  beforeEach(() => {
    mocks.providers = [];
    mocks.secrets = [];
    mocks.tasks = [];
    mocks.hosts = [];
    mocks.user = zeroUser();
    mocks.staged = null;
    mocks.openLink.mockClear();
    navigateMock.mockReset();
    activateTabIntentMock.mockClear();
    setSectionMock.mockReset();
    useSettingsEnvironmentPickStore.setState({ pick: null });
  });

  afterEach(() => {
    cleanup();
  });

  it("draws the design's four always-on steps and no tour, appearance, or browser cards", () => {
    render(<GettingStartedSettingsPanel />);

    expect(screen.getByRole("status").textContent).toBe("0 of 4 complete");
    expect(
      screen.getByRole("button", {
        name: "Add a key or sign in to a coding agent, Not started",
      }),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Start a task, Not started" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", {
        name: "Add a secret if agents need one, Not started",
      }),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", {
        name: "Install Traycer on another computer, Not started",
      }),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Initial tour/ })).toBeNull();
    expect(
      screen.queryByRole("button", { name: /Agent selection/ }),
    ).toBeNull();
    expect(
      screen.queryByRole("button", { name: /Appearance and layout/ }),
    ).toBeNull();
    expect(
      screen.queryByRole("button", { name: /Browser sign-ins/ }),
    ).toBeNull();
    expect(screen.queryByRole("button", { name: /Add credits/ })).toBeNull();
    expect(screen.queryByTestId("set-up-personal")).toBeNull();
    expect(screen.queryByTestId("set-up-team-group")).toBeNull();
  });

  it("hides the credits step until a sandbox is staged in this window", () => {
    render(<GettingStartedSettingsPanel />);
    expect(screen.queryByTestId("getting-started-card-credits")).toBeNull();
    expect(screen.getByRole("status").textContent).toBe("0 of 4 complete");
  });

  it("shows the credits step once a sandbox is staged in this window", () => {
    mocks.staged = { target: { kind: "new" } };
    render(<GettingStartedSettingsPanel />);

    expect(
      screen.getByRole("button", { name: "Add credits, Not started" }),
    ).toBeTruthy();
    expect(screen.getByRole("status").textContent).toBe("0 of 5 complete");
    expect(
      screen.getByTestId("getting-started-card-credits").textContent,
    ).toContain("Credits pay for your sandboxes.");
  });

  it("completes a step by the fact it names, never by a click", () => {
    mocks.providers = [storedKeyProvider()];
    render(<GettingStartedSettingsPanel />);

    expect(screen.getByRole("status").textContent).toBe("1 of 4 complete");
    expect(
      screen.getByRole("button", {
        name: "Add a key or sign in to a coding agent, Complete",
      }),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Start a task, Not started" }),
    ).toBeTruthy();
  });

  it("hides the cards once every visible step is done", () => {
    mocks.providers = [storedKeyProvider()];
    mocks.tasks = [{ id: "task-1" }];
    mocks.secrets = [secret()];
    mocks.hosts = [personalHost("a"), personalHost("b")];
    render(<GettingStartedSettingsPanel />);

    expect(screen.queryByTestId("getting-started-card-provider")).toBeNull();
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("keeps the group open when a staged sandbox still needs credits", () => {
    mocks.providers = [storedKeyProvider()];
    mocks.tasks = [{ id: "task-1" }];
    mocks.secrets = [secret()];
    mocks.hosts = [personalHost("a"), personalHost("b")];
    mocks.staged = { target: { kind: "new" } };
    mocks.user = zeroUser();
    render(<GettingStartedSettingsPanel />);

    expect(screen.getByRole("status").textContent).toBe("4 of 5 complete");
    expect(
      screen.getByRole("button", { name: "Add credits, Not started" }),
    ).toBeTruthy();
  });

  it("opens Providers, Secrets, Credits, a new task, and the download page from the cards", () => {
    mocks.staged = { target: { kind: "new" } };
    render(<GettingStartedSettingsPanel />);

    fireEvent.click(screen.getByTestId("getting-started-card-provider"));
    expect(setSectionMock).toHaveBeenCalledWith("providers");

    fireEvent.click(screen.getByTestId("getting-started-card-secret"));
    expect(setSectionMock).toHaveBeenCalledWith("secrets");

    fireEvent.click(screen.getByTestId("getting-started-card-credits"));
    expect(setSectionMock).toHaveBeenCalledWith("credits");

    fireEvent.click(screen.getByTestId("getting-started-card-task"));
    expect(activateTabIntentMock).toHaveBeenCalledOnce();

    fireEvent.click(screen.getByTestId("getting-started-card-install"));
    expect(mocks.openLink).toHaveBeenCalledWith(
      "https://traycer.ai/download",
      "app",
      expect.objectContaining({ type: "click" }),
    );
  });

  it.each([
    ["secret", "secrets"],
    ["provider", "providers"],
  ])(
    "opens this window's own configuration from the %s card under a team pick",
    (card, section) => {
      useSettingsEnvironmentPickStore.setState({
        pick: { kind: "team", environmentId: "env-team" },
      });
      render(<GettingStartedSettingsPanel />);

      fireEvent.click(screen.getByTestId(`getting-started-card-${card}`));

      expect(useSettingsEnvironmentPickStore.getState().pick).toBeNull();
      expect(setSectionMock).toHaveBeenCalledWith(section);
    },
  );

  it("marks credits complete once the balance is above zero", () => {
    mocks.staged = { target: { kind: "new" } };
    mocks.user = positiveUser();
    render(<GettingStartedSettingsPanel />);

    expect(
      screen.getByRole("button", { name: "Add credits, Complete" }),
    ).toBeTruthy();
  });
});
