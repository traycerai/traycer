import { useSandboxDetailsStore } from "@/stores/sandboxes/sandbox-details-store";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import type {
  EnvironmentConfigurationItem,
  EnvironmentConfigurationItemWriteResponse,
} from "@traycer/protocol/host/environment/configuration-contracts";
import type { EnvironmentDescriptorV11 } from "@traycer/protocol/host/environment/contracts";
import {
  recordNegotiatedHostMethods,
  recordNegotiatedHostManifest,
  resetNegotiatedManifests,
} from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";
import {
  configurationItem,
  mountTeamPage,
  poolSource,
  requireTeamHostClient,
  resetTeamPageHarness,
  type TeamPageHarness,
} from "@/components/settings/environment/__tests__/team-configuration-test-support";
import userEvent from "@testing-library/user-event";
import { frozenDestroyAt } from "@/lib/sandboxes/sandbox-balance";
import type { ReactElement } from "react";
import type {
  SandboxVerbFetchResult,
  SandboxListFetchResult,
} from "@traycer-clients/shared/host-client/sandbox-control";
import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import type { RemoteHostDirectoryEntry } from "@traycer-clients/shared/host-client/remote-fetcher";
import {
  createFakeSandboxBinding,
  refusal,
  type FakeSandboxBinding,
} from "@/hooks/sandboxes/__tests__/sandbox-binding-fixture";
import { sandboxHostEntry } from "@/lib/sandboxes/__tests__/sandbox-host-directory-fixture";
import { SANDBOX_FIRST_BOOT_FAILURE_COPIES } from "@/lib/sandboxes/__tests__/sandbox-first-boot-failure-copies";
import {
  authQueryKeys,
  sandboxMutationKeys,
  sandboxQueryKeys,
} from "@/lib/query-keys";
import type {
  SandboxAutomationResponse,
  SandboxCatalogue,
  SandboxSummary,
  UserSandboxCost,
} from "@traycer/protocol/host/sandbox-control";
import type { SandboxAutomationOpened } from "@/hooks/sandboxes/use-sandbox-automation-open-mutation";
import type { SandboxSessionReport } from "@/lib/sandboxes/sandbox-row-lines";
import { useAuthStore } from "@/stores/auth/auth-store";
import { useLandingPanelStore } from "@/stores/home/landing-panel-store";
import { useSurfaceHostSelectionStore } from "@/stores/host/surface-host-selection-store";
import {
  agentSessionFixture,
  liveSessionReport,
  sandboxOperationFixture,
  sandboxSummaryFixture,
  terminalSessionFixture,
} from "@/hooks/sandboxes/__tests__/sandbox-fixtures";
import {
  formatSandboxDate,
  sandboxRowActionLabel,
  sandboxRowActions,
  type SandboxPageConfiguration,
} from "@/lib/sandboxes/sandbox-row-lines";
import {
  KEPT_UNTIL_YOU_DESTROY_IT,
  SANDBOXES_CANT_BE_CREATED,
} from "@/lib/sandboxes/sandbox-strings";
import { useSandboxShapeMemoryStore } from "@/stores/composer/sandbox-shape-memory-store";

const CATALOGUE: SandboxCatalogue = {
  providers: [
    {
      provider: "tensorlake",
      os: ["linux"],
      shape: {
        cpuMin: 1,
        cpuMax: 16,
        cpuStep: 1,
        memoryPerCpuMinMb: 1024,
        memoryPerCpuMaxMb: 8192,
        memoryMinMb: 1024,
        memoryMaxMb: 65536,
        memoryStepMb: 512,
        diskMinMb: 10240,
        diskMaxMb: 102400,
        diskDefaultMb: 20480,
      },
      suspendFidelity: "memory",
      stoppedStorage: "snapshot",
      wakeClass: "resume",
      shapes: null,
      dockerInGuest: true,
      creatable: true,
      notCreatableReason: null,
      regions: [
        {
          id: "us-east",
          label: "US East",
          fromPriceMcPerHour: { awakeMc: 120, suspendedMc: 4, stoppedMc: 2 },
          pricing: null,
        },
      ],
    },
  ],
};

/** The provider lists two shapes, so a team can default to the larger. */
const LISTED_CATALOGUE: SandboxCatalogue = {
  providers: CATALOGUE.providers.map((provider) => ({
    ...provider,
    shapes: [
      { cpus: 2, memoryMb: 4096, diskMb: 20_480, default: true },
      { cpus: 4, memoryMb: 8192, diskMb: 40_960, default: false },
    ],
  })),
};

const mocks = vi.hoisted(() => ({
  binding: null as FakeSandboxBinding | null,
  entry: null as HostDirectoryEntry | null,
  sandboxes: [] as readonly SandboxSummary[],
  settingsItems: [] as readonly {
    readonly kind: string;
    readonly status: string;
  }[],
  /** `false` while the list query has not answered. */
  listed: true,
  realActions: false,
  /** The Automations read and open run through their real hooks and query. */
  realAutomation: false,
  configurations: [{ kind: "personal" }] as SandboxPageConfiguration[],
  catalogue: null as SandboxCatalogue | null,
  report: { kind: "unknown" } as SandboxSessionReport,
  sessionFailed: false,
  resumePending: false,
  realSessions: false,
  costs: null as UserSandboxCost | null,
  /** `GET /api/sandboxes/automation`; `null` while it has not answered. */
  automation: null as SandboxAutomationResponse | null,
  openAutomation: vi.fn<() => Promise<SandboxAutomationOpened>>(),
  openLink: vi.fn<(url: string, kind: string, event: null) => void>(),
  close: vi.fn(),
}));

vi.mock("@/lib/host", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/host")>()),
  useHostClient: () => requireTeamHostClient(),
  useHostBinding: () => mocks.binding,
}));
vi.mock("@/lib/host/runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/host/runtime")>()),
  useHostClient: () => requireTeamHostClient(),
}));
vi.mock("@/hooks/chats/use-cloud-chat-queries", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/hooks/chats/use-cloud-chat-queries")
  >()),
  useCloudChatViewerId: () => "user-me",
}));

/** The router's commit boundary: every navigation the page asks for. */
const navigations = vi.hoisted(() => [] as object[]);
vi.mock("@tanstack/react-router", () => ({
  useRouter: () => null,
  useNavigate: () => (options: object) => {
    navigations.push(options);
    return new Promise<void>(() => undefined);
  },
}));
vi.mock(
  "@/hooks/sandboxes/use-sandbox-configurations",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("@/hooks/sandboxes/use-sandbox-configurations")
    >()),
    useSandboxConfigurations: () => ({
      configurations: mocks.configurations,
      teamEnvironmentIds: new Set(
        mocks.configurations.flatMap((configuration) =>
          configuration.kind === "team" && configuration.environmentId !== null
            ? [configuration.environmentId]
            : [],
        ),
      ),
      complete: true,
    }),
    useSandboxWakeString: () => null,
  }),
);
vi.mock("@/hooks/sandboxes/use-sandbox-list-query", async (importOriginal) => {
  const original =
    await importOriginal<
      typeof import("@/hooks/sandboxes/use-sandbox-list-query")
    >();
  return {
    ...original,
    useSandboxList: () => {
      const query = original.useSandboxList();
      return mocks.binding === null
        ? {
            ...query,
            data: mocks.listed ? { sandboxes: mocks.sandboxes } : undefined,
            isError: false,
            isFetching: false,
            refetch: vi.fn(),
          }
        : query;
    },
  };
});
vi.mock("@/hooks/sandboxes/use-sandbox-settings-status", () => ({
  useSandboxSettingsStatus: () => ({ data: { items: mocks.settingsItems } }),
}));
vi.mock("@/hooks/sandboxes/use-sandbox-costs-query", () => ({
  useSandboxCosts: () => ({ data: mocks.costs }),
}));
vi.mock("@/hooks/sandboxes/use-refresh-sandbox-costs", () => ({
  useRefreshSandboxCosts: () => undefined,
}));
vi.mock("@/hooks/sandboxes/use-sandbox-catalogue-query", () => ({
  useSandboxCatalogue: () => ({ data: mocks.catalogue }),
}));
vi.mock("@/hooks/host/use-composer-surface-host-pin", () => ({
  useComposerSurfaceHostKey: () => "landing:window-test",
}));
vi.mock("@/hooks/host/use-effective-host-id", () => ({
  useEffectiveHostId: () => "laptop",
}));
vi.mock("@/hooks/host/use-host-client-for-host-id", () => ({
  useHostClientForHostId: () =>
    mocks.realSessions ? requireTeamHostClient() : null,
}));
vi.mock("@/hooks/host/use-host-directory-entry", () => ({
  useHostDirectoryEntry: () => mocks.entry,
}));
vi.mock("@/hooks/sandboxes/use-sandbox-control-unavailable-reason", () => ({
  useSandboxControlUnavailableReason: () => null,
}));
vi.mock(
  "@/hooks/sandboxes/use-sandbox-session-report",
  async (importOriginal) => {
    const original =
      await importOriginal<
        typeof import("@/hooks/sandboxes/use-sandbox-session-report")
      >();
    return {
      useSandboxSessionReport: () => ({
        report: mocks.report,
        failed: mocks.sessionFailed,
      }),
      useSandboxRowSessionReport: (summary: SandboxSummary) => {
        const real = original.useSandboxRowSessionReport(summary);
        return mocks.realSessions
          ? real
          : {
              report: mocks.report,
              failed: mocks.sessionFailed,
              resumePending: mocks.resumePending,
            };
      },
    };
  },
);
vi.mock(
  "@/hooks/sandboxes/use-sandbox-automation-query",
  async (importOriginal) => {
    const original =
      await importOriginal<
        typeof import("@/hooks/sandboxes/use-sandbox-automation-query")
      >();
    return {
      ...original,
      useSandboxAutomation: (environmentId: string | null) => {
        const real = original.useSandboxAutomation(environmentId);
        return mocks.realAutomation ? real : { data: mocks.automation };
      },
      useSandboxTeamPods: (environmentIds: readonly string[]) => {
        const real = original.useSandboxTeamPods(environmentIds);
        return mocks.realAutomation ? real : new Map();
      },
    };
  },
);
vi.mock(
  "@/hooks/sandboxes/use-sandbox-automation-open-mutation",
  async (importOriginal) => {
    const original =
      await importOriginal<
        typeof import("@/hooks/sandboxes/use-sandbox-automation-open-mutation")
      >();
    return {
      ...original,
      useSandboxAutomationOpen: (feedback: "toast" | "inline") => {
        const real = original.useSandboxAutomationOpen(feedback);
        return mocks.realAutomation
          ? real
          : {
              mutateAsync: mocks.openAutomation,
              mutate: vi.fn(),
              isPending: false,
              isError: false,
              reset: vi.fn(),
            };
      },
    };
  },
);

vi.mock("@/providers/use-runner-host", () => ({
  useRunnerHost: () => ({ signInUrl: "https://platform.example.dev/sign-in" }),
  useRunnerHostOrNull: () => ({
    signInUrl: "https://platform.example.dev/sign-in",
  }),
}));
vi.mock("@/lib/links/open-link", () => ({
  useOpenLink: () => mocks.openLink,
}));
vi.mock("@/stores/tabs/use-system-tab-modal", () => ({
  useSystemTabModalActions: () => ({
    close: mocks.close,
    openSettings: vi.fn(),
  }),
}));
vi.mock("@/components/composer/use-staged-sandbox-send", () => ({
  useStagedSandboxRunner: () => vi.fn(),
  startStagedTerminal: vi.fn(),
}));
vi.mock("@/lib/host/fleet-refresh", () => ({ requestFleetRefresh: vi.fn() }));
vi.mock("@/lib/auth-error-toast", () => ({ toastFromAuthError: vi.fn() }));

// The actions have their own verbs and dialogs; the page's contract is which
// primary action each row offers, so the stub renders the model's own pick.
vi.mock(
  "@/components/settings/panels/sandbox-row-actions",
  async (importOriginal) => {
    const original =
      await importOriginal<
        typeof import("@/components/settings/panels/sandbox-row-actions")
      >();
    return {
      ...original,
      SandboxRowActions: (props: {
        summary: SandboxSummary;
        configuration: SandboxPageConfiguration;
        unreachable: boolean;
        frozenNeedsOwnCredits: boolean;
        settingsFailed: boolean;
      }) => {
        if (mocks.realActions) return <original.SandboxRowActions {...props} />;
        const { primary } = sandboxRowActions(props);
        return (
          <span data-testid="row-primary">
            {primary === null ? "" : sandboxRowActionLabel(primary)}
          </span>
        );
      },
    };
  },
);

import { SandboxesSettingsPanel } from "@/components/settings/panels/sandboxes-settings-panel";
import { useSandboxDefaultsLookup } from "@/hooks/sandboxes/use-sandbox-defaults";
import { useSandboxesPageStore } from "@/stores/sandboxes/sandboxes-page-store";
import { __resetTabNavigationControllerForTesting } from "@/lib/tab-navigation";
import {
  __resetTabSyncCoordinatorForTesting,
  installTabSyncCoordinator,
} from "@/lib/tab-sync/tab-sync-coordinator";
import { useLandingDraftStore } from "@/stores/home/landing-draft-store";
import { tabItemId } from "@/stores/tabs/layout";
import { useTabsStore } from "@/stores/tabs/store";
import type { TabRef } from "@/stores/tabs/types";
import { PERSONAL_PICK } from "@/lib/settings-environment-pages";
import { useSettingsEnvironmentPickStore } from "@/stores/settings/settings-environment-pick-store";
import {
  readStagedSandbox,
  useStagedSandboxStore,
} from "@/stores/composer/staged-sandbox-store";

const SETTINGS_REF: TabRef = { kind: "settings", id: "settings" };

