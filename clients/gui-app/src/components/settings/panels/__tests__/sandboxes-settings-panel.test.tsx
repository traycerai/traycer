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
  sandboxSummaryFixture,
  terminalSessionFixture,
} from "@/hooks/sandboxes/__tests__/sandbox-fixtures";
import {
  sandboxPeriodLabel,
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
  useHostClientForHostId: () => null,
}));
vi.mock("@/hooks/host/use-host-directory-entry", () => ({
  useHostDirectoryEntry: () => mocks.entry,
}));
vi.mock("@/hooks/sandboxes/use-sandbox-control-unavailable-reason", () => ({
  useSandboxControlUnavailableReason: () => null,
}));
vi.mock("@/hooks/sandboxes/use-sandbox-session-report", () => ({
  useSandboxSessionReport: () => ({
    report: mocks.report,
    failed: mocks.sessionFailed,
  }),
  useSandboxRowSessionReport: () => ({
    report: mocks.report,
    failed: mocks.sessionFailed,
    resumePending: mocks.resumePending,
  }),
}));
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
            {primary === null
              ? ""
              : sandboxRowActionLabel(primary, props.configuration)}
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
    mocks.listed = true;
    mocks.realActions = false;
    mocks.configurations = [{ kind: "personal" }];
    mocks.catalogue = null;
    mocks.report = { kind: "unknown" };
    mocks.sessionFailed = false;
    mocks.resumePending = false;
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

  it("shows … for the default shape only while the catalogue has not answered", () => {
    renderPanel([]);
    expect(screen.getByTestId("sandboxes-defaults-shape").textContent).toBe(
      "…",
    );
  });

  it("says sandboxes can't be created once the catalogue answers with no shape", async () => {
    mocks.catalogue = { providers: [] };
    host.environments = [descriptor(PERSONAL_ENV, "user", "u1", "viewer")];
    renderPanel([]);
    await waitFor(() => {
      expect(screen.getByTestId("sandboxes-defaults-shape").textContent).toBe(
        SANDBOXES_CANT_BE_CREATED,
      );
    });
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
            screen.getByTestId("sandboxes-defaults-shape").textContent,
          ).toContain("4 vCPU");
        });
        seen.push(
          [
            "sandboxes-defaults-shape",
            "sandboxes-defaults-idle",
            "sandboxes-defaults-resting",
          ]
            .map((id) => screen.getByTestId(id).textContent)
            .join("|"),
        );
        cleanup();
      }

      expect(seen[0]).toBe(seen[1]);
      expect(seen[0]).toContain(sandboxPeriodLabel(45));
      expect(seen[0]).toContain(KEPT_UNTIL_YOU_DESTROY_IT);
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
          screen.getByTestId("sandboxes-defaults-shape").textContent,
        ).toContain("2 vCPU");
      });
      expect(screen.getByTestId("sandboxes-defaults-idle").textContent).toBe(
        sandboxPeriodLabel(30),
      );
      expect(screen.getByTestId("sandboxes-defaults-resting").textContent).toBe(
        sandboxPeriodLabel(7 * 24 * 60),
      );
    });

    it("introduces Personal's defaults as what each new Personal sandbox starts with", async () => {
      mocks.catalogue = CATALOGUE;
      host.environments = [descriptor(PERSONAL_ENV, "user", "u1", "viewer")];
      renderPanel([]);

      const heading = await screen.findByRole("heading", {
        name: "Your defaults for new sandboxes",
      });
      expect(heading.nextElementSibling?.textContent).toBe(
        "Each new Personal sandbox starts with these. Sandboxes you already have aren't destroyed after resting until you change their Idle settings.",
      );
    });

    it("introduces a team's defaults as what each new team sandbox starts with", async () => {
      viewTeamAs("editor", { cpus: 8, memoryMb: 16_384, idleMinutes: 90 });
      renderPanel([]);

      const heading = await screen.findByRole("heading", {
        name: "Acme's defaults for new sandboxes",
      });
      expect(heading.nextElementSibling?.textContent).toBe(
        "Shared by Acme · editors can change them · not a spending limit. Each new Acme sandbox starts with these. Sandboxes you already have aren't destroyed after resting until you change their Idle settings.",
      );
    });

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

      expect(await screen.findByText("Ada, Bo can change them")).toBeTruthy();
      expect(screen.queryByTestId("sandboxes-defaults-form")).toBeNull();
      expect(
        screen.queryByRole("button", { name: "Save defaults" }),
      ).toBeNull();
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
        screen.getByTestId("sandboxes-defaults-shape-select").textContent,
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

    it("reopens the form on the configuration switched to, and saves to it, at the same revision", async () => {
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
        await screen.findByTestId("sandboxes-defaults-idle-input"),
      ).toHaveProperty("value", "45");
      act(() => {
        useSettingsEnvironmentPickStore.setState({ pick: PERSONAL_PICK });
      });

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
        await screen.findByText("Your defaults for new sandboxes"),
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
      "frozen-1": ["Frozen", "Add credits ↗"],
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
    }
  });

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
      ).toContain("1 session");
    });

    it("reorders from current activity when a public state changes", () => {
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
      expect(names()).toEqual(["sleeping", "newer", "older"]);
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

  it("narrows the list by the search and by the state filter, with a count badge", () => {
    renderPanel([
      row("alpha", { state: "awake" }),
      row("beta", { state: "suspended" }),
      row("gamma", { state: "suspended" }),
    ]);
    expect(names().sort()).toEqual(["alpha", "beta", "gamma"]);

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

    it.each(["all", "awake", "suspended", "stopped", "frozen", "failed"])(
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
        "Couldn't destroy idle-b · SBX-0413",
      );
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

  it("says an agent started a sandbox an agent created and the person kept, not that they did", () => {
    useAuthStore.setState({
      status: "signed-in",
      contextMetadata: { userId: "user-me", username: "me" },
    });
    renderPanel([
      row("sbx-kept", {
        burst: false,
        createdByAgentId: "agent-1",
        createdBy: null,
        keptBy: { userId: "user-me", displayName: "Me" },
      }),
    ]);

    const kept = rowOf("sbx-kept");
    expect(within(kept).getByText("Started by an agent")).toBeDefined();
    expect(within(kept).getByText("Kept by you")).toBeDefined();
    expect(within(kept).queryByText("Started by you")).toBeNull();
    useAuthStore.setState({ status: "signed-out", contextMetadata: null });
  });

  describe("a row's running sessions", () => {
    const AWAKE = row("sbx-awake", { state: "awake" });

    it("names each session on the host as a pill beside the count, an idle terminal included", () => {
      mocks.report = liveSessionReport(
        {
          agents: [agentSessionFixture({ name: "Planner", working: true })],
          terminals: [terminalSessionFixture({ name: "make watch" })],
        },
        true,
      );
      renderPanel([AWAKE]);

      const line = within(rowOf("sbx-awake")).getByTestId(
        "sandboxes-row-sessions",
      );
      expect(line.textContent).toBe("2 sessions runningPlannermake watch");
      expect(
        within(line)
          .getAllByTestId("sandboxes-row-session-pill")
          .map((pill) => pill.textContent),
      ).toEqual(["Planner", "make watch"]);
    });

    it("draws no pills when the host runs nothing", () => {
      mocks.report = liveSessionReport({ agents: [], terminals: [] }, false);
      renderPanel([AWAKE]);

      expect(screen.queryAllByTestId("sandboxes-row-session-pill")).toEqual([]);
    });

    it("says the count is unknown, never a zero, when no report is held", () => {
      renderPanel([AWAKE]);

      expect(
        within(rowOf("sbx-awake")).getByTestId("sandboxes-row-sessions")
          .textContent,
      ).toBe("Sessions unknown · no report yet");
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
      cleanup();

      viewAs("user-other");
      renderPanel([awake]);
      expect(within(rowOf(awake.id)).getByText("Paid by Priya")).toBeDefined();
    });

    it("tells only a member who isn't the payer that resuming makes them the payer", () => {
      const resting = row("sbx-resting", {
        state: "suspended",
        environmentId: TEAM_ENV,
        wakePayer: PAYER,
      });
      viewAs(PAYER.userId);
      renderPanel([resting]);
      expect(clockOf(resting.id)).toMatch(
        / · Storage uses your Acme credits\.$/,
      );
      cleanup();

      viewAs("user-other");
      renderPanel([resting]);
      expect(clockOf(resting.id)).toMatch(
        / · Storage uses Priya's Acme credits\. Resuming changes the payer to you\.$/,
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
      expect(
        within(destroying).getByTestId("sandboxes-row-clock").textContent,
      ).toBe("Destroying · pending");
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
    expect(clock()).toBe("Resuming · pending");
    expect(
      within(rowOf(sandbox.id)).queryByTestId("sandboxes-row-sessions"),
    ).toBeNull();

    mocks.sandboxes = [{ ...sandbox, state: "awake" }];
    mocks.sessionFailed = true;
    panel.rerender(<SandboxesSettingsPanel />);
    expect(clock()).toBe("Resuming · pending");

    mocks.resumePending = false;
    mocks.sessionFailed = false;
    mocks.report = liveSessionReport({ agents: [], terminals: [] }, false);
    panel.rerender(<SandboxesSettingsPanel />);
    expect(clock()).toContain("Awake");
    expect(
      within(rowOf(sandbox.id)).getByTestId("sandboxes-row-sessions")
        .textContent,
    ).toBe("0 sessions running");

    // Lifecycle state changes always take over from the pending wake.
    mocks.resumePending = false;
    mocks.sandboxes = [{ ...sandbox, state: "stopped" }];
    panel.rerender(<SandboxesSettingsPanel />);
    expect(clock()).toContain("Stopped");
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
            ? "Destroying · pending"
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
      ).toBe("Suspended");
      expect(
        within(automations).getByTestId("sandboxes-row-clock").textContent,
      ).toBe("Suspended · files kept · the next shell starts it");
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
