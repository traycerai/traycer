import type { AuthenticatedUser } from "@traycer/protocol/auth";
import type { EnvironmentSecretV12 } from "@traycer/protocol/host/environment-schemas";
import type { RunningHost } from "@/components/settings/environment/hosts-running-configuration-model";
import type { ProviderCliState } from "@traycer/protocol/host/provider-schemas";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
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
import {
  personalHostScopeOverrides,
  pickerDefaultPick,
  resetEnvironmentSectionReads,
  windowHostRunsPersonal,
} from "@/components/settings/__tests__/environment-section-reads-fixture";
import { hostScopeOptionFixture } from "@/components/settings/host-scope/host-scope-fixture";
import {
  PERSONAL_PICK,
  UNRESOLVED_PICK,
} from "@/lib/settings-environment-pages";
import { useSelectionAuthorityStore } from "@/stores/host/selection-authority-store";
import { useSettingsEnvironmentPickStore } from "@/stores/settings/settings-environment-pick-store";
import {
  mountTeamPage,
  personalPoolSource,
  resetTeamPageHarness,
} from "@/components/settings/environment/__tests__/team-configuration-test-support";
import {
  RETIRED_PROVIDER_VARIABLES,
  RETIRED_SECRET_ROW_FIELDS,
} from "@traycer/protocol/host/released-wire-rows";

const mocks = vi.hoisted(() => ({
  providers: [] as ProviderCliState[],
  secrets: [] as EnvironmentSecretV12[],
  tasks: [] as readonly { readonly id: string }[],
  hosts: [] as RunningHost[],
  user: null as AuthenticatedUser | null,
  staged: null as { readonly target: { readonly kind: string } } | null,
  /** Whether the window's host serves `environment.secrets.list`. */
  hostServesSecrets: true,
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
  useHostQuery: () => ({
    data: { principal: { kind: "personal" } },
    isError: false,
    refetch: () => Promise.resolve(),
  }),
}));

vi.mock("@/hooks/host/use-host-supports-method", () => ({
  useHostMethodSupport: () => mocks.hostServesSecrets,
}));

vi.mock("@/hooks/host/use-requester-host-id", () => ({
  useRequesterHostId: () => "host-1",
}));

// This computer and where its settings stand: the move card's own boundary,
// faked here so these cases stay about the cards. The move card has its own
// suite (`panels/__tests__/getting-started-settings-panel.test.tsx`).
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

vi.mock("@/hooks/chats/use-cloud-chat-queries", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/hooks/chats/use-cloud-chat-queries")
  >()),
  useCloudChatViewerId: () => "user-me",
}));

vi.mock("@/providers/use-runner-host", () => ({
  useRunnerHostOrNull: () => ({ signInUrl: "https://traycer.ai/sign-in" }),
}));

// The card is judged on the default pick's page, which reads the window's host
// through one scope and whether it runs Personal: the shared fixtures answer
// both, so these cases stay about the cards.
vi.mock(
  "@/components/settings/host-scope/use-host-scope",
  async () =>
    (
      await import("@/components/settings/__tests__/environment-section-reads-fixture")
    ).personalHostScopeModule,
);
vi.mock(
  "@/components/settings/personal/use-window-host-runs-personal",
  async () =>
    (
      await import("@/components/settings/__tests__/environment-section-reads-fixture")
    ).windowHostRunsPersonalModule,
);

// The default pick comes from the window's computers: the shared fixture
// resolves what a test sets as `pickerDefaultPick`, as the host's answers
// would.
vi.mock(
  "@/components/settings/environment/use-environment-status-model",
  async () =>
    (
      await import("@/components/settings/__tests__/environment-section-reads-fixture")
    ).environmentStatusModelModule,
);

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
    ...RETIRED_SECRET_ROW_FIELDS,
    providerVariables: [...RETIRED_PROVIDER_VARIABLES],
    secretId: "secret-1",
    name: "DEPLOY_KEY",
    kind: "api_key",
    protocol: null,
    destinations: [],
    currentVersionId: "v1",
    revoked: false,
    updatedAt: 1,
    variables: [],
  };
}

function personalHost(hostId: string): RunningHost {
  return {
    hostId,
    hostName: hostId,
    name: hostId,
    kind: "personal",
    isThisComputer: false,
  };
}

function renderHomeSection() {
  const harness = mountTeamPage(personalPoolSource(), {
    "environment.host.list": () => ({ hosts: [] }),
    "environment.list": () => ({
      environments: [
        {
          environmentId: "env-personal",
          ownerKind: "user",
          ownerId: "user-me",
          roomId: "room-personal",
          label: "Personal",
          effectiveRole: "owner",
          kind: "personal",
          hostCount: 1,
          providerHandle: null,
        },
      ],
    }),
    "environment.secrets.list": () => ({
      secrets: mocks.secrets,
      removed: [],
    }),
  });
  const element = () => (
    <harness.Wrapper>
      <HomeGettingStartedSection />
    </harness.Wrapper>
  );
  const view = render(element());
  return {
    ...view,
    /** Reads the fixtures again, as a host answering or going away would. */
    refresh: () => view.rerender(element()),
  };
}