/** A window whose tab strip holds Settings as its selected tab. */
async function withSettingsTabSelected(): Promise<void> {
  navigations.length = 0;
  useLandingDraftStore.setState({ drafts: [], activeDraftId: null });
  __resetTabSyncCoordinatorForTesting();
  __resetTabNavigationControllerForTesting();
  useTabsStore.setState({
    version: 2,
    items: [{ kind: "tab", id: tabItemId(SETTINGS_REF), ref: SETTINGS_REF }],
    activeItemId: tabItemId(SETTINGS_REF),
    stripOrder: [SETTINGS_REF],
    systemTabs: {
      history: null,
      settings: {
        id: "settings",
        kind: "settings",
        name: "Settings",
        lastPath: "/settings/sandboxes",
      },
    },
  });
  installTabSyncCoordinator({ readyPromise: Promise.resolve() });
  await Promise.resolve();
  await Promise.resolve();
}

function row(id: string, overrides: Partial<SandboxSummary>): SandboxSummary {
  return sandboxSummaryFixture({
    id,
    hostId: `host-${id}`,
    displayName: id,
    ...overrides,
  });
}

const PERSONAL_ENV = "env-personal";
const TEAM_ENV = "env-acme";

function descriptor(
  environmentId: string,
  ownerKind: "user" | "organization",
  ownerId: string,
  effectiveRole: "owner" | "admin" | "editor" | "viewer",
): EnvironmentDescriptorV11 {
  return {
    environmentId,
    ownerKind,
    ownerId,
    roomId: `room-${environmentId}`,
    label: ownerId,
    effectiveRole,
    kind: ownerKind === "user" ? "personal" : "team",
    hostCount: 0,
    providerHandle: `handle-${environmentId}`,
  };
}

/** What the host answers for the account's environments, item rows and rosters. */
const host = {
  status: vi.fn(() => new Promise<never>(() => undefined)),
  environments: [] as EnvironmentDescriptorV11[],
  items: {} as Record<string, EnvironmentConfigurationItem[]>,
  members: [] as Array<{
    readonly userId: string;
    readonly displayName: string | null;
    readonly effectiveRole: "admin" | "editor" | "viewer";
    readonly inviteState: "accepted" | "pending";
  }>,
  put: null as
    | null
    | (() =>
        | EnvironmentConfigurationItemWriteResponse
        | Promise<EnvironmentConfigurationItemWriteResponse>),
};
let harness: TeamPageHarness | null = null;

const SANDBOX_DEFAULTS_VALUE = {
  os: "linux",
  cpus: 4,
  memoryMb: 8192,
  diskMb: 40_960,
  idleMinutes: 45,
  restingMinutes: null,
};

function defaultsItem(
  value: EnvironmentConfigurationItem["value"],
  revision: number,
): EnvironmentConfigurationItem {
  return configurationItem({
    kind: "sandbox_defaults",
    key: "sandbox",
    value,
    revision,
  });
}

function hostPage(): TeamPageHarness {
  harness = mountTeamPage(poolSource("owner"), {
    "host.status": host.status,
    "environment.list": () => ({ environments: host.environments }),
    "environment.configuration.items": (params) => ({
      items: host.items[params.environmentId] ?? [],
    }),
    "environment.members": () => ({
      members: host.members.map((member) => ({
        ...member,
        avatarUrl: null,
        linkedPlan: false,
        invitedAddress: null,
        email: null,
      })),
      nextCursor: null,
      legacyRoleNoticeSeenAt: null,
      legacyMembers: [],
    }),
    "environment.configuration.items.put": () =>
      host.put === null ? { outcome: "saved", revision: 1 } : host.put(),
  });
  return harness;
}

function renderUi(ui: ReactElement) {
  const page = harness ?? hostPage();
  return render(ui, { wrapper: page.Wrapper });
}

function renderPanel(sandboxes: readonly SandboxSummary[]): void {
  mocks.sandboxes = sandboxes;
  renderUi(<SandboxesSettingsPanel />);
}

function rowOf(id: string): HTMLElement {
  const found = screen
    .getAllByTestId("sandboxes-row")
    .find((candidate) => candidate.getAttribute("data-sandbox-row") === id);
  if (found === undefined) throw new Error(`no row ${id}`);
  return found;
}

function names(): string[] {
  return screen
    .queryAllByTestId("sandboxes-row-name")
    .map((node) => node.textContent);
}

