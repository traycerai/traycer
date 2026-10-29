import type { AuthenticatedUser } from "@traycer/protocol/auth";
import type { EnvironmentSecretV12 } from "@traycer/protocol/host/environment-schemas";
import type { RunningHost } from "@/components/settings/environment/hosts-running-configuration-model";
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
import { HomeGettingStartedSection } from "@/components/home-focus/home-getting-started-section";

const mocks = vi.hoisted(() => ({
  providers: [] as ProviderCliState[],
  secrets: [] as EnvironmentSecretV12[],
  tasks: [] as readonly { readonly id: string }[],
  hosts: [] as RunningHost[],
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

// This computer and where its settings stand: the move card's own boundary,
// faked here so these cases stay about the cards. The move card has its own
// suite (`getting-started-move-card.test.tsx`).
vi.mock("@/components/settings/move/this-computer", () => ({
  useThisComputer: () => ({
    hostId: null,
    hostName: "this computer",
    client: null,
  }),
}));
vi.mock("@/components/settings/move/use-this-computers-move", () => ({
  useThisComputersMove: () => "unknown",
}));

vi.mock("@/hooks/epics/use-cloud-epic-tasks-query", () => ({
  useCloudEpicTasksQuery: () => ({ tasks: mocks.tasks }),
}));

// The computers Personal reaches come from one hook, not the account registry.
vi.mock(
  "@/components/settings/environment/use-hosts-running-configuration",
  () => ({
    useHostsRunningPersonal: () => ({
      hosts: mocks.hosts,
      state: "ready",
      collisions: [],
      retry: () => undefined,
    }),
  }),
);

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
const setSectionMock = vi.hoisted(() => vi.fn());
const openSettingsMock = vi.hoisted(() => vi.fn());

vi.mock("@tanstack/react-router", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@tanstack/react-router")>();
  return { ...actual, useNavigate: () => navigateMock };
});

vi.mock("@/stores/tabs/system-tab-modal-bridge", () => ({
  getSystemTabModalApi: () => ({
    isOverlayActive: () => false,
    setSection: setSectionMock,
    openSettings: openSettingsMock,
  }),
}));

function storedKeyProvider(): ProviderCliState {
  return {
    ...provider("claude-code", [profile("work", "managed")]),
    apiKey: { supported: true, configured: true, source: "stored" },
  };
}

function secret(): EnvironmentSecretV12 {
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
    variables: [],
    providerVariables: [],
  };
}

function personalHost(hostId: string): RunningHost {
  return {
    hostId,
    hostName: hostId,
    name: hostId,
    kind: "personal",
    isThisComputer: false,
    lastReportedAt: null,
    applied: [],
  };
}

describe("HomeGettingStartedSection", () => {
  beforeEach(() => {
    mocks.providers = [];
    mocks.secrets = [];
    mocks.tasks = [];
    mocks.hosts = [];
    mocks.user = userWith(
      userSubscription({
        totalPlanCredits: 0,
        consumedFromPlan: 0,
        bonusCredits: 0,
        consumedFromBonus: 0,
        bundleRemaining: 0,
      }),
      [],
    );
    mocks.staged = null;
    mocks.openLink.mockClear();
    navigateMock.mockReset();
    setSectionMock.mockReset();
    openSettingsMock.mockReset();
  });

  afterEach(() => {
    cleanup();
  });

  it("renders open with the heading, the count, and the cards as buttons while steps are incomplete", () => {
    render(<HomeGettingStartedSection />);

    expect(
      screen.getByRole("heading", { name: "Getting started" }),
    ).toBeTruthy();
    expect(screen.getByText("0 of 4 complete")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Start a task, Not started" }),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Add credits/ })).toBeNull();
    expect(screen.queryByTestId("set-up-personal")).toBeNull();
    expect(screen.queryByTestId("set-up-team-group")).toBeNull();
  });

  it("carries no settings-only markers on the home cards", () => {
    const { container } = render(<HomeGettingStartedSection />);

    expect(container.querySelector("[data-settings-anchor]")).toBeNull();
  });

  it("opens Providers from the provider card", () => {
    render(<HomeGettingStartedSection />);

    fireEvent.click(screen.getByTestId("getting-started-card-provider"));

    expect(setSectionMock).not.toHaveBeenCalled();
    expect(openSettingsMock).toHaveBeenCalledWith({
      section: "providers",
      resetToGeneral: false,
      tab: null,
      draft: null,
      hostId: null,
    });
  });

  it("hides the section once every visible step is done", () => {
    mocks.providers = [storedKeyProvider()];
    mocks.tasks = [{ id: "task-1" }];
    mocks.secrets = [secret()];
    mocks.hosts = [personalHost("a"), personalHost("b")];
    render(<HomeGettingStartedSection />);

    expect(screen.queryByTestId("home-getting-started")).toBeNull();
  });

  it("stays visible when a staged sandbox still needs credits", () => {
    mocks.providers = [storedKeyProvider()];
    mocks.tasks = [{ id: "task-1" }];
    mocks.secrets = [secret()];
    mocks.hosts = [personalHost("a"), personalHost("b")];
    mocks.staged = { target: { kind: "new" } };
    render(<HomeGettingStartedSection />);

    expect(screen.getByTestId("home-getting-started")).toBeTruthy();
    expect(screen.getByText("4 of 5 complete")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Add credits, Not started" }),
    ).toBeTruthy();
  });
});