/** The window moves to another computer: the authority and the scope follow. */
function moveWindowHostTo(hostId: string): void {
  useSelectionAuthorityStore.setState({ effectiveHostId: hostId });
  personalHostScopeOverrides.current = {
    host: hostScopeOptionFixture({ hostId }),
  };
}

function secretCard(): HTMLElement | null {
  return screen.queryByTestId("getting-started-card-secret");
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
    mocks.hostServesSecrets = true;
    moveWindowHostTo("host-a");
    pickerDefaultPick.current = PERSONAL_PICK;
    // From the store's initial state, so no case inherits the Secrets card's
    // decision another made.
    useSettingsEnvironmentPickStore.setState({
      ...useSettingsEnvironmentPickStore.getInitialState(),
      defaultPick: PERSONAL_PICK,
      defaultHostId: "host-a",
    });
    mocks.openLink.mockClear();
    navigateMock.mockReset();
    setSectionMock.mockReset();
    openSettingsMock.mockReset();
  });

  afterEach(() => {
    cleanup();
    resetTeamPageHarness();
    resetEnvironmentSectionReads();
    useSelectionAuthorityStore.getState().reset();
  });

  it("renders open with the heading, the count, and the cards as buttons while steps are incomplete", () => {
    renderHomeSection();

    expect(
      screen.getByRole("heading", { name: "Getting started" }),
    ).toBeTruthy();
    expect(screen.getByText("0 of 4 complete")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Start a task, Not started" }),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Add credits/ })).toBeNull();
    expect(screen.queryByTestId("set-up-team-group")).toBeNull();
  });

  it("carries no settings-only markers on the home cards", () => {
    const { container } = renderHomeSection();

    expect(container.querySelector("[data-settings-anchor]")).toBeNull();
  });

  it("opens Providers from the provider card", () => {
    renderHomeSection();

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

  it("hides the section once every visible step is done", async () => {
    mocks.providers = [storedKeyProvider()];
    mocks.tasks = [{ id: "task-1" }];
    mocks.secrets = [secret()];
    mocks.hosts = [personalHost("a"), personalHost("b")];
    renderHomeSection();

    await waitFor(() => {
      expect(screen.queryByTestId("home-getting-started")).toBeNull();
    });
  });

  it("stays visible when a staged sandbox still needs credits", async () => {
    mocks.providers = [storedKeyProvider()];
    mocks.tasks = [{ id: "task-1" }];
    mocks.secrets = [secret()];
    mocks.hosts = [personalHost("a"), personalHost("b")];
    mocks.staged = { target: { kind: "new" } };
    renderHomeSection();

    expect(screen.getByTestId("home-getting-started")).toBeTruthy();
    await waitFor(() => {
      expect(screen.getByText("4 of 5 complete")).toBeTruthy();
    });
    expect(
      screen.getByRole("button", { name: "Add credits, Not started" }),
    ).toBeTruthy();
  });

  it("resolves the window's default on a cold Home, so the Secrets step shows once the host is ready", async () => {
    mocks.providers = [storedKeyProvider()];
    mocks.tasks = [{ id: "task-1" }];
    mocks.hosts = [personalHost("a"), personalHost("b")];
    useSettingsEnvironmentPickStore.setState({
      defaultPick: UNRESOLVED_PICK,
      defaultHostId: null,
    });
    pickerDefaultPick.current = UNRESOLVED_PICK;
    const home = renderHomeSection();
    expect(secretCard()).toBeNull();

    pickerDefaultPick.current = PERSONAL_PICK;
    home.refresh();

    await waitFor(() => {
      expect(secretCard()).not.toBeNull();
    });
    expect(screen.getByText("3 of 4 complete")).toBeTruthy();
  });

  describe("the Secrets step, once decided for a window host", () => {
    it("stays after the host goes away and comes back lacking Secrets, and the next host decides again", async () => {
      windowHostRunsPersonal.current = false;
      const home = renderHomeSection();
      await waitFor(() => {
        expect(secretCard()).not.toBeNull();
      });

      windowHostRunsPersonal.current = true;
      mocks.hostServesSecrets = false;
      home.refresh();

      expect(secretCard()).not.toBeNull();

      moveWindowHostTo("host-b");
      home.refresh();

      await waitFor(() => {
        expect(secretCard()).toBeNull();
      });
    });

    it("stays absent after the host goes away and the cloud road serves Secrets", () => {
      windowHostRunsPersonal.current = true;
      mocks.hostServesSecrets = false;
      const home = renderHomeSection();
      expect(secretCard()).toBeNull();

      windowHostRunsPersonal.current = false;
      home.refresh();

      expect(secretCard()).toBeNull();
    });
  });
});