describe("<SandboxesSettingsPanel />", () => {
  beforeEach(() => {
    mocks.binding = null;
    mocks.entry = null;
    resetNegotiatedManifests();
    recordNegotiatedHostMethods("auto-host", ["terminal.plain.create"]);
    useAuthStore.setState({ status: "signed-out", contextMetadata: null });
    mocks.sandboxes = [];
    mocks.settingsItems = [];
    mocks.listed = true;
    mocks.realActions = false;
    mocks.configurations = [{ kind: "personal" }];
    mocks.catalogue = null;
    mocks.report = { kind: "unknown" };
    mocks.sessionFailed = false;
    mocks.resumePending = false;
    mocks.realSessions = false;
    host.status.mockClear();
    mocks.costs = null;
    mocks.automation = null;
    mocks.realAutomation = false;
    mocks.openAutomation.mockReset();
    mocks.openLink.mockReset();
    mocks.close.mockReset();
    useLandingPanelStore.getState().resetForTests();
    useSurfaceHostSelectionStore.setState({ selections: {} });
    host.environments = [descriptor(PERSONAL_ENV, "user", "u1", "owner")];
    host.items = {};
    host.members = [];
    host.put = null;
    harness = null;
    useSandboxesPageStore.setState({
      requestedConfiguration: null,
    });
    useSettingsEnvironmentPickStore.setState({
      pick: null,
      defaultPick: PERSONAL_PICK,
    });
    useSandboxShapeMemoryStore.setState({
      byHost: {},
      lastConfigurationByHost: {},
    });
  });

  it("shows Shape, Idle and Destruction as ellipses while the catalogue has not answered", () => {
    renderPanel([]);
    expect(screen.getByTestId("sandboxes-defaults-shape").textContent).toBe(
      "Shape · …",
    );
    expect(screen.getByTestId("sandboxes-defaults-idle").textContent).toBe(
      "Idle · …",
    );
    expect(screen.getByTestId("sandboxes-defaults-resting").textContent).toBe(
      "Destruction · …",
    );
    expect(screen.queryByText("Loading defaults…")).toBeNull();
    expect(
      screen.getByText(
        "Every sandbox running on your settings and what each one costs. Start one from a task's host picker.",
      ),
    ).toBeTruthy();
    expect(
      screen.queryByRole("heading", { name: "Your sandboxes" }),
    ).toBeNull();
  });

  it("says sandboxes can't be created once the catalogue answers with no shape", async () => {
    mocks.catalogue = { providers: [] };
    host.environments = [descriptor(PERSONAL_ENV, "user", "u1", "viewer")];
    renderPanel([]);
    await waitFor(() => {
      expect(screen.getByTestId("sandboxes-defaults-shape").textContent).toBe(
        `Shape · ${SANDBOXES_CANT_BE_CREATED}`,
      );
    });
    expect(screen.getByTestId("sandboxes-defaults-idle").textContent).toBe(
      "Idle · …",
    );
    expect(screen.getByTestId("sandboxes-defaults-resting").textContent).toBe(
      "Destruction · …",
    );
  });

  describe("the defaults card", () => {
    const TEAM = {
      kind: "team",
      teamId: "team-1",
      teamName: "Acme",
      environmentId: TEAM_ENV,
    } as const;

    function viewTeamAs(
      role: "owner" | "admin" | "editor" | "viewer",
      remembered: { cpus: number; memoryMb: number; idleMinutes: number },
    ): void {
      mocks.catalogue = LISTED_CATALOGUE;
      mocks.configurations = [{ kind: "personal" }, TEAM];
      host.environments = [
        descriptor(PERSONAL_ENV, "user", "u1", "owner"),
        descriptor(TEAM_ENV, "organization", "team-1", role),
      ];
      host.items = { [TEAM_ENV]: [defaultsItem(SANDBOX_DEFAULTS_VALUE, 3)] };
      useSettingsEnvironmentPickStore.setState({
        pick: { kind: "team", environmentId: TEAM_ENV },
      });
      useSandboxShapeMemoryStore.getState().remember("laptop", "team-1", {
        os: "linux",
        cpus: remembered.cpus,
        memoryMb: remembered.memoryMb,
        diskMb: null,
        region: "us-east",
        idleMinutes: remembered.idleMinutes,
        destroyAfterRestingMinutes: 120,
      });
    }

    it("shows every member the team's item, whatever each remembered from their own gear", async () => {
      const seen: string[] = [];
      for (const remembered of [
        { cpus: 8, memoryMb: 16_384, idleMinutes: 90 },
        { cpus: 1, memoryMb: 1024, idleMinutes: 5 },
      ]) {
        resetTeamPageHarness();
        harness = null;
        viewTeamAs("viewer", remembered);
        renderPanel([]);
        await waitFor(() => {
          expect(
            screen.getByTestId("sandboxes-defaults-summary").textContent,
          ).toContain("4 vCPU");
        });
        seen.push(screen.getByTestId("sandboxes-defaults-summary").textContent);
        cleanup();
      }

      expect(seen[0]).toBe(seen[1]);
      expect(seen[0]).toContain(
        "Shape · Linux · 4 vCPU · 8 GB · from $0.12/h · Suspend keeps memory",
      );
      expect(seen[0]).toContain("Idle · 45 minutes");
      expect(seen[0]).toContain(`Destruction · ${KEPT_UNTIL_YOU_DESTROY_IT}`);
    });

    it("shows the spec's defaults when the configuration has no item", async () => {
      mocks.catalogue = CATALOGUE;
      host.environments = [descriptor(PERSONAL_ENV, "user", "u1", "viewer")];
      useSandboxShapeMemoryStore.getState().remember("laptop", "personal", {
        os: "linux",
        cpus: 4,
        memoryMb: 8192,
        diskMb: null,
        region: "us-east",
        idleMinutes: 45,
        destroyAfterRestingMinutes: null,
      });
      renderPanel([]);

      await waitFor(() => {
        expect(
          screen.getByTestId("sandboxes-defaults-summary").textContent,
        ).toContain("Linux · 2 vCPU · 4 GB");
      });
      expect(screen.getByTestId("sandboxes-defaults-shape").textContent).toBe(
        "Shape · Linux · 2 vCPU · 4 GB · from $0.12/h · Suspend keeps memory",
      );
      expect(screen.getByTestId("sandboxes-defaults-idle").textContent).toBe(
        "Idle · 30 minutes",
      );
      expect(screen.getByTestId("sandboxes-defaults-resting").textContent).toBe(
        "Destruction · removed after 7 days suspended or stopped",
      );
    });

    it("shows Personal defaults and Save on arrival", async () => {
      mocks.catalogue = CATALOGUE;
      host.environments = [descriptor(PERSONAL_ENV, "user", "u1", "owner")];
      renderPanel([]);

      expect(
        await screen.findByRole("heading", { name: "Defaults" }),
      ).toBeTruthy();
      expect(await screen.findByTestId("sandboxes-defaults-form")).toBeTruthy();
      expect(
        screen.getByRole("button", { name: "Save defaults" }),
      ).toBeTruthy();
      expect(
        screen.getByText(
          "Destroy after suspended or stopped for (empty: never)",
        ),
      ).toBeTruthy();
      expect(
        screen.getByTestId("sandboxes-defaults-idle-input"),
      ).toHaveProperty("value", "30");
      const shape = screen.getByRole("combobox", { name: "Shape" });
      const shapeLine =
        "Linux · 2 vCPU · 4 GB · from $0.12/h · Suspend keeps memory";
      expect(shape.textContent).toContain(shapeLine);
      expect(
        screen
          .getByTestId("sandboxes-defaults-form")
          .querySelector("[id$='shape-consequence']"),
      ).toBeNull();
      expect(screen.queryByTestId("sandboxes-defaults-editors")).toBeNull();
      expect(
        screen.getByText(
          "New Personal sandboxes use these defaults. Existing sandboxes keep their Idle settings.",
        ),
      ).toBeTruthy();
      expect(
        screen.queryByText("Each new sandbox starts with these"),
      ).toBeNull();
      expect(screen.queryByText("aren't destroyed when idle")).toBeNull();
      expect(screen.queryByText("not a spending limit")).toBeNull();
      fireEvent.click(shape);
      expect(
        screen.getByRole("option", { name: /2 vCPU · 4 GB/ }).textContent,
      ).toContain(shapeLine);
    });

    it.each(["editor", "admin"] as const)(
      "shows a team's default form for %s without repeating the environment",
      async (role) => {
        viewTeamAs(role, { cpus: 8, memoryMb: 16_384, idleMinutes: 90 });
        renderPanel([]);

        expect(
          await screen.findByRole("heading", { name: "Defaults" }),
        ).toBeTruthy();
        expect(
          await screen.findByTestId("sandboxes-defaults-idle-input"),
        ).toHaveProperty("value", "45");
        expect(
          screen.getByTestId("sandboxes-defaults-form").textContent,
        ).not.toContain("Acme");
        expect(
          screen.getByText(
            "New Acme sandboxes use these defaults. Shared by Acme, not a spending limit. Existing sandboxes keep their Idle settings.",
          ),
        ).toBeTruthy();
        expect(
          screen.queryByText("Each new sandbox starts with these"),
        ).toBeNull();
        expect(screen.queryByText("aren't destroyed when idle")).toBeNull();
        const shape = screen.getByRole("combobox", { name: "Shape" });
        expect(shape.textContent).toContain(
          "Linux · 4 vCPU · 8 GB · from $0.12/h · Suspend keeps memory",
        );
        fireEvent.click(shape);
        expect(
          screen.getByRole("option", { name: /2 vCPU · 4 GB/ }).textContent,
        ).toContain("Linux · 2 vCPU · 4 GB · $0.12/h · Suspend keeps memory");
        expect(
          screen.getByRole("option", { name: /4 vCPU · 8 GB/ }).textContent,
        ).toContain(
          "Linux · 4 vCPU · 8 GB · from $0.12/h · Suspend keeps memory",
        );
      },
    );

    it("gives a viewer the item read-only, naming who can change it", async () => {
      viewTeamAs("viewer", { cpus: 8, memoryMb: 16_384, idleMinutes: 90 });
      host.members = [
        {
          userId: "u-1",
          displayName: "Ada",
          effectiveRole: "admin",
          inviteState: "accepted",
        },
        {
          userId: "u-2",
          displayName: "Bo",
          effectiveRole: "editor",
          inviteState: "accepted",
        },
        {
          userId: "u-3",
          displayName: "Cy",
          effectiveRole: "viewer",
          inviteState: "accepted",
        },
        {
          userId: "u-4",
          displayName: "Di",
          effectiveRole: "editor",
          inviteState: "pending",
        },
      ];
      renderPanel([]);

      expect(
        await screen.findByText("Ada, Bo can change defaults."),
      ).toBeTruthy();
      expect(screen.getByRole("button", { name: "Members" })).toBeTruthy();
      expect(screen.queryByText(/Cy|Di/u)).toBeNull();
      expect(screen.queryByTestId("sandboxes-defaults-form")).toBeNull();
      expect(
        screen.queryByRole("button", { name: "Save defaults" }),
      ).toBeNull();
      expect(harness?.paramsOf("environment.configuration.items.put")).toEqual(
        [],
      );
    });

    it("gives an editor the form on the item's values, saving it at the read revision", async () => {
      viewTeamAs("editor", { cpus: 8, memoryMb: 16_384, idleMinutes: 90 });
      renderPanel([]);

      const idle = await screen.findByTestId("sandboxes-defaults-idle-input");
      expect(
        screen.queryByText(
          "New sandboxes take these; sandboxes you already have keep theirs.",
        ),
      ).toBeNull();
      expect(
        screen.getByRole("button", { name: "Save defaults" }),
      ).toBeDefined();
      expect(idle).toHaveProperty("value", "45");
      expect(
        screen.getByRole("combobox", { name: "Shape" }).textContent,
      ).toContain("4 vCPU");
      fireEvent.change(idle, { target: { value: "2" } });
      fireEvent.click(screen.getByRole("button", { name: "Save defaults" }));

      await waitFor(() => {
        expect(
          harness?.paramsOf("environment.configuration.items.put"),
        ).toEqual([
          {
            environmentId: TEAM_ENV,
            kind: "sandbox_defaults",
            key: "sandbox",
            os: null,
            value: { ...SANDBOX_DEFAULTS_VALUE, idleMinutes: 2 },
            revision: 3,
          },
        ]);
      });
    });

    it("keeps the save's label and shows the working dots while it is in flight", async () => {
      viewTeamAs("editor", { cpus: 8, memoryMb: 16_384, idleMinutes: 90 });
      let finish: (
        response: EnvironmentConfigurationItemWriteResponse,
      ) => void = () => undefined;
      host.put = () =>
        new Promise((resolve) => {
          finish = resolve;
        });
      renderPanel([]);

      const idle = await screen.findByTestId("sandboxes-defaults-idle-input");
      fireEvent.change(idle, { target: { value: "2" } });
      fireEvent.click(screen.getByRole("button", { name: "Save defaults" }));

      const saving = await screen.findByTestId("sandboxes-defaults-saving");
      const save = screen.getByTestId("sandboxes-defaults-save");
      expect(save.contains(saving)).toBe(true);
      expect(screen.getByRole("button", { name: "Save defaults" })).toBe(save);
      expect(save).toHaveProperty("disabled", true);

      act(() => {
        finish({ outcome: "saved", revision: 4 });
      });
      await waitFor(() => {
        expect(screen.queryByTestId("sandboxes-defaults-saving")).toBeNull();
      });
    });

    it("refuses an idle period under 2 minutes without writing", async () => {
      viewTeamAs("editor", { cpus: 8, memoryMb: 16_384, idleMinutes: 90 });
      renderPanel([]);

      const idle = await screen.findByTestId("sandboxes-defaults-idle-input");
      fireEvent.change(idle, { target: { value: "1" } });

      expect(
        screen.getByTestId("sandboxes-defaults-problem").textContent,
      ).toContain("at least 2 minutes");
      expect(
        screen.getByRole("button", { name: "Save defaults" }),
      ).toHaveProperty("disabled", true);
    });

    it("names the suspended or stopped clock in a validation problem", async () => {
      viewTeamAs("editor", { cpus: 8, memoryMb: 16_384, idleMinutes: 90 });
      renderPanel([]);

      const resting = await screen.findByTestId(
        "sandboxes-defaults-resting-input",
      );
      fireEvent.change(resting, { target: { value: "1.5" } });

      expect(screen.getByTestId("sandboxes-defaults-problem").textContent).toBe(
        '"Destroy after suspended or stopped for" must be a whole number, or empty.',
      );
    });

    it("says another member changed the defaults when the save conflicts, after the reread", async () => {
      viewTeamAs("editor", { cpus: 8, memoryMb: 16_384, idleMinutes: 90 });
      host.put = () => {
        host.items[TEAM_ENV] = [
          defaultsItem({ ...SANDBOX_DEFAULTS_VALUE, idleMinutes: 10 }, 4),
        ];
        return {
          outcome: "conflict",
          current: { revision: 4, changedBy: "Grace", changedAt: 2 },
        };
      };
      renderPanel([]);

      const idle = await screen.findByTestId("sandboxes-defaults-idle-input");
      fireEvent.change(idle, { target: { value: "2" } });
      fireEvent.click(screen.getByRole("button", { name: "Save defaults" }));

      expect(await screen.findByText(/Changed by Grace/)).toBeTruthy();
      await waitFor(() => {
        expect(
          screen.getByTestId("sandboxes-defaults-idle-input"),
        ).toHaveProperty("value", "10");
      });
      expect(screen.getByText(/Changed by Grace/)).toBeTruthy();
    });

    it("switches the open defaults editor to the selected configuration", async () => {
      viewTeamAs("editor", { cpus: 8, memoryMb: 16_384, idleMinutes: 90 });
      const personal = {
        ...SANDBOX_DEFAULTS_VALUE,
        idleMinutes: 90,
        restingMinutes: 60,
      };
      host.items[PERSONAL_ENV] = [defaultsItem(personal, 3)];
      mocks.sandboxes = [];
      // A composer keeps every configuration's defaults read, so a switch
      // finds the other one's already answered.
      function ComposerDefaultsReader(): null {
        useSandboxDefaultsLookup(true);
        return null;
      }
      renderUi(
        <>
          <SandboxesSettingsPanel />
          <ComposerDefaultsReader />
        </>,
      );

      expect(
        await screen.findByRole("button", { name: "Save defaults" }),
      ).toBeTruthy();
      expect(
        await screen.findByTestId("sandboxes-defaults-idle-input"),
      ).toHaveProperty("value", "45");
      act(() => {
        useSettingsEnvironmentPickStore.setState({ pick: PERSONAL_PICK });
      });

      expect(await screen.findByTestId("sandboxes-defaults-form")).toBeTruthy();
      await waitFor(() => {
        expect(
          screen.getByTestId("sandboxes-defaults-idle-input"),
        ).toHaveProperty("value", "90");
      });
      fireEvent.change(screen.getByTestId("sandboxes-defaults-idle-input"), {
        target: { value: "91" },
      });
      fireEvent.click(screen.getByRole("button", { name: "Save defaults" }));

      await waitFor(() => {
        expect(
          harness?.paramsOf("environment.configuration.items.put"),
        ).toEqual([
          {
            environmentId: PERSONAL_ENV,
            kind: "sandbox_defaults",
            key: "sandbox",
            os: null,
            value: { ...personal, idleMinutes: 91 },
            revision: 3,
          },
        ]);
      });
    });

    it("keeps a configuration's save outcome to that configuration", async () => {
      viewTeamAs("editor", { cpus: 8, memoryMb: 16_384, idleMinutes: 90 });
      host.put = () => ({
        outcome: "conflict",
        current: { revision: 4, changedBy: "Grace", changedAt: 2 },
      });
      renderPanel([]);

      const idle = await screen.findByTestId("sandboxes-defaults-idle-input");
      fireEvent.change(idle, { target: { value: "2" } });
      fireEvent.click(screen.getByRole("button", { name: "Save defaults" }));
      expect(await screen.findByText(/Changed by Grace/)).toBeTruthy();
      act(() => {
        useSettingsEnvironmentPickStore.setState({ pick: PERSONAL_PICK });
      });

      expect(
        await screen.findByRole("heading", { name: "Defaults" }),
      ).toBeTruthy();
      expect(screen.queryByText(/Changed by Grace/)).toBeNull();
    });
  });
  afterEach(() => {
    cleanup();
    resetNegotiatedManifests();
    useAuthStore.setState({ status: "signed-out", contextMetadata: null });
    resetTeamPageHarness();
  });

  it("renders one row per state with its badge and primary action", () => {
    renderPanel([
      row("awake-1", { state: "awake" }),
      row("suspended-1", { state: "suspended" }),
      row("stopped-1", { state: "stopped" }),
      row("frozen-1", { state: "suspended", frozen: true, frozenAt: 1 }),
      row("failed-1", { state: "failed", failureCode: "boom" }),
    ]);

    const expected: Record<string, [string, string]> = {
      "awake-1": ["Awake", "Suspend"],
      "suspended-1": ["Suspended", "Resume"],
      "stopped-1": ["Stopped", "Start"],
      "frozen-1": ["Suspended", "Add credits ↗"],
      "failed-1": ["Failed", "Retry"],
    };
    for (const [id, [badge, primary]] of Object.entries(expected)) {
      const element = rowOf(id);
      expect(
        within(element).getByTestId("sandboxes-row-state").textContent,
      ).toBe(badge);
      expect(within(element).getByTestId("row-primary").textContent).toBe(
        primary,
      );
      if (id === "frozen-1") {
        expect(within(element).getByText("Out of credits")).toBeDefined();
      }
    }
  });

  it("keeps the charge notice and Stop action when setup failed and the host is unreachable", () => {
    useAuthStore.setState({
      status: "signed-in",
      contextMetadata: { userId: "u-viewer", username: "viewer" },
    });
    mocks.sessionFailed = true;
    mocks.settingsItems = [{ kind: "setup_script", status: "failed" }];
    const sandbox = row("setup-unreachable", { state: "awake" });
    mocks.sandboxes = [sandbox];

    const panel = renderUi(<SandboxesSettingsPanel />);
    panel.rerender(<SandboxesSettingsPanel />);

    const failed = within(rowOf(sandbox.id));
    expect(failed.getByTestId("sandboxes-row-clock").textContent).toBe(
      "Running, but Traycer can't connect",
    );
    expect(
      failed.getAllByText("Compute is charged while it is awake."),
    ).toHaveLength(1);
    expect(failed.getByTestId("row-primary").textContent).toBe("Stop");
  });

  it.each([
    { signal: "guest setup failed", guestConfigured: false, failed: false },
    { signal: "a setting failed", guestConfigured: true, failed: true },
  ])(
    "shows the setup facts and each inline recovery action when $signal",
    async ({ guestConfigured, failed: settingFailed }) => {
      mocks.realActions = true;
      recordNegotiatedHostManifest("host-setup-failed", {
        "host.sandbox.repairGuestConfiguration": { major: 1, minor: 1 },
      });
      mocks.settingsItems = settingFailed
        ? [{ kind: "setup_script", status: "failed" }]
        : [];
      const sandbox = row("setup-failed", {
        state: "awake",
        guestConfigured,
        failureCode: null,
      });
      mocks.sandboxes = [sandbox];

      renderUi(<SandboxesSettingsPanel />);

      const failed = within(rowOf(sandbox.id));
      expect(failed.getByTestId("sandboxes-row-clock").textContent).toBe(
        "Personal's settings didn't apply · SBX-0520",
      );
      expect(
        failed.getAllByText("Compute is charged while it is awake."),
      ).toHaveLength(1);
      for (const name of [
        "Retry applying",
        "Open terminal",
        "Stop",
        "Choose another host",
        "Details",
      ]) {
        expect(failed.getAllByRole("button", { name })).toHaveLength(1);
      }
      await userEvent.click(
        failed.getByRole("button", { name: "More actions for setup-failed" }),
      );
      expect(
        screen.getAllByRole("menuitem").map((item) => item.textContent),
      ).toEqual(["Rename", "Destroy"]);
    },
  );

  it("puts an agent sandbox's creator on the shape line and keeps the setup evidence", () => {
    const sandbox = row("burst-setup", {
      state: "awake",
      burst: true,
      guestConfigured: false,
      createdByAgentId: "agent-1",
      createdByAgentName: "Planner",
      createdByTaskTitle: "Sandbox setup",
    });
    renderPanel([sandbox]);

    const burst = within(rowOf(sandbox.id));
    expect(burst.getByText("Agent sandbox")).toBeTruthy();
    expect(burst.queryByText("Setup failed")).toBeNull();
    expect(
      burst.getByText(
        "Linux · 2 vCPU · 4 GB · $0.12 an hour while awake · created by Planner for Sandbox setup",
      ),
    ).toBeTruthy();
    expect(burst.getByTestId("sandboxes-row-clock").textContent).toBe(
      "Personal's settings didn't apply · SBX-0520",
    );
    expect(
      burst.getByText("Compute is charged while it is awake."),
    ).toBeTruthy();
    expect(burst.getByText("Sandbox setup did not apply.")).toBeTruthy();
  });

  it("does not show the setup charge notice for healthy or frozen sandboxes", () => {
    const healthy = row("healthy", { state: "awake", guestConfigured: true });
    const frozen = row("frozen", {
      state: "suspended",
      frozen: true,
      frozenAt: 1,
    });
    mocks.sandboxes = [healthy, frozen];

    renderUi(<SandboxesSettingsPanel />);

    for (const sandbox of [healthy, frozen]) {
      expect(
        within(rowOf(sandbox.id)).queryByText(
          "Compute is charged while it is awake.",
        ),
      ).toBeNull();
    }
  });

  it("renders the failed-create sentence and keeps Retry, Destroy and Details", () => {
    mocks.realActions = true;
    renderPanel([
      row("build-box", {
        state: "failed",
        failureCode: "create:kube-create-service-account",
        lastTransitionAt: new Date(2026, 9, 25, 11, 1).getTime(),
      }),
    ]);

    const failed = within(rowOf("build-box"));
    expect(failed.getByTestId("sandboxes-row-clock").textContent).toBe(
      "Couldn't start at 11:01 · The sandbox service couldn't start it. · SBX-0412",
    );
    expect(
      failed.getByRole("button", { name: "Retry" }).hasAttribute("disabled"),
    ).toBe(false);
    const destroy = failed.getByRole("button", {
      name: "Destroy build-box",
    });
    expect(destroy.textContent).toBe("Destroy");
    expect(failed.getByRole("button", { name: "Details" })).toBeTruthy();
    expect(
      failed.queryByRole("button", { name: "More actions for build-box" }),
    ).toBeNull();
  });

  it.each(SANDBOX_FIRST_BOOT_FAILURE_COPIES)(
    "shows the %s failure reason on the failed row",
    (stage, explanation) => {
      const failed = row("first-boot", {
        state: "failed",
        failureCode: stage,
        lastTransitionAt: new Date(2026, 9, 25, 11, 1).getTime(),
      });
      renderPanel([failed]);

      const clock = within(rowOf(failed.id)).getByTestId("sandboxes-row-clock");
      expect(clock.textContent).toContain(explanation);
      expect(clock.textContent).not.toContain(stage);
    },
  );

  it("offers an awake agent sandbox Keep instead of Suspend", () => {
    renderPanel([row("agent-1", { state: "awake", burst: true })]);
    expect(
      within(rowOf("agent-1")).getByTestId("row-primary").textContent,
    ).toBe("Keep this sandbox");
  });

  describe("row ordering", () => {
    it("holds row positions through activity reports while rendering fresh data", () => {
      mocks.sandboxes = [
        row("sleeping", { state: "suspended", lastActivityAt: 300 }),
        row("older", { lastActivityAt: 100 }),
        row("newer", { lastActivityAt: 200 }),
      ];
      const { rerender } = renderUi(<SandboxesSettingsPanel />);
      expect(names()).toEqual(["newer", "older", "sleeping"]);

      mocks.sandboxes = [
        row("older", { lastActivityAt: 400 }),
        row("sleeping", { state: "suspended", lastActivityAt: 500 }),
        row("newer", { lastActivityAt: 200 }),
      ];
      rerender(<SandboxesSettingsPanel />);
      expect(names()).toEqual(["newer", "older", "sleeping"]);

      mocks.sandboxes = mocks.sandboxes.map((summary) => ({
        ...summary,
        displayName: `${summary.id} refreshed`,
      }));
      mocks.report = liveSessionReport(
        { agents: [agentSessionFixture({})], terminals: [] },
        false,
      );
      rerender(<SandboxesSettingsPanel />);
      expect(names()).toEqual([
        "newer refreshed",
        "older refreshed",
        "sleeping refreshed",
      ]);
      expect(
        within(rowOf("older")).getByTestId("sandboxes-row-sessions")
          .textContent,
      ).toContain("1 session running");
    });

    it("orders raw awake rows first, and keeps that order when only frozen changes", () => {
      mocks.sandboxes = [
        row("older", { lastActivityAt: 100 }),
        row("newer", { lastActivityAt: 200 }),
        row("sleeping", { state: "suspended", lastActivityAt: 300 }),
      ];
      const { rerender } = renderUi(<SandboxesSettingsPanel />);

      mocks.sandboxes = [
        row("older", { lastActivityAt: 400 }),
        row("newer", { lastActivityAt: 200 }),
        row("sleeping", { state: "awake", lastActivityAt: 300 }),
      ];
      rerender(<SandboxesSettingsPanel />);
      expect(names()).toEqual(["older", "sleeping", "newer"]);

      mocks.sandboxes = mocks.sandboxes.map((summary) =>
        summary.id === "older" ? { ...summary, frozen: true } : summary,
      );
      rerender(<SandboxesSettingsPanel />);
      expect(names()).toEqual(["older", "sleeping", "newer"]);
    });

    it("keeps the order when a transition lands in the same public state", () => {
      mocks.sandboxes = [
        row("waking", { state: "resuming", lastActivityAt: 100 }),
        row("awake", { lastActivityAt: 200 }),
      ];
      const { rerender } = renderUi(<SandboxesSettingsPanel />);

      mocks.sandboxes = [
        row("waking", { state: "awake", lastActivityAt: 300 }),
        row("awake", { lastActivityAt: 200 }),
      ];
      rerender(<SandboxesSettingsPanel />);
      expect(names()).toEqual(["awake", "waking"]);
      expect(
        within(rowOf("waking")).getByTestId("row-primary").textContent,
      ).toBe("Suspend");
    });

    it("places every added row by the rule and counts it immediately", () => {
      mocks.sandboxes = [
        row("older", { lastActivityAt: 100 }),
        row("sleeping", { state: "suspended", lastActivityAt: 400 }),
      ];
      const { rerender } = renderUi(<SandboxesSettingsPanel />);

      mocks.sandboxes = [
        ...mocks.sandboxes,
        row("middle", { lastActivityAt: 200 }),
        row("newest", { lastActivityAt: 300 }),
      ];
      rerender(<SandboxesSettingsPanel />);
      expect(names()).toEqual(["newest", "middle", "older", "sleeping"]);
      expect(screen.getByTestId("sandboxes-list-header").textContent).toContain(
        "4 sandboxes",
      );
    });

    it("drops a removed row and updates the count", () => {
      mocks.sandboxes = [
        row("older", { lastActivityAt: 100 }),
        row("newer", { lastActivityAt: 200 }),
        row("removed", { state: "suspended", lastActivityAt: 300 }),
      ];
      const { rerender } = renderUi(<SandboxesSettingsPanel />);

      mocks.sandboxes = [
        row("older", { lastActivityAt: 400 }),
        row("newer", { lastActivityAt: 200 }),
      ];
      rerender(<SandboxesSettingsPanel />);
      expect(names()).toEqual(["older", "newer"]);
      expect(screen.getByTestId("sandboxes-list-header").textContent).toContain(
        "2 sandboxes",
      );
    });

    it("breaks equal activity keys by id in both state groups", () => {
      renderPanel([
        row("z-sleeping", { state: "suspended", lastActivityAt: 200 }),
        row("z-awake", { lastActivityAt: null, lastTransitionAt: 100 }),
        row("a-sleeping", { state: "suspended", lastActivityAt: 200 }),
        row("a-awake", { lastActivityAt: 100 }),
      ]);
      expect(names()).toEqual([
        "a-awake",
        "z-awake",
        "a-sleeping",
        "z-sleeping",
      ]);
    });

    it("retains positions when a search is cleared after a report", () => {
      mocks.sandboxes = [
        row("older", { lastActivityAt: 100 }),
        row("newer", { lastActivityAt: 200 }),
      ];
      const { rerender } = renderUi(<SandboxesSettingsPanel />);
      fireEvent.change(screen.getByTestId("sandboxes-search"), {
        target: { value: "older" },
      });
      expect(names()).toEqual(["older"]);

      mocks.sandboxes = [
        row("older", { lastActivityAt: 300 }),
        row("newer", { lastActivityAt: 200 }),
      ];
      rerender(<SandboxesSettingsPanel />);
      fireEvent.change(screen.getByTestId("sandboxes-search"), {
        target: { value: "" },
      });
      expect(names()).toEqual(["newer", "older"]);
    });

    it("sorts from current activity again when the page reopens", () => {
      mocks.sandboxes = [
        row("older", { lastActivityAt: 100 }),
        row("newer", { lastActivityAt: 200 }),
      ];
      const { unmount } = renderUi(<SandboxesSettingsPanel />);
      expect(names()).toEqual(["newer", "older"]);
      unmount();

      mocks.sandboxes = [
        row("older", { lastActivityAt: 300 }),
        row("newer", { lastActivityAt: 200 }),
      ];
      renderUi(<SandboxesSettingsPanel />);
      expect(names()).toEqual(["older", "newer"]);
    });
  });

  it("shows a row's withdrawal notice only when the server announces one", () => {
    const endsAt = new Date(2026, 11, 1).getTime();
    renderPanel([
      row("withdrawn", { withdrawalEndsAt: endsAt }),
      row("plain", { withdrawalEndsAt: null }),
    ]);

    expect(
      within(rowOf("withdrawn")).getByTestId("sandboxes-row-withdrawal")
        .textContent,
    ).toContain("stops running");
    expect(
      within(rowOf("plain")).queryByTestId("sandboxes-row-withdrawal"),
    ).toBeNull();
  });

  it("keeps a frozen payer consequence once on its own line before the removal date", () => {
    const frozenAt = Date.UTC(2026, 9, 9);
    renderPanel([
      row("frozen", {
        state: "suspended",
        frozen: true,
        frozenAt,
        destroyAt: frozenDestroyAt(frozenAt),
        withdrawalEndsAt: Date.UTC(2026, 11, 1),
      }),
    ]);

    expect(
      within(rowOf("frozen")).getByTestId("sandboxes-row-withdrawal")
        .textContent,
    ).toBe(
      "This sandbox stops running and is rebuilt from your environment. Files outside the repository are lost.",
    );
    const frozen = rowOf("frozen");
    expect(within(frozen).getByTestId("sandboxes-row-clock").textContent).toBe(
      `Will be removed on ${formatSandboxDate(frozenDestroyAt(frozenAt), false)}`,
    );
    const consequence = within(frozen).getByTestId(
      "sandboxes-row-payer-consequence",
    );
    expect(consequence.textContent).toBe("Your credits ran out.");
    expect(consequence.className).toContain("wrap-anywhere");
    expect(frozen.textContent.match(/Your credits ran out\./gu)).toHaveLength(
      1,
    );
    expect(
      consequence.compareDocumentPosition(
        within(frozen).getByTestId("row-primary"),
      ) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).not.toBe(0);
    expect(within(rowOf("frozen")).getAllByText("Out of credits")).toHaveLength(
      1,
    );
  });

  it("tells a stopped row its paused session was lost and that its files are unchanged, since the list says nothing else of them", () => {
    renderPanel([
      row("stopped-lost", {
        state: "stopped",
        operation: sandboxOperationFixture({
          fromState: "suspended",
          state: "stopped",
          outcomeDetail: "suspended-session-lost",
        }),
      }),
    ]);

    expect(
      within(rowOf("stopped-lost")).getByTestId("sandboxes-row-session-notice")
        .textContent,
    ).toBe(
      "Your paused session was lost when your sandbox stopped. Your files are unchanged.",
    );
  });

  it("narrows the list by the search and by the state filter, with a count badge", () => {
    renderPanel([
      row("alpha", { state: "awake" }),
      row("beta", { state: "suspended" }),
      row("gamma", { state: "suspended" }),
    ]);
    expect(names().sort()).toEqual(["alpha", "beta", "gamma"]);
    expect(
      screen.getByRole("heading", { name: "Your sandboxes" }),
    ).toBeTruthy();
    expect(screen.getByTestId("sandboxes-list-header").textContent).toBe(
      "3 sandboxes.",
    );

    fireEvent.change(screen.getByTestId("sandboxes-search"), {
      target: { value: "bet" },
    });
    expect(names()).toEqual(["beta"]);
    fireEvent.change(screen.getByTestId("sandboxes-search"), {
      target: { value: "" },
    });

    fireEvent.pointerDown(screen.getByTestId("sandboxes-filter"), {
      button: 0,
      ctrlKey: false,
    });
    fireEvent.click(screen.getByTestId("sandboxes-filter-state-awake"));
    expect(names()).toEqual(["alpha"]);
    expect(screen.getByTestId("sandboxes-filter-count").textContent).toBe("1");
    expect(screen.getByTestId("sandboxes-list-header").textContent).toBe(
      "Showing Awake. 1 of 3.",
    );
  });

  describe("Destroy all idle through the Settings list query", () => {
    function mount(rows: readonly SandboxSummary[]) {
      const binding = createFakeSandboxBinding();
      mocks.binding = binding;
      mocks.realActions = true;
      useAuthStore.setState({
        status: "signed-in",
        contextMetadata: { userId: "u1", username: "ada" },
      });
      binding.auth.listSandboxes.mockResolvedValue({
        kind: "ok",
        response: { sandboxes: rows },
      });
      const page = hostPage();
      renderUi(<SandboxesSettingsPanel />);
      return { binding, client: page.queryClient };
    }

    async function choose(group: string, value: string): Promise<void> {
      await userEvent.click(
        screen.getByRole("button", { name: "Filter sandboxes" }),
      );
      await userEvent.click(
        screen.getByTestId(`sandboxes-filter-${group}-${value}`),
      );
      await userEvent.keyboard("{Escape}");
    }

    async function confirmIdle(): Promise<HTMLElement> {
      fireEvent.click(
        await screen.findByRole("button", { name: "Destroy all idle" }),
      );
      return screen.getByRole("dialog", { name: /Destroy \d+ idle sandbox/ });
    }

    const first = row("idle-a", { state: "suspended", burst: true });
    const second = row("idle-b", { state: "suspended", burst: false });
    const automation = row("Automations", {
      state: "suspended",
      kind: "automation",
    });

    it.each(["all", "awake", "suspended", "stopped", "resuming", "failed"])(
      "offers the header action only for idle State filters: %s",
      async (state) => {
        const idleState = state === "stopped" ? "stopped" : "suspended";
        mount([
          { ...first, state: idleState },
          { ...second, state: idleState },
          { ...automation, state: idleState },
        ]);
        await screen.findByText("idle-a");
        await choose("state", state);
        const offered = state === "suspended" || state === "stopped";
        expect(
          screen.queryByRole("button", { name: "Destroy all idle" }) !== null,
        ).toBe(offered);
        if (offered) {
          for (const kind of ["sandbox", "agent", "automation", "all"]) {
            await choose("kind", kind);
            expect(
              screen
                .getByRole("button", { name: "Destroy all idle" })
                .hasAttribute("disabled"),
            ).toBe(kind === "automation");
          }
        }
      },
    );

    it("confirms the enumerated filtered names and count without Automations, then keeps that set", async () => {
      mocks.configurations.push({
        kind: "team",
        teamId: "t1",
        teamName: "Acme",
        environmentId: TEAM_ENV,
      });
      const { binding, client } = mount([
        first,
        second,
        automation,
        row("elsewhere", { state: "suspended", environmentId: TEAM_ENV }),
        row("awake", { state: "awake" }),
      ]);
      await screen.findByText("idle-a");
      await choose("state", "suspended");
      const dialog = await confirmIdle();
      expect(within(dialog).getByRole("heading").textContent).toBe(
        "Destroy 2 idle sandboxes?",
      );
      expect(
        within(dialog).getByTestId("sandbox-destroy-all-idle-targets")
          .textContent,
      ).toBe("idle-aidle-b");
      expect(dialog.textContent).toContain(
        "Files on these sandboxes cannot be recovered; published chats stay readable.",
      );
      const expanded = [
        first,
        second,
        automation,
        row("idle-new", { state: "suspended" }),
      ];
      binding.auth.listSandboxes.mockResolvedValue({
        kind: "ok",
        response: { sandboxes: expanded },
      });
      await act(async () => {
        await client.invalidateQueries({
          queryKey: sandboxQueryKeys.listAll(),
        });
      });
      expect(within(dialog).getByRole("heading").textContent).toBe(
        "Destroy 2 idle sandboxes?",
      );
      fireEvent.click(
        within(dialog).getByRole("button", { name: "Destroy 2" }),
      );
      await waitFor(() =>
        expect(binding.auth.destroySandbox.mock.calls).toEqual([
          [first.id, true],
          [second.id, true],
        ]),
      );
    });

    it("destroys only the kept Stopped row matching Kind, Started by and search", async () => {
      const kept = row("keep-match", { state: "stopped", burst: false });
      const { binding } = mount([
        kept,
        row("keep-agent", { state: "stopped", burst: true }),
        row("keep-other", {
          state: "stopped",
          createdBy: { userId: "u2", displayName: "Bea" },
        }),
        row("other-name", { state: "stopped" }),
        { ...automation, state: "stopped" },
      ]);
      await screen.findByText(kept.displayName);
      await choose("state", "stopped");
      await choose("kind", "sandbox");
      await choose("started", "you");
      fireEvent.change(
        screen.getByRole("textbox", { name: "Search by name or task" }),
        { target: { value: "keep" } },
      );
      const dialog = await confirmIdle();
      expect(within(dialog).getByRole("heading").textContent).toBe(
        "Destroy 1 idle sandbox?",
      );
      expect(
        within(dialog).getByTestId("sandbox-destroy-all-idle-targets")
          .textContent,
      ).toBe("keep-match");
      fireEvent.click(
        within(dialog).getByRole("button", { name: "Destroy 1" }),
      );
      await waitFor(() =>
        expect(binding.auth.destroySandbox.mock.calls).toEqual([
          [kept.id, true],
        ]),
      );
    });

    it("requires the running target's typed name before destroying any target", async () => {
      mocks.report = liveSessionReport(
        { agents: [agentSessionFixture({ working: true })], terminals: [] },
        true,
      );
      const { binding } = mount([first]);
      await screen.findByText("idle-a");
      await choose("state", "suspended");
      const dialog = await confirmIdle();
      const confirm = within(dialog).getByRole("button", { name: "Destroy 1" });
      expect(confirm.hasAttribute("disabled")).toBe(true);
      const input = within(dialog).getByRole("textbox", {
        name: "Type the name to confirm",
      });
      fireEvent.change(input, { target: { value: "wrong" } });
      fireEvent.click(confirm);
      expect(binding.auth.destroySandbox).not.toHaveBeenCalled();
      fireEvent.change(input, { target: { value: "idle-a" } });
      fireEvent.click(confirm);
      await waitFor(() =>
        expect(binding.auth.destroySandbox.mock.calls).toEqual([
          [first.id, true],
        ]),
      );
    });

    it("rechecks each target and skips one that wakes, loses authority, or becomes Automations", async () => {
      const lost = row("idle-lost", { state: "suspended" });
      const changed = row("idle-changed", { state: "suspended" });
      const { binding } = mount([first, second, lost, changed]);
      const pending = Promise.withResolvers<SandboxVerbFetchResult>();
      binding.auth.destroySandbox.mockReturnValueOnce(pending.promise);
      await screen.findByText("idle-a");
      await choose("state", "suspended");
      const dialog = await confirmIdle();
      fireEvent.click(
        within(dialog).getByRole("button", { name: "Destroy 4" }),
      );
      await waitFor(() =>
        expect(binding.auth.destroySandbox).toHaveBeenCalledWith(
          first.id,
          true,
        ),
      );
      binding.auth.listSandboxes.mockResolvedValue({
        kind: "ok",
        response: {
          sandboxes: [
            { ...second, state: "awake" },
            { ...changed, kind: "automation" },
          ],
        },
      });
      await act(async () => {
        pending.resolve({ kind: "ok", settled: true });
        await pending.promise;
      });
      await waitFor(() =>
        expect(dialog.textContent).toContain(
          "idle-lost · no longer available to destroy, left as it is",
        ),
      );
      expect(dialog.textContent).toContain(
        "idle-b · no longer idle, left as it is",
      );
      expect(dialog.textContent).toContain(
        "idle-changed · no longer available to destroy, left as it is",
      );
      expect(binding.auth.destroySandbox.mock.calls).toEqual([
        [first.id, true],
      ]);
    });

    it("shows per-row pending and failure, and retries only failed targets after the list grows", async () => {
      const { binding, client } = mount([first, second]);
      const pending = Promise.withResolvers<SandboxVerbFetchResult>();
      binding.auth.destroySandbox
        .mockReturnValueOnce(pending.promise)
        .mockResolvedValueOnce(refusal(503, "provider-error"));
      await screen.findByText("idle-a");
      await choose("state", "suspended");
      const dialog = await confirmIdle();
      fireEvent.click(
        within(dialog).getByRole("button", { name: "Destroy 2" }),
      );
      expect(
        (await within(rowOf(first.id)).findByRole("status", { hidden: true }))
          .textContent,
      ).toBe("Destroying · pending");
      await act(async () => {
        pending.resolve({ kind: "ok", settled: true });
        await pending.promise;
      });
      const failed = await within(rowOf(second.id)).findByRole("alert", {
        hidden: true,
      });
      expect(failed.textContent).toContain(
        "Couldn't destroy idle-b. Traycer refused that request.",
      );
      expect(failed.textContent).toContain("Support reference: SBX-0413");
      expect(
        within(failed).getByRole("button", { name: "Retry", hidden: true }),
      ).toBeTruthy();
      expect(
        within(failed).getByRole("button", { name: "Details", hidden: true }),
      ).toBeTruthy();
      const newcomer = row("idle-new", { state: "suspended" });
      binding.auth.listSandboxes.mockResolvedValue({
        kind: "ok",
        response: { sandboxes: [first, second, newcomer] },
      });
      await act(async () => {
        await client.invalidateQueries({
          queryKey: sandboxQueryKeys.listAll(),
        });
      });
      fireEvent.click(within(dialog).getByRole("button", { name: "Retry" }));
      await waitFor(() =>
        expect(binding.auth.destroySandbox.mock.calls).toEqual([
          [first.id, true],
          [second.id, true],
          [second.id, true],
        ]),
      );
    });

    it.each([
      {
        status: 409,
        code: "sandbox_transition_conflict",
        message: "no longer idle, left as it is",
      },
      {
        status: 404,
        code: "sandbox_not_found",
        message: "no longer available to destroy, left as it is",
      },
    ])(
      "sends the idle precondition and renders $code as that target's skip",
      async ({ status, code, message }) => {
        const { binding } = mount([first]);
        binding.auth.destroySandbox.mockResolvedValueOnce(
          refusal(status, code),
        );
        await screen.findByText("idle-a");
        await choose("state", "suspended");
        const dialog = await confirmIdle();
        fireEvent.click(
          within(dialog).getByRole("button", { name: "Destroy 1" }),
        );
        await waitFor(() =>
          expect(dialog.textContent).toContain(`idle-a · ${message}`),
        );
        expect(binding.auth.destroySandbox.mock.calls).toEqual([
          [first.id, true],
        ]);
        expect(
          within(dialog)
            .getByRole("button", { name: "Retry" })
            .hasAttribute("disabled"),
        ).toBe(true);
        expect(
          within(rowOf(first.id)).queryByRole("alert", { hidden: true }),
        ).toBeNull();
      },
    );

    it("rechecks a row Retry from a failed batch instead of destroying a target that woke", async () => {
      const { binding } = mount([first]);
      binding.auth.destroySandbox.mockResolvedValueOnce(
        refusal(503, "provider-error"),
      );
      await screen.findByText("idle-a");
      await choose("state", "suspended");
      const dialog = await confirmIdle();
      fireEvent.click(
        within(dialog).getByRole("button", { name: "Destroy 1" }),
      );
      await within(rowOf(first.id)).findByRole("alert", { hidden: true });
      fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
      await choose("state", "all");
      binding.auth.listSandboxes.mockResolvedValue({
        kind: "ok",
        response: { sandboxes: [{ ...first, state: "awake" }] },
      });
      fireEvent.click(
        within(rowOf(first.id)).getByRole("button", { name: "Retry" }),
      );
      await waitFor(() =>
        expect(rowOf(first.id).textContent).toContain("Skipped idle-a"),
      );
      expect(binding.auth.destroySandbox.mock.calls).toEqual([
        [first.id, true],
      ]);
    });
  });

  it("lists the Environment group's picked configuration, with no picker of its own", () => {
    mocks.configurations = [
      { kind: "personal" },
      {
        kind: "team",
        teamId: "team-1",
        teamName: "Acme",
        environmentId: "env-acme",
      },
    ];
    renderPanel([
      row("mine", { environmentId: null, createdBy: null }),
      row("acme-box", { environmentId: "env-acme" }),
    ]);
    expect(names()).toEqual(["mine"]);
    expect(screen.queryByTestId("sandboxes-configuration")).toBeNull();

    act(() => {
      useSettingsEnvironmentPickStore
        .getState()
        .setPick({ kind: "team", environmentId: "env-acme" });
    });

    expect(names()).toEqual(["acme-box"]);
  });

  it("says No sandboxes yet. when the configuration has none", () => {
    renderPanel([]);
    expect(screen.getByTestId("sandboxes-empty").textContent).toContain(
      "No sandboxes yet.",
    );
  });

  it("stages this configuration's New sandbox row on a new task's tab from New task, creating nothing", async () => {
    useStagedSandboxStore.setState({ bySurface: {} });
    mocks.catalogue = CATALOGUE;
    // Settings is open as a tab of its own, the selected one.
    await withSettingsTabSelected();
    renderPanel([]);

    fireEvent.click(screen.getByRole("button", { name: "New task" }));

    // A new task's draft tab is selected, not only routed to.
    const selected = useTabsStore.getState().activeItemId;
    expect(selected).not.toBe(tabItemId(SETTINGS_REF));
    const draftId = useLandingDraftStore.getState().activeDraftId;
    if (draftId === null) throw new Error("expected a new task's draft");
    expect(selected).toBe(tabItemId({ kind: "draft", id: draftId }));
    expect(navigations).toContainEqual(
      expect.objectContaining({
        to: "/draft/$draftId",
        params: { draftId },
      }),
    );

    const stage = readStagedSandbox("landing:window-test");
    expect(stage?.phase).toBe("staged");
    expect(stage?.target).toMatchObject({
      kind: "new",
      configuration: { kind: "personal" },
      shape: { os: "linux", cpus: 2, memoryMb: 4096, region: "us-east" },
    });
    useStagedSandboxStore.setState({ bySurface: {} });
  });
  it("stages the configuration's item, periods included, from New task when the person picked nothing", async () => {
    useStagedSandboxStore.setState({ bySurface: {} });
    mocks.catalogue = LISTED_CATALOGUE;
    host.items = {
      [PERSONAL_ENV]: [
        defaultsItem({ ...SANDBOX_DEFAULTS_VALUE, idleMinutes: 2 }, 1),
      ],
    };
    useSandboxShapeMemoryStore.getState().remember("laptop", "personal", {
      os: "linux",
      cpus: 2,
      memoryMb: 4096,
      diskMb: null,
      region: "us-east",
      idleMinutes: 90,
      destroyAfterRestingMinutes: 60,
    });
    await withSettingsTabSelected();
    renderPanel([]);
    await waitFor(() => {
      expect(
        screen.getByTestId("sandboxes-defaults-idle-input"),
      ).toHaveProperty("value", "2");
    });

    fireEvent.click(screen.getByRole("button", { name: "New task" }));

    expect(readStagedSandbox("landing:window-test")?.target).toMatchObject({
      kind: "new",
      shape: {
        cpus: 4,
        memoryMb: 8192,
        idleMinutes: 2,
        destroyAfterRestingMinutes: null,
      },
    });
    useStagedSandboxStore.setState({ bySurface: {} });
  });

  it("shows starter, keeper and task details with one inline Details control", async () => {
    useAuthStore.setState({
      status: "signed-in",
      contextMetadata: { userId: "user-me", username: "me" },
    });
    mocks.realActions = true;
    renderPanel([
      row("sbx-kept", {
        displayName:
          "A sandbox name that must stay completely visible on one wrapping line",
        burst: false,
        createdByAgentId: "agent-1",
        createdByAgentName: "Planner",
        createdByTaskTitle: "Sandbox setup",
        createdBy: null,
        keptBy: { userId: "user-me", displayName: "Me" },
      }),
    ]);

    const kept = rowOf("sbx-kept");
    const name = within(kept).getByTestId("sandboxes-row-name");
    expect(name.textContent).toBe(
      "A sandbox name that must stay completely visible on one wrapping line",
    );
    expect(within(kept).getByText("Started by Planner")).toBeTruthy();
    expect(within(kept).getByText("Kept by you")).toBeTruthy();
    expect(kept.textContent).toContain("created by Planner for Sandbox setup");
    expect(kept.textContent).not.toContain("For task");
    await userEvent.click(
      within(kept).getByRole("button", { name: "Details" }),
    );
    expect(useSandboxDetailsStore.getState().sandboxId).toBe("sbx-kept");
    await userEvent.click(
      within(kept).getByRole("button", { name: /^More actions for/ }),
    );
    const menu = await screen.findByTestId("sandbox-row-menu-content");
    expect(
      within(menu).queryByRole("menuitem", { name: "Details" }),
    ).toBeNull();
    useAuthStore.setState({ status: "signed-out", contextMetadata: null });
  });

  describe("inline session details", () => {
    const AWAKE = row("sbx-awake", { state: "awake" });

    it("shows the live session count and names on the row", () => {
      mocks.report = liveSessionReport(
        {
          agents: [agentSessionFixture({ name: "Planner", working: true })],
          terminals: [terminalSessionFixture({ name: "make watch" })],
        },
        true,
      );
      renderPanel([AWAKE]);

      expect(
        within(rowOf("sbx-awake")).getByTestId("sandboxes-row-sessions")
          .textContent,
      ).toContain("2 sessions running");
      expect(within(rowOf("sbx-awake")).getByText("Planner")).toBeTruthy();
      expect(within(rowOf("sbx-awake")).getByText("make watch")).toBeTruthy();
    });

    it("shows an empty live report without inventing session names", () => {
      mocks.report = liveSessionReport({ agents: [], terminals: [] }, false);
      renderPanel([AWAKE]);

      expect(
        within(rowOf("sbx-awake")).queryByTestId("sandboxes-row-session-pill"),
      ).toBeNull();
    });

    it("shows that the session count is unknown", () => {
      renderPanel([AWAKE]);

      expect(
        within(rowOf("sbx-awake")).getByText(/Sessions unknown/u),
      ).toBeTruthy();
    });
  });

  describe("a row's session notice follows its own state, not the public grouping", () => {
    const NOTICE = "sandboxes-row-session-notice";

    it.each([
      { state: "starting", word: "Starting" },
      { state: "resuming", word: "Resuming" },
    ] as const)(
      "says Restarting beside its own $word badge for a $state row grouped under awake",
      ({ state, word }) => {
        renderPanel([
          row("sbx-retry", {
            state,
            operation: sandboxOperationFixture({
              fromState: state === "starting" ? "stopped" : "suspended",
              state,
              outcomeDetail: "wake-retry",
            }),
          }),
        ]);

        expect(
          within(rowOf("sbx-retry")).getByTestId("sandboxes-row-state")
            .textContent,
        ).toBe(word);
        expect(within(rowOf("sbx-retry")).getByTestId(NOTICE).textContent).toBe(
          "Restarting your sandbox",
        );
      },
    );

    it("says the session expired for a resuming row that a conversion is stopping", () => {
      renderPanel([
        row("sbx-converting", {
          state: "resuming",
          operation: sandboxOperationFixture({
            state: "resuming",
            outcomeDetail: "suspended-session-expiry",
          }),
        }),
      ]);

      expect(
        within(rowOf("sbx-converting")).getByTestId(NOTICE).textContent,
      ).toBe("Your paused session has expired. Your sandbox is being stopped.");
    });

    it("says the session was lost, and that the files are unchanged, for a stopped row that is also frozen", () => {
      renderPanel([
        row("sbx-lost-frozen", {
          state: "stopped",
          frozen: true,
          frozenAt: 1,
          operation: sandboxOperationFixture({
            state: "stopped",
            outcomeDetail: "suspended-session-lost",
          }),
        }),
      ]);

      expect(
        within(rowOf("sbx-lost-frozen")).getByTestId(NOTICE).textContent,
      ).toBe(
        "Your paused session was lost when your sandbox stopped. Your files are unchanged.",
      );
    });

    it("says nothing for a stopped row whose last operation was an ordinary stop", () => {
      renderPanel([
        row("sbx-plain-stop", {
          state: "stopped",
          operation: sandboxOperationFixture({
            state: "stopped",
            outcomeDetail: null,
          }),
        }),
      ]);

      expect(within(rowOf("sbx-plain-stop")).queryByTestId(NOTICE)).toBeNull();
    });
  });

  describe("the header's day total", () => {
    const TEAM_DAY_ENV = "env-team-day";
    const TEAM_DAY = {
      kind: "team",
      teamId: "team-1",
      teamName: "Acme",
      environmentId: TEAM_DAY_ENV,
    } as const;

    function costsOf(
      todayByEnvironment: UserSandboxCost["todayByEnvironment"],
      rowTodayMc: number,
    ): UserSandboxCost {
      return {
        sandboxes: [
          {
            sandboxId: "sbx-a",
            currentRateMillicreditsPerHour: 120,
            state: "awake",
            frozen: false,
            charged: {
              computeMillicredits: 0,
              storageMillicredits: 0,
              sinceCreatedAt: 0,
            },
            pendingMillicredits: 0,
            segments: [],
            todayMillicredits: rowTodayMc,
            todayAwakeMs: null,
            history: [],
          },
        ],
        awakeBurnMillicreditsPerHour: 120,
        todayYoursMillicredits: 0,
        todayByEnvironment,
      };
    }

    function header(): string {
      return screen.getByTestId("sandboxes-list-header").textContent;
    }

    it("sums the environments that are none of the viewer's teams' for Personal, destroyed sandboxes included", () => {
      mocks.configurations = [{ kind: "personal" }, TEAM_DAY];
      mocks.costs = costsOf(
        [
          {
            environmentId: "env-personal",
            todayMillicredits: 300,
            todayYoursMillicredits: 300,
          },
          {
            environmentId: "env-other",
            todayMillicredits: 200,
            todayYoursMillicredits: 200,
          },
          {
            environmentId: TEAM_DAY_ENV,
            todayMillicredits: 5_000,
            todayYoursMillicredits: 700,
          },
        ],
        // The listed row's own day: the total is the server's, not this.
        20,
      );
      renderPanel([row("sbx-a", {})]);

      expect(header()).toBe("1 sandbox · $0.50 today (UTC day).");
    });

    it("reads the team's own environment for a team, with the viewer's share", () => {
      mocks.configurations = [{ kind: "personal" }, TEAM_DAY];
      host.environments = [
        descriptor(PERSONAL_ENV, "user", "u1", "owner"),
        descriptor(TEAM_DAY_ENV, "organization", "team-1", "viewer"),
      ];
      useSettingsEnvironmentPickStore.setState({
        pick: { kind: "team", environmentId: TEAM_DAY_ENV },
      });
      mocks.costs = costsOf(
        [
          {
            environmentId: "env-personal",
            todayMillicredits: 300,
            todayYoursMillicredits: 300,
          },
          {
            environmentId: TEAM_DAY_ENV,
            todayMillicredits: 5_000,
            todayYoursMillicredits: 700,
          },
        ],
        20,
      );
      renderPanel([row("sbx-a", { environmentId: TEAM_DAY_ENV })]);

      expect(header()).toBe(
        "1 sandbox · $5.00 today (UTC day), $0.70 of it yours.",
      );
    });

    it("falls back to the listed rows' sum when the server sends no per-environment totals", () => {
      mocks.costs = costsOf([], 20);
      renderPanel([row("sbx-a", {})]);

      expect(header()).toBe("1 sandbox · $0.02 today (UTC day).");
    });

    it("leaves the viewer's share out when it is zero", () => {
      mocks.configurations = [{ kind: "personal" }, TEAM_DAY];
      host.environments = [
        descriptor(PERSONAL_ENV, "user", "u1", "owner"),
        descriptor(TEAM_DAY_ENV, "organization", "team-1", "viewer"),
      ];
      useSettingsEnvironmentPickStore.setState({
        pick: { kind: "team", environmentId: TEAM_DAY_ENV },
      });
      mocks.costs = costsOf(
        [
          {
            environmentId: TEAM_DAY_ENV,
            todayMillicredits: 5_000,
            todayYoursMillicredits: 0,
          },
        ],
        20,
      );
      renderPanel([row("sbx-a", { environmentId: TEAM_DAY_ENV })]);

      expect(header()).toBe("1 sandbox · $5.00 today (UTC day).");
    });

    function pickTeam(): void {
      mocks.configurations = [{ kind: "personal" }, TEAM_DAY];
      host.environments = [
        descriptor(PERSONAL_ENV, "user", "u1", "owner"),
        descriptor(TEAM_DAY_ENV, "organization", "team-1", "viewer"),
      ];
      useSettingsEnvironmentPickStore.setState({
        pick: { kind: "team", environmentId: TEAM_DAY_ENV },
      });
    }

    it("names the viewer's share on a team even when it is all of the day's total", () => {
      pickTeam();
      mocks.costs = costsOf(
        [
          {
            environmentId: TEAM_DAY_ENV,
            todayMillicredits: 40,
            todayYoursMillicredits: 40,
          },
        ],
        20,
      );
      renderPanel([row("sbx-a", { environmentId: TEAM_DAY_ENV })]);

      expect(header()).toBe(
        "1 sandbox · $0.04 today (UTC day), $0.04 of it yours.",
      );
    });

    it("reads Automations only for a team with no sandboxes but a listed Automations row, with the share", () => {
      pickTeam();
      mocks.costs = costsOf(
        [
          {
            environmentId: TEAM_DAY_ENV,
            todayMillicredits: 40,
            todayYoursMillicredits: 40,
          },
        ],
        20,
      );
      renderPanel([
        row("sbx-auto", {
          kind: "automation",
          hostId: "auto-host",
          environmentId: TEAM_DAY_ENV,
        }),
      ]);

      expect(header()).toBe(
        "Automations only · $0.04 today (UTC day), $0.04 of it yours.",
      );
    });

    it("reads Automations only, with no share, when only the unstarted Automations host is shown", () => {
      mocks.automation = { available: true, sandbox: null, pods: [] };
      mocks.costs = costsOf(
        [
          {
            environmentId: "env-personal",
            todayMillicredits: 40,
            todayYoursMillicredits: 40,
          },
        ],
        20,
      );
      renderPanel([]);

      expect(header()).toBe("Automations only · $0.04 today (UTC day).");
    });
  });

  describe("a team row's payer", () => {
    const ACME = {
      kind: "team",
      teamId: "team-1",
      teamName: "Acme",
      environmentId: TEAM_ENV,
    } as const;
    const PAYER = { userId: "user-payer", displayName: "Priya" };

    function viewAs(userId: string): void {
      useAuthStore.setState({
        status: "signed-in",
        contextMetadata: { userId, username: userId },
      });
      mocks.configurations = [ACME];
      host.environments = [
        descriptor(TEAM_ENV, "organization", "team-1", "editor"),
      ];
      useSettingsEnvironmentPickStore.setState({
        pick: { kind: "team", environmentId: TEAM_ENV },
      });
    }

    function clockOf(id: string): string {
      return within(rowOf(id)).getByTestId("sandboxes-row-clock").textContent;
    }

    function shapeOf(id: string): string {
      const line = within(rowOf(id)).getByText((_content, element) => {
        if (element === null || element.tagName !== "P") return false;
        return element.textContent.startsWith("Linux ·");
      });
      return line.textContent;
    }

    it("reads Paid by you to the payer, and the payer's name to another member", () => {
      const awake = row("sbx-paid", {
        state: "awake",
        environmentId: TEAM_ENV,
        wakePayer: PAYER,
      });
      viewAs(PAYER.userId);
      renderPanel([awake]);
      expect(within(rowOf(awake.id)).getByText("Paid by you")).toBeDefined();
      expect(within(rowOf(awake.id)).queryByText("Paid by Priya")).toBeNull();
      expect(shapeOf(awake.id)).not.toContain("paid by");
      expect(
        screen.getByRole("heading", { name: "Acme's sandboxes" }),
      ).toBeTruthy();
      expect(
        screen.getByText(
          "Every sandbox running on Acme's settings, whoever started it, and what each one costs. Start one from a task's host picker.",
        ),
      ).toBeTruthy();
      expect(screen.getByTestId("sandboxes-list-header").textContent).toBe(
        "1 sandbox.",
      );
      cleanup();

      viewAs("user-other");
      renderPanel([awake]);
      expect(within(rowOf(awake.id)).getByText("Paid by Priya")).toBeDefined();
      expect(shapeOf(awake.id)).toBe(
        "Linux · 2 vCPU · 4 GB · $0.12 an hour while awake",
      );
      expect(within(rowOf(awake.id)).queryByText(/a member/)).toBeNull();
    });

    it("shows no Paid by badge on a personal row, a resting row, or an unnamed payer", () => {
      renderPanel([row("sbx-personal", { state: "awake", wakePayer: PAYER })]);
      expect(within(rowOf("sbx-personal")).queryByText(/Paid by/)).toBeNull();
      cleanup();

      viewAs("user-other");
      const resting = row("sbx-rest-badge", {
        state: "suspended",
        environmentId: TEAM_ENV,
        wakePayer: PAYER,
      });
      renderPanel([resting]);
      expect(within(rowOf(resting.id)).queryByText(/Paid by/)).toBeNull();
      cleanup();

      const unnamed = row("sbx-unnamed", {
        state: "awake",
        environmentId: TEAM_ENV,
        wakePayer: { userId: "user-hidden", displayName: null },
      });
      renderPanel([unnamed]);
      expect(within(rowOf(unnamed.id)).queryByText(/Paid by/)).toBeNull();
      expect(within(rowOf(unnamed.id)).queryByText(/a member/)).toBeNull();
      expect(shapeOf(unnamed.id)).not.toContain("paid by");
      expect(shapeOf(unnamed.id)).toBe(
        "Linux · 2 vCPU · 4 GB · $0.12 an hour while awake · uses your Acme credits",
      );
    });

    it("omits an unnamed resting payer and keeps the funding clause for an unnamed awake payer", () => {
      viewAs("user-other");
      const resting = row("sbx-unnamed-rest", {
        state: "suspended",
        environmentId: TEAM_ENV,
        wakePayer: { userId: "user-hidden", displayName: null },
      });
      renderPanel([resting]);
      expect(clockOf(resting.id)).not.toContain("storage uses");
      expect(clockOf(resting.id)).not.toContain("a member");
      expect(shapeOf(resting.id)).toBe(
        "Linux · 2 vCPU · 4 GB · $0.12 an hour while awake · uses your Acme credits",
      );
      expect(shapeOf(resting.id)).not.toContain(
        "waking it makes you the payer",
      );
      expect(
        within(rowOf(resting.id)).queryByTestId(
          "sandboxes-row-payer-consequence",
        ),
      ).toBeNull();
      cleanup();

      const awake = row("sbx-unnamed-awake", {
        state: "awake",
        environmentId: TEAM_ENV,
        wakePayer: { userId: "user-hidden", displayName: null },
      });
      renderPanel([awake]);
      expect(within(rowOf(awake.id)).queryByText(/Paid by/)).toBeNull();
      expect(within(rowOf(awake.id)).queryByText(/a member/)).toBeNull();
      expect(shapeOf(awake.id)).toBe(
        "Linux · 2 vCPU · 4 GB · $0.12 an hour while awake · uses your Acme credits",
      );
    });

    it("tells only a member who isn't the payer that resuming makes them the payer", () => {
      const resting = row("sbx-resting", {
        state: "suspended",
        environmentId: TEAM_ENV,
        wakePayer: PAYER,
      });
      viewAs(PAYER.userId);
      renderPanel([resting]);
      expect(clockOf(resting.id)).toContain("storage uses your Acme credits");
      expect(clockOf(resting.id)).not.toContain("Storage uses");
      expect(shapeOf(resting.id)).toBe(
        "Linux · 2 vCPU · 4 GB · $0.12 an hour while awake · uses your Acme credits",
      );
      expect(shapeOf(resting.id)).not.toContain(
        "waking it makes you the payer",
      );
      expect(
        within(rowOf(resting.id)).queryByTestId(
          "sandboxes-row-payer-consequence",
        ),
      ).toBeNull();
      expect(within(rowOf(resting.id)).queryByText(/Paid by/)).toBeNull();
      cleanup();

      viewAs("user-other");
      renderPanel([resting]);
      expect(clockOf(resting.id)).toContain(
        "storage uses Priya's Acme credits",
      );
      expect(clockOf(resting.id)).not.toContain("Resuming changes the payer");
      expect(shapeOf(resting.id)).toBe(
        "Linux · 2 vCPU · 4 GB · $0.12 an hour while awake · waking it makes you the payer",
      );
      expect(
        within(rowOf(resting.id)).getByTestId("sandboxes-row-payer-consequence")
          .textContent,
      ).toBe("Resuming changes the payer to you.");
    });

    it("omits storage credits on a team row with no wake payer, and on a personal resting row names the viewer's credits", () => {
      viewAs("user-other");
      const unnamed = row("sbx-no-payer", {
        state: "stopped",
        environmentId: TEAM_ENV,
        wakePayer: null,
      });
      renderPanel([unnamed]);
      expect(clockOf(unnamed.id)).not.toContain("storage uses");
      expect(shapeOf(unnamed.id)).toBe(
        "Linux · 2 vCPU · 4 GB · $0.12 an hour while awake · uses your Acme credits",
      );
      expect(shapeOf(unnamed.id)).not.toContain(
        "waking it makes you the payer",
      );
      cleanup();

      useAuthStore.setState({ status: "signed-out", contextMetadata: null });
      mocks.configurations = [{ kind: "personal" }];
      host.environments = [descriptor(PERSONAL_ENV, "user", "u1", "owner")];
      useSettingsEnvironmentPickStore.setState({ pick: PERSONAL_PICK });
      const personal = row("sbx-personal-rest", { state: "suspended" });
      renderPanel([personal]);
      expect(clockOf(personal.id)).toContain("storage uses your credits");
      expect(shapeOf(personal.id)).not.toContain(
        "waking it makes you the payer",
      );
      expect(within(rowOf(personal.id)).queryByText(/Paid by/)).toBeNull();
    });

    it("keeps the frozen payer consequence once before a short Resume", () => {
      const frozen = row("sbx-frozen-payer", {
        state: "suspended",
        frozen: true,
        frozenAt: Date.UTC(2026, 9, 20),
        environmentId: TEAM_ENV,
        wakePayer: PAYER,
      });
      viewAs("user-other");
      renderPanel([frozen]);

      const frozenRow = rowOf(frozen.id);
      const consequence = within(frozenRow).getByTestId(
        "sandboxes-row-payer-consequence",
      );
      expect(consequence.textContent).toBe(
        "Priya's Acme credits ran out. Resuming changes the payer to you.",
      );
      expect(
        frozenRow.textContent.match(/Resuming changes the payer to you\./gu),
      ).toHaveLength(1);
      expect(frozenRow.textContent).not.toContain(
        "waking it makes you the payer",
      );
      expect(frozenRow.textContent).not.toContain("storage uses");
      expect(
        within(frozenRow).getByText(
          "Linux · 2 vCPU · 4 GB · $0.12 an hour while awake",
        ),
      ).toBeTruthy();
      expect(within(frozenRow).queryByText(/Paid by/)).toBeNull();
      expect(within(frozenRow).getByTestId("row-primary").textContent).toBe(
        "Resume",
      );
      expect(
        within(frozenRow).getByTestId("sandboxes-row-clock").textContent,
      ).toBe(
        `Will be removed on ${formatSandboxDate(frozenDestroyAt(frozen.frozenAt ?? 0), false)}`,
      );
    });
  });

  it.each([false, true])(
    "shows another member's destroy before frozen=%s, then removes the row when the list drops it",
    (frozen) => {
      mocks.configurations = [
        {
          kind: "team",
          teamId: "t1",
          teamName: "Acme",
          environmentId: TEAM_ENV,
        },
      ];
      mocks.sessionFailed = true;
      const sandbox = row("sbx-gone", {
        state: "destroying",
        frozen,
        environmentId: TEAM_ENV,
      });
      mocks.sandboxes = [sandbox];
      const panel = renderUi(<SandboxesSettingsPanel />);
      const destroying = rowOf(sandbox.id);
      expect(
        within(destroying).getByTestId("sandboxes-row-state").textContent,
      ).toBe("Destroying");
      if (frozen) {
        expect(
          within(destroying).queryByTestId("sandboxes-row-clock"),
        ).toBeNull();
      } else {
        expect(
          within(destroying).getByTestId("sandboxes-row-clock").textContent,
        ).toBe("Pending.");
      }
      expect(
        within(destroying).queryByTestId("sandboxes-row-sessions"),
      ).toBeNull();

      // GET /api/sandboxes excludes destroyed rows.
      mocks.sandboxes = [];
      panel.rerender(<SandboxesSettingsPanel />);
      expect(screen.queryByTestId("sandboxes-row")).toBeNull();
    },
  );

  it("keeps Resume pending through the awake ACK until the host reports", () => {
    const sandbox = row("sbx-resume", { state: "resuming" });
    mocks.sandboxes = [sandbox];
    mocks.resumePending = true;
    // A previous wake's count must not accompany this pending line.
    mocks.report = { kind: "stale", count: 4, at: Date.now() };
    const panel = renderUi(<SandboxesSettingsPanel />);
    const clock = (): string =>
      within(rowOf(sandbox.id)).getByTestId("sandboxes-row-clock").textContent;
    expect(clock()).toBe("Pending.");
    expect(
      within(rowOf(sandbox.id)).queryByTestId("sandboxes-row-sessions"),
    ).toBeNull();

    mocks.sandboxes = [{ ...sandbox, state: "awake" }];
    mocks.sessionFailed = true;
    panel.rerender(<SandboxesSettingsPanel />);
    expect(clock()).toBe("Pending.");

    mocks.resumePending = false;
    mocks.sessionFailed = false;
    mocks.report = liveSessionReport({ agents: [], terminals: [] }, false);
    panel.rerender(<SandboxesSettingsPanel />);
    expect(clock()).not.toBe("Pending.");
    expect(
      within(rowOf(sandbox.id)).getByTestId("sandboxes-row-sessions")
        .textContent,
    ).toContain("0 sessions running");

    // Lifecycle state changes always take over from the pending wake.
    mocks.resumePending = false;
    mocks.sandboxes = [{ ...sandbox, state: "stopped" }];
    panel.rerender(<SandboxesSettingsPanel />);
    expect(clock()).toContain("Stopped");
  });

  it("yields an unanswered Resume to the lifecycle-confirmed unreachable line", async () => {
    useAuthStore.setState({
      status: "signed-in",
      contextMetadata: { userId: "u-viewer", username: "viewer" },
    });
    mocks.realSessions = true;
    const binding = createFakeSandboxBinding();
    mocks.binding = binding;
    const resuming = row("sbx-resume-unreachable", { state: "resuming" });
    const awake = { ...resuming, state: "awake" } satisfies SandboxSummary;
    const online = sandboxHostEntry(resuming.hostId, null);
    mocks.entry = online;
    const confirmation = Promise.withResolvers<SandboxListFetchResult>();
    binding.auth.listSandboxes
      .mockResolvedValueOnce({
        kind: "ok",
        response: { sandboxes: [resuming] },
      })
      .mockResolvedValueOnce({ kind: "ok", response: { sandboxes: [awake] } })
      .mockReturnValue(confirmation.promise);
    const page = hostPage();
    const panel = renderUi(<SandboxesSettingsPanel />);
    const clock = (): string =>
      within(rowOf(resuming.id)).getByTestId("sandboxes-row-clock").textContent;
    await waitFor(() => expect(host.status).toHaveBeenCalledTimes(1));
    expect(clock()).toBe("Pending.");

    await act(() =>
      page.queryClient.invalidateQueries({
        queryKey: sandboxQueryKeys.list(binding.auth, "u-viewer"),
      }),
    );
    expect(clock()).toBe("Pending.");

    const offline: RemoteHostDirectoryEntry = {
      ...online,
      transportDialability: "not-dialable",
      remoteStatus: { ...online.remoteStatus, connectivity: "offline" },
    };
    mocks.entry = offline;
    panel.rerender(<SandboxesSettingsPanel />);
    await waitFor(() =>
      expect(binding.auth.listSandboxes).toHaveBeenCalledTimes(3),
    );
    // Losing the host alone does not replace the pending lifecycle line.
    expect(clock()).toBe("Pending.");
    await act(async () => {
      confirmation.resolve({ kind: "ok", response: { sandboxes: [awake] } });
      await confirmation.promise;
    });
    // host.status is still unanswered; the fresh lifecycle read owns this verdict.
    await waitFor(() =>
      expect(clock()).toBe("Running, but Traycer can't connect"),
    );
  });

  it.each(["destroying", "awake", "destroyed"] as const)(
    "checks a stale awake row's lifecycle on host loss before presenting %s",
    async (nextState) => {
      useAuthStore.setState({
        status: "signed-in",
        contextMetadata: { userId: "u-viewer", username: "viewer" },
      });
      const binding = createFakeSandboxBinding();
      mocks.binding = binding;
      const sandbox = row("sbx-team", {
        state: "awake",
        environmentId: TEAM_ENV,
      });
      mocks.configurations = [
        {
          kind: "team",
          teamId: "t1",
          teamName: "Acme",
          environmentId: TEAM_ENV,
        },
      ];
      const online = sandboxHostEntry(sandbox.hostId, {
        id: "t1",
        name: "Acme",
      });
      mocks.entry = online;
      binding.auth.listSandboxes.mockResolvedValueOnce({
        kind: "ok",
        response: { sandboxes: [sandbox] },
      });
      const answer = Promise.withResolvers<SandboxListFetchResult>();
      binding.auth.listSandboxes.mockReturnValue(answer.promise);
      const page = hostPage();
      const panel = renderUi(<SandboxesSettingsPanel />);
      const initialRow = await screen.findByTestId("sandboxes-row");
      const lifecycle = within(initialRow).getByTestId(
        "sandboxes-row-clock",
      ).textContent;
      expect(page.queryClient.getMutationCache().getAll()).toEqual([]);

      // Both a missing row and an offline registry row must check the server.
      const gone: RemoteHostDirectoryEntry | null =
        nextState === "awake"
          ? {
              ...online,
              transportDialability: "not-dialable",
              remoteStatus: { ...online.remoteStatus, connectivity: "offline" },
            }
          : null;
      mocks.entry = gone;
      panel.rerender(<SandboxesSettingsPanel />);
      await waitFor(() =>
        expect(binding.auth.listSandboxes).toHaveBeenCalledTimes(2),
      );
      expect(
        within(rowOf(sandbox.id)).getByTestId("sandboxes-row-clock")
          .textContent,
      ).toBe(lifecycle);

      // A flapping directory joins the outstanding read, never cancels/restarts it.
      mocks.entry = online;
      panel.rerender(<SandboxesSettingsPanel />);
      mocks.entry = gone;
      panel.rerender(<SandboxesSettingsPanel />);
      expect(binding.auth.listSandboxes).toHaveBeenCalledTimes(2);
      expect(
        within(rowOf(sandbox.id)).getByTestId("sandboxes-row-clock")
          .textContent,
      ).toBe(lifecycle);

      await act(async () => {
        answer.resolve({
          kind: "ok",
          response: {
            sandboxes:
              nextState === "destroyed"
                ? []
                : [{ ...sandbox, state: nextState }],
          },
        });
        await answer.promise;
      });
      if (nextState === "destroyed") {
        await waitFor(() =>
          expect(screen.queryByTestId("sandboxes-row")).toBeNull(),
        );
      } else {
        const expected =
          nextState === "destroying"
            ? "Pending."
            : "Running, but Traycer can't connect";
        await waitFor(() =>
          expect(
            within(rowOf(sandbox.id)).getByTestId("sandboxes-row-clock")
              .textContent,
          ).toBe(expected),
        );
        panel.rerender(<SandboxesSettingsPanel />);
        expect(binding.auth.listSandboxes).toHaveBeenCalledTimes(2);
        if (nextState === "destroying") {
          binding.auth.listSandboxes.mockResolvedValue({
            kind: "ok",
            response: { sandboxes: [] },
          });
          await act(() =>
            page.queryClient.invalidateQueries({
              queryKey: authQueryKeys.registeredHostsAll(),
            }),
          );
          await waitFor(() =>
            expect(screen.queryByTestId("sandboxes-row")).toBeNull(),
          );
        }
      }
    },
  );

  it("keeps lifecycle after a failed status check's list refresh, then uses the next registry read", async () => {
    useAuthStore.setState({
      status: "signed-in",
      contextMetadata: { userId: "u-viewer", username: "viewer" },
    });
    const binding = createFakeSandboxBinding();
    mocks.binding = binding;
    const sandbox = row("sbx-status", { state: "awake" });
    mocks.entry = sandboxHostEntry(sandbox.hostId, null);
    binding.auth.listSandboxes.mockResolvedValueOnce({
      kind: "ok",
      response: { sandboxes: [sandbox] },
    });
    const answer = Promise.withResolvers<SandboxListFetchResult>();
    binding.auth.listSandboxes.mockReturnValue(answer.promise);
    const page = hostPage();
    const panel = renderUi(<SandboxesSettingsPanel />);
    const initial = await screen.findByTestId("sandboxes-row");
    const lifecycle = within(initial).getByTestId(
      "sandboxes-row-clock",
    ).textContent;
    mocks.sessionFailed = true;
    panel.rerender(<SandboxesSettingsPanel />);
    await waitFor(() =>
      expect(binding.auth.listSandboxes).toHaveBeenCalledTimes(2),
    );
    expect(
      within(rowOf(sandbox.id)).getByTestId("sandboxes-row-clock").textContent,
    ).toBe(lifecycle);
    await act(async () => {
      answer.resolve({ kind: "network-error", detail: "offline" });
      await answer.promise;
    });
    await waitFor(() =>
      expect(
        page.queryClient.getQueryState(
          sandboxQueryKeys.list(binding.auth, "u-viewer"),
        )?.status,
      ).toBe("error"),
    );
    expect(
      within(rowOf(sandbox.id)).getByTestId("sandboxes-row-clock").textContent,
    ).toBe(lifecycle);

    binding.auth.listSandboxes.mockImplementation(() =>
      Promise.resolve({ kind: "ok", response: { sandboxes: [sandbox] } }),
    );
    await act(() =>
      page.queryClient.invalidateQueries({
        queryKey: authQueryKeys.registeredHostsAll(),
      }),
    );
    await waitFor(() =>
      expect(
        within(rowOf(sandbox.id)).getByTestId("sandboxes-row-clock")
          .textContent,
      ).toBe("Running, but Traycer can't connect"),
    );
    expect(binding.auth.listSandboxes).toHaveBeenCalledTimes(3);
  });

  describe("a held team pod Retry belongs to its mounted row", () => {
    const POD_ROW = "sbx-pod";
    const ACME: SandboxPageConfiguration = {
      kind: "team",
      teamId: "t-acme",
      teamName: "Acme",
      environmentId: "env-acme",
    };
    const BETA: SandboxPageConfiguration = {
      kind: "team",
      teamId: "t-beta",
      teamName: "Beta",
      environmentId: "env-beta",
    };

    /** Acme's failed pod in a separate team configuration from Beta. */
    function mountHeldRetry(): {
      readonly binding: FakeSandboxBinding;
      readonly answerLookup: () => void;
    } {
      const binding = createFakeSandboxBinding();
      mocks.binding = binding;
      mocks.realActions = true;
      mocks.realAutomation = true;
      mocks.configurations = [{ kind: "personal" }, ACME, BETA];
      useAuthStore.setState({
        status: "signed-in",
        contextMetadata: { userId: "u1", username: "ada" },
      });
      const pod = row(POD_ROW, {
        kind: "automation",
        state: "failed",
        environmentId: "env-acme",
        displayName: "Automations",
      });
      binding.auth.listSandboxes.mockResolvedValue({
        kind: "ok",
        response: { sandboxes: [pod] },
      });
      const lookups: Array<() => void> = [];
      binding.auth.getSandboxAutomation.mockImplementation((environmentId) => {
        if (environmentId !== "env-acme") {
          return Promise.resolve({
            kind: "ok",
            automation: { available: true, sandbox: null, pods: [] },
          });
        }
        return new Promise((resolve) => {
          lookups.push(() =>
            resolve({
              kind: "ok",
              automation: {
                available: true,
                sandbox: null,
                pods: [
                  {
                    sandbox: pod,
                    ordinal: 2,
                    liveShells: 0,
                    headroom: 1,
                  },
                ],
              },
            }),
          );
        });
      });
      binding.auth.openSandboxAutomation.mockResolvedValue({
        kind: "ok",
        sandbox: { ...pod, state: "awake" },
        settled: true,
      });
      useSettingsEnvironmentPickStore
        .getState()
        .setPick({ kind: "team", environmentId: "env-acme" });
      renderUi(<SandboxesSettingsPanel />);
      return {
        binding,
        answerLookup: () => {
          for (const answer of lookups) answer();
        },
      };
    }

    async function clickRetryHeldInLookup(binding: FakeSandboxBinding) {
      await userEvent.click(await screen.findByTestId("sandbox-row-retry"));
      await waitFor(() => {
        expect(binding.auth.getSandboxAutomation).toHaveBeenCalled();
      });
    }

    /** The held Retry's mutation, with any wake it starts, has finished. */
    async function settleHeldRetry(userId: string): Promise<void> {
      const client = harness?.queryClient;
      if (client === undefined) throw new Error("no page is mounted");
      await waitFor(() => {
        expect(
          client.isMutating({
            mutationKey: sandboxMutationKeys.automationRetry(
              userId,
              "env-acme",
              POD_ROW,
            ),
            exact: true,
          }),
        ).toBe(0);
      });
    }

    it("wakes nothing when the page switches configuration before the lookup answers", async () => {
      const { binding, answerLookup } = mountHeldRetry();
      await clickRetryHeldInLookup(binding);

      act(() => {
        useSettingsEnvironmentPickStore
          .getState()
          .setPick({ kind: "team", environmentId: "env-beta" });
      });
      expect(screen.queryByTestId("sandbox-row-retry")).toBeNull();
      answerLookup();
      await settleHeldRetry("u1");

      expect(binding.auth.openSandboxAutomation).not.toHaveBeenCalled();
      expect(useLandingPanelStore.getState().tabs).toHaveLength(0);
    });

    it("wakes nothing when the filter hides the clicked row before the lookup answers", async () => {
      const { binding, answerLookup } = mountHeldRetry();
      await clickRetryHeldInLookup(binding);

      await userEvent.type(screen.getByTestId("sandboxes-search"), "zzz");
      expect(screen.queryByTestId("sandbox-row-retry")).toBeNull();
      answerLookup();
      await settleHeldRetry("u1");

      expect(binding.auth.openSandboxAutomation).not.toHaveBeenCalled();
      expect(useLandingPanelStore.getState().tabs).toHaveLength(0);

      await userEvent.clear(screen.getByTestId("sandboxes-search"));
      const remountedRetry =
        await screen.findByTestId<HTMLButtonElement>("sandbox-row-retry");
      expect(remountedRetry.disabled).toBe(false);
      expect(screen.queryByRole("alert")).toBeNull();

      await userEvent.click(remountedRetry);
      answerLookup();
      await waitFor(() => {
        expect(binding.auth.openSandboxAutomation).toHaveBeenCalledTimes(1);
      });
      expect(binding.auth.openSandboxAutomation).toHaveBeenCalledWith({
        environmentId: "env-acme",
        ordinal: 2,
      });
      await waitFor(() => {
        expect(binding.auth.openSandboxAutomation).toHaveResolved();
      });
      await settleHeldRetry("u1");
      expect(useLandingPanelStore.getState().tabs).toHaveLength(0);
    });

    it("wakes nothing when the row unmounts and the account changes before the lookup answers", async () => {
      const { binding, answerLookup } = mountHeldRetry();
      await clickRetryHeldInLookup(binding);

      act(() => {
        useSettingsEnvironmentPickStore
          .getState()
          .setPick({ kind: "team", environmentId: "env-beta" });
      });
      act(() => {
        useAuthStore.setState({
          status: "signed-in",
          contextMetadata: { userId: "u2", username: "grace" },
        });
      });
      answerLookup();
      await settleHeldRetry("u1");

      expect(binding.auth.openSandboxAutomation).not.toHaveBeenCalled();
      expect(useLandingPanelStore.getState().tabs).toHaveLength(0);
    });
  });

  describe("an Automations host that is not created yet", () => {
    const NOT_CREATED: SandboxAutomationResponse = {
      available: true,
      sandbox: null,
      pods: [],
    };
    const OPENED = row("sbx-auto", {
      kind: "automation",
      hostId: "auto-host",
      state: "awake",
    });

    function unstarted(): HTMLElement {
      return screen.getByTestId("sandboxes-row-automations-unstarted");
    }

    it("lists a released Automations row with Open terminal and no menu, and counts it in the header", () => {
      mocks.automation = NOT_CREATED;
      renderPanel([row("sbx-a", {}), row("sbx-b", {})]);

      const automations = unstarted();
      expect(
        within(automations).getByTestId("sandboxes-row-name").textContent,
      ).toBe("Automations");
      expect(
        within(automations).getByTestId("sandboxes-row-state").textContent,
      ).toBe("Not running");
      expect(
        within(automations).getByTestId("sandboxes-row-clock").textContent,
      ).toBe("Files are kept; starts when you open a shell.");
      expect(
        within(automations).getAllByText("Automations").length,
      ).toBeGreaterThan(1);
      expect(
        within(automations).getByText(
          "Runs your long-running shells · agents can't run here · no charge",
        ),
      ).toBeTruthy();
      expect(
        within(automations).getByRole("button", { name: "Open terminal" }),
      ).toBeDefined();
      expect(
        within(automations).queryByRole("button", {
          name: /^More actions/,
        }),
      ).toBeNull();
      expect(screen.getByTestId("sandboxes-list-header").textContent).toContain(
        "2 sandboxes and Automations",
      );
    });

    it("badges a listed Automations row beside its state", () => {
      renderPanel([OPENED]);
      const listed = rowOf(OPENED.id);
      expect(
        within(listed).getByTestId("sandboxes-row-state").textContent,
      ).toBe("Awake");
      expect(within(listed).getByText("Automations")).toBeTruthy();
    });

    it("describes a team's unstarted Automations host without an hourly price", () => {
      mocks.configurations = [
        { kind: "personal" },
        {
          kind: "team",
          teamId: "team-1",
          teamName: "Acme",
          environmentId: TEAM_ENV,
        },
      ];
      host.environments = [
        descriptor(PERSONAL_ENV, "user", "u1", "owner"),
        descriptor(TEAM_ENV, "organization", "team-1", "editor"),
      ];
      useSettingsEnvironmentPickStore.setState({
        pick: { kind: "team", environmentId: TEAM_ENV },
      });
      mocks.automation = NOT_CREATED;
      renderPanel([]);

      expect(
        within(unstarted()).getByText(
          "Runs Acme's long-running shells · agents can't run here · uses Acme's shared credits, not a member's allowance",
        ),
      ).toBeTruthy();
      expect(
        within(unstarted()).getByTestId("sandboxes-row-state").textContent,
      ).toBe("Not running");
    });

    it("leaves the row out where a filter excludes it", () => {
      mocks.automation = NOT_CREATED;
      renderPanel([row("sbx-a", {})]);
      expect(
        screen.getByTestId("sandboxes-row-automations-unstarted"),
      ).toBeDefined();

      fireEvent.change(screen.getByTestId("sandboxes-search"), {
        target: { value: "build" },
      });

      expect(
        screen.queryByTestId("sandboxes-row-automations-unstarted"),
      ).toBeNull();
    });

    it("stops listing it once the control plane lists the host", () => {
      mocks.automation = NOT_CREATED;
      renderPanel([OPENED]);

      expect(
        screen.queryByTestId("sandboxes-row-automations-unstarted"),
      ).toBeNull();
    });

    it("reserves the first terminal pane and closes Settings before Automations enrollment", () => {
      mocks.automation = NOT_CREATED;
      renderPanel([row("sbx-a", {})]);
      const button = within(unstarted()).getByRole("button", {
        name: "Open terminal",
      });
      fireEvent.click(button);
      const pending = useLandingPanelStore.getState().placeholder;
      expect(pending?.automation).toMatchObject({
        existing: null,
        teamEnvironmentId: null,
      });
      expect(mocks.close).toHaveBeenCalledTimes(1);
      expect(useLandingPanelStore.getState().fallbackLayout).toMatchObject({
        panelOpen: true,
        maximized: true,
      });
      // Network work belongs to the pane, which this Settings test does not mount.
      expect(mocks.openAutomation).not.toHaveBeenCalled();
      fireEvent.click(button);
      expect(useLandingPanelStore.getState().placeholder).toBe(pending);
      expect(mocks.close).toHaveBeenCalledTimes(1);
      expect(
        screen.queryByText("Couldn't open a terminal on Automations."),
      ).toBeNull();
    });

    it("keeps the pane request through row replacement and Settings unmount", () => {
      mocks.automation = NOT_CREATED;
      const panel = renderUi(<SandboxesSettingsPanel />);
      fireEvent.click(
        within(unstarted()).getByRole("button", { name: "Open terminal" }),
      );
      const pending = useLandingPanelStore.getState().placeholder;
      mocks.automation = { available: true, sandbox: OPENED, pods: [] };
      mocks.sandboxes = [OPENED];
      panel.rerender(<SandboxesSettingsPanel />);
      expect(
        screen.queryByTestId("sandboxes-row-automations-unstarted"),
      ).toBeNull();
      expect(useLandingPanelStore.getState().placeholder).toBe(pending);
      panel.unmount();
      expect(useLandingPanelStore.getState().placeholder).toBe(pending);
      expect(useSurfaceHostSelectionStore.getState().selections).toEqual({});
    });
  });

  describe("a team's usage link", () => {
    it("opens the team's usage under its environment", async () => {
      mocks.configurations = [
        { kind: "personal" },
        {
          kind: "team",
          teamId: "team-1",
          teamName: "acme",
          environmentId: TEAM_ENV,
        },
      ];
      host.environments = [
        descriptor(PERSONAL_ENV, "user", "u1", "owner"),
        descriptor(TEAM_ENV, "organization", "team-1", "owner"),
      ];
      useSettingsEnvironmentPickStore.setState({
        pick: { kind: "team", environmentId: TEAM_ENV },
      });
      renderPanel([]);

      fireEvent.click(await screen.findByTestId("sandboxes-team-usage"));

      expect(mocks.openLink).toHaveBeenCalledWith(
        "https://platform.example.dev/team/acme/environment/usage",
        "account",
        null,
      );
    });
  });
});
