import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { HOST_SANDBOX_STATES } from "@traycer/protocol/host/host-status";
import type { HostListItem } from "@traycer/protocol/host/host-status";
import type { SandboxEgressEvent } from "@traycer/protocol/host/sandbox-egress";
import type {
  SandboxGrant,
  SandboxGrantsSummary,
} from "@traycer/protocol/host/sandbox-secrets";
import { hostListItemToDirectoryEntry } from "@traycer-clients/shared/host-client/remote-fetcher";
import type {
  SandboxCatalogue,
  SandboxCost,
  UserSandboxCost,
} from "@traycer/protocol/host/sandbox-control";
import {
  frozenDestroyAt,
  type SandboxRunwayWarning,
} from "@/lib/sandboxes/sandbox-balance";
import {
  createFakeSandboxBinding,
  refusal,
  type FakeSandboxBinding,
} from "@/hooks/sandboxes/__tests__/sandbox-binding-fixture";
import { sandboxSummaryFixture } from "@/hooks/sandboxes/__tests__/sandbox-fixtures";
import { useAuthStore } from "@/stores/auth/auth-store";
import { SANDBOX_VERB_FETCH_TIMEOUT_MS } from "@traycer-clients/shared/host-client/sandbox-control";

const mocks = vi.hoisted(() => ({
  binding: null as FakeSandboxBinding | null,
  toastSuccess: vi.fn(),
  toastInfo: vi.fn(),
  toastFromAuthError: vi.fn<(error: Error, title: string) => void>(),
  catalogue: null as SandboxCatalogue | null,
  costs: null as UserSandboxCost | null,
  warning: { kind: "none" } as SandboxRunwayWarning,
  /** `IRunnerHost.sandboxControlUnavailableReason`; `null` reaches the control plane. */
  unavailableReason: null as string | null,
  /** What `useSandboxEgressEvents` returns; the hook spy records its argument. */
  egressEvents: [] as readonly SandboxEgressEvent[],
  useEgressEvents: vi.fn<(hostId: string | null) => void>(),
  /** What `useHostSupportsMethod` answers for every method. */
  supportsMethod: false,
  useSupportsMethod: vi.fn<(hostId: string | null, method: string) => void>(),
  repairPending: false,
  repairMutate: vi.fn<(variables: object, options: object) => void>(),
  /** What `useSandboxGrants` returns; the hook spy records its argument. */
  grantsData: undefined as SandboxGrantsSummary | null | undefined,
  grantsError: false,
  grantsFetching: false,
  grantsRefetch: vi.fn<() => void>(),
  useGrants:
    vi.fn<(environmentId: string | null, hostId: string | null) => void>(),
  openEnvironmentPage:
    vi.fn<
      (address: {
        readonly configurationId: string | null;
        readonly pageId: string;
      }) => void
    >(),
}));

vi.mock("sonner", () => ({
  toast: { success: mocks.toastSuccess, info: mocks.toastInfo },
}));
vi.mock("@/lib/auth-error-toast", () => ({
  toastFromAuthError: mocks.toastFromAuthError,
}));
vi.mock("@/lib/host", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/host")>()),
  useHostBinding: () => mocks.binding,
}));
vi.mock("@/providers/use-runner-host", () => ({
  useRunnerHost: () => ({ refreshHostFleet: vi.fn() }),
  useRunnerHostOrNull: () => ({
    sandboxControlUnavailableReason: mocks.unavailableReason,
  }),
}));
vi.mock("@/lib/host/fleet-refresh", () => ({ requestFleetRefresh: vi.fn() }));
// The destroy dialog reads the host's running-session count; this suite has no
// host runtime.
vi.mock("@/hooks/sandboxes/use-sandbox-session-report", () => ({
  useSandboxSessionReport: () => ({
    report: { kind: "unknown" },
    failed: false,
  }),
}));
// The secrets section's live parts talk to the sandbox host itself; the card's
// own suite has no host runtime, and they have their own tests.
vi.mock("@/hooks/sandboxes/use-sandbox-egress-events", () => ({
  useSandboxEgressEvents: (hostId: string | null) => {
    mocks.useEgressEvents(hostId);
    return mocks.egressEvents;
  },
}));
vi.mock("@/hooks/sandboxes/use-sandbox-grants-query", () => ({
  useSandboxGrants: (environmentId: string | null, hostId: string | null) => {
    mocks.useGrants(environmentId, hostId);
    return {
      data: mocks.grantsData,
      isError: mocks.grantsError,
      isFetching: mocks.grantsFetching,
      refetch: mocks.grantsRefetch,
    };
  },
}));
vi.mock("@/hooks/host/use-host-supports-method", () => ({
  useHostSupportsMethod: (hostId: string | null, method: string) => {
    mocks.useSupportsMethod(hostId, method);
    return mocks.supportsMethod;
  },
}));
vi.mock(
  "@/hooks/sandboxes/use-sandbox-repair-guest-configuration-mutation",
  () => ({
    useSandboxRepairGuestConfiguration: () => ({
      isPending: mocks.repairPending,
      mutate: mocks.repairMutate,
    }),
  }),
);
vi.mock("@/hooks/sandboxes/use-refresh-sandbox-costs", () => ({
  useRefreshSandboxCosts: () => undefined,
}));
vi.mock("@/hooks/sandboxes/use-sandbox-catalogue-query", () => ({
  useSandboxCatalogue: () => ({ data: mocks.catalogue }),
}));
vi.mock("@/hooks/sandboxes/use-sandbox-session-report", () => ({
  useSandboxSessionReport: () => ({
    report: { kind: "unknown" },
    failed: false,
  }),
}));
vi.mock("@/hooks/sandboxes/use-sandbox-costs-query", () => ({
  useSandboxCosts: () => ({ data: mocks.costs, isError: false }),
}));
vi.mock("@/hooks/home-focus/use-focus-model", async () => {
  const { EMPTY_FOCUS_MODEL } =
    await import("@/lib/home-focus/build-focus-model");
  return { useFocusModel: () => EMPTY_FOCUS_MODEL };
});
vi.mock("@/hooks/sandboxes/use-sandbox-runway-warning", () => ({
  useSandboxRunwayWarning: () => mocks.warning,
}));
vi.mock("@/hooks/auth/use-auth-user-query", () => ({
  useAuthUser: () => ({ data: null }),
}));
vi.mock("@/components/settings/environment/open-environment-page", () => ({
  openEnvironmentPage: (address: {
    readonly configurationId: string | null;
    readonly pageId: string;
  }) => mocks.openEnvironmentPage(address),
}));

import {
  SandboxCard,
  SandboxHeaderActions,
  SandboxHeaderCost,
  SandboxHeaderNotices,
} from "@/components/hosts/sandbox-card";
import type { HostHealthState } from "@/components/settings/host-scope/host-health";
import {
  buildHostScopeOptions,
  type HostScopeSandbox,
} from "@/components/settings/host-scope/host-scope-model";

const NAME = "build-box";

function renderCard(sandbox: HostScopeSandbox): void {
  renderCardOnHost(sandbox, null, "online");
}

function renderCardDestroyed(
  sandbox: HostScopeSandbox,
  onDestroyed: (() => void) | null,
): void {
  renderCardOnHost(sandbox, onDestroyed, "online");
}

function renderCardOnHost(
  sandbox: HostScopeSandbox,
  onDestroyed: (() => void) | null,
  hostState: HostHealthState,
): void {
  const queryClient = new QueryClient({
    defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <SandboxHeaderActions
        hostName="Host name"
        sandbox={sandbox}
        onDestroyed={onDestroyed}
        renderActions={renderSandboxHeaderActions}
      />
      <SandboxHeaderCost sandbox={sandbox} />
      <SandboxHeaderNotices sandbox={sandbox} teamName={null} />
      <SandboxCard hostState={hostState} sandbox={sandbox} />
    </QueryClientProvider>,
  );
}

function renderSandboxHeaderActions(
  primary: ReactNode,
  menuItems: ReactNode,
): ReactNode {
  return (
    <>
      {primary}
      <DropdownMenu modal={false} open>
        <DropdownMenuTrigger asChild>
          <button type="button" aria-label="More actions for Host name">
            More
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent>{menuItems}</DropdownMenuContent>
      </DropdownMenu>
    </>
  );
}

function sandboxOf(
  state: HostScopeSandbox["state"],
  frozen: boolean,
  overrides: Parameters<typeof sandboxSummaryFixture>[0],
): HostScopeSandbox {
  return {
    state,
    frozen,
    summary: sandboxSummaryFixture({
      displayName: NAME,
      state: state ?? "awake",
      frozen,
      ...overrides,
    }),
    teamOwned: false,
  };
}

function oneSecretGrant(): SandboxGrantsSummary {
  return {
    version: 3,
    grants: [
      {
        secretName: "PROD_DB",
        kind: "password",
        protocol: "postgres",
        source: "approved",
        connectorName: null,
        rotation: null,
        routes: [
          {
            route: "route-1",
            destination: "db.internal",
            port: 5432,
            unready: null,
          },
        ],
      },
    ],
    github: null,
  };
}

function actionTestIds(): string[] {
  return screen
    .queryAllByTestId(/^sandbox-card-(suspend|resume|stop|start|destroy)$/)
    .map((el) => el.getAttribute("data-testid") ?? "");
}

const COST: SandboxCost = {
  sandboxId: "sbx_1",
  currentRateMillicreditsPerHour: 120,
  state: "awake",
  frozen: false,
  charged: {
    computeMillicredits: 5_000,
    storageMillicredits: 1_000,
    sinceCreatedAt: new Date(2026, 9, 1, 12).getTime(),
  },
  pendingMillicredits: 500,
  segments: [],
  todayMillicredits: 0,
  todayAwakeMs: null,
  history: [],
};

/** A cost whose ledger posted `millicredits` in the last millisecond. */
function costToday(millicredits: number): SandboxCost {
  const now = Date.now();
  return {
    ...COST,
    segments: [{ state: "awake", fromAt: now - 1, toAt: now, millicredits }],
  };
}

beforeEach(() => {
  mocks.binding = createFakeSandboxBinding();
  mocks.catalogue = null;
  mocks.costs = null;
  mocks.warning = { kind: "none" };
  mocks.unavailableReason = null;
  mocks.egressEvents = [];
  mocks.supportsMethod = false;
  mocks.repairPending = false;
  mocks.grantsData = undefined;
  mocks.grantsError = false;
  mocks.grantsFetching = false;
  mocks.grantsRefetch.mockClear();
  mocks.openEnvironmentPage.mockClear();
  mocks.useGrants.mockClear();
  mocks.useEgressEvents.mockClear();
  mocks.useSupportsMethod.mockClear();
  mocks.repairMutate.mockClear();
  mocks.toastSuccess.mockClear();
  mocks.toastInfo.mockClear();
  mocks.toastFromAuthError.mockClear();
});
afterEach(cleanup);

describe("<SandboxCard /> per state", () => {
  const ACTIONS: Record<string, readonly string[]> = {
    creating: [],
    awake: ["suspend", "stop", "destroy"],
    suspending: ["destroy"],
    suspended: ["resume", "destroy"],
    resuming: [],
    stopping: ["destroy"],
    stopped: ["start", "destroy"],
    starting: [],
    destroying: [],
    destroyed: [],
    failed: ["destroy"],
    released: [],
  };

  it("renders one Sandbox body and exactly the allowed header actions in every lifecycle state", () => {
    for (const state of HOST_SANDBOX_STATES) {
      renderCard(sandboxOf(state, false, {}));
      const card = screen.getByTestId("sandbox-card");
      expect(card.getAttribute("data-state")).toBe(state);
      expect(card.getAttribute("data-frozen")).toBe("false");
      expect(screen.queryByTestId("sandbox-card-state")).toBeNull();
      expect(actionTestIds()).toEqual(
        ACTIONS[state].map((action) => `sandbox-card-${action}`),
      );
      cleanup();
    }
  });

  it.each([
    ["creating", false, "This takes about 10 seconds once capacity is found."],
    ["stopping", false, "Its disk is kept; running processes end."],
    [
      "stopped",
      false,
      "Disk kept, processes ended. Start boots it again; shells marked relaunch-on-restart come back.",
    ],
    ["suspended", false, "Resumes on your next action."],
    ["released", false, "Files kept. The next shell starts it."],
    ["destroying", false, "Its disk is being deleted."],
    ["destroyed", false, "Its disk is gone."],
  ] as const)("shows the operational fact for %s", (state, frozen, line) => {
    renderCard(sandboxOf(state, frozen, {}));

    expect(
      within(screen.getByTestId("sandbox-card")).getByTestId(
        "sandbox-card-operational-line",
      ).textContent,
    ).toBe(line);
  });

  it.each([
    ["awake", false],
    ["suspending", false],
    ["resuming", false],
    ["starting", false],
    ["suspended", true],
    ["failed", false],
  ] as const)(
    "does not show a separate operational fact for %s (frozen: %s)",
    (state, frozen) => {
      renderCard(sandboxOf(state, frozen, {}));

      expect(
        within(screen.getByTestId("sandbox-card")).queryByTestId(
          "sandbox-card-operational-line",
        ),
      ).toBeNull();
    },
  );

  it.each([
    ["awake", false, "Suspend", ["Stop", "Destroy"]],
    ["suspended", false, "Resume", ["Destroy"]],
    ["stopped", false, "Start", ["Destroy"]],
    ["suspended", true, null, ["Destroy"]],
    ["failed", false, null, ["Destroy"]],
  ] as const)(
    "keeps the %s %s sandbox's primary separate from More",
    (state, frozen, primary, menu) => {
      renderCard(sandboxOf(state, frozen, {}));

      if (primary === null) {
        expect(
          screen.queryByRole("button", {
            name: /^(Suspend|Resume|Start|Stop)$/,
          }),
        ).toBeNull();
      } else {
        expect(screen.getByRole("button", { name: primary })).toBeTruthy();
      }
      for (const label of menu) {
        expect(screen.getByRole("menuitem", { name: label })).toBeTruthy();
      }
      expect(
        screen.getAllByTestId(
          /^sandbox-card-(suspend|resume|stop|start|destroy)$/,
        ),
      ).toHaveLength((primary === null ? 0 : 1) + menu.length);
    },
  );

  it("shows a suspended state, a separate Out of credits badge and Destroy alone for a frozen row", () => {
    renderCard(
      sandboxOf("suspended", true, {
        frozenAt: new Date(2026, 9, 9, 12).getTime(),
      }),
    );
    expect(screen.getByTestId("sandbox-card").getAttribute("data-frozen")).toBe(
      "true",
    );
    expect(screen.getByTestId("sandbox-card-state-line").textContent).toMatch(
      /^Your credits ran out · Will be removed on /,
    );
    expect(actionTestIds()).toEqual(["sandbox-card-destroy"]);
  });

  it("does not show a frozen notice for a destroyed row whose summary kept the frozen flag", () => {
    renderCard(sandboxOf("destroyed", false, { frozen: true }));
    const card = screen.getByTestId("sandbox-card");
    expect(card.getAttribute("data-state")).toBe("destroyed");
    expect(card.getAttribute("data-frozen")).toBe("false");
    expect(screen.queryByTestId("sandbox-card-state-line")).toBeNull();
    expect(actionTestIds()).toEqual([]);
  });

  it("offers a frozen-but-awake row Destroy as well: the meter freezes before it suspends", () => {
    renderCard(sandboxOf("awake", true, {}));
    expect(actionTestIds()).toEqual(["sandbox-card-destroy"]);
  });

  it("shows its shape, region, rate and idle rule, and the Created-by line only for a burst row", () => {
    renderCard(
      sandboxOf("awake", false, {
        burst: true,
        idleMinutes: 120,
        cpus: 4,
        memoryMb: 8192,
        region: "eu-west",
        regionLabel: null,
      }),
    );
    expect(screen.getByTestId("sandbox-card-shape").textContent).toContain(
      "4 vCPU",
    );
    // The server sent no label for "eu-west": the raw id is not shown.
    expect(screen.queryByTestId("sandbox-card-region")).toBeNull();
    expect(screen.getByText("$0.12 an hour")).toBeTruthy();
    expect(screen.getByTestId("sandbox-card-idle").textContent).toBe(
      "Destroyed after 2 h idle",
    );
    expect(screen.getByText("An agent, for one task")).toBeDefined();
    cleanup();

    renderCard(sandboxOf("awake", false, { burst: false }));
    expect(screen.queryByText("An agent, for one task")).toBeNull();
    expect(screen.getByTestId("sandbox-card-idle").textContent).toBe(
      "Suspends after 30 min idle",
    );
  });

  it("renders the guest's configuration failure as plain text, only when the guest reported one", () => {
    renderCard(
      sandboxOf("awake", false, {
        guestConfigured: false,
        guestConfigFailureReason: "<b>broker</b> unreachable",
      }),
    );
    const failure = screen.getByTestId("sandbox-card-guest-config-failure");
    expect(failure.textContent).toBe(
      "Settings did not apply: <b>broker</b> unreachable",
    );
    expect(failure.querySelector("b")).toBeNull();
    cleanup();

    renderCard(sandboxOf("awake", false, { guestConfigured: true }));
    expect(
      screen.queryByTestId("sandbox-card-guest-config-failure"),
    ).toBeNull();
  });

  // The day the notice names is pinned where it is formatted, against both
  // call sites of the UTC formatter; this case is the card's own contract,
  // that the notice appears exactly when the server announces a withdrawal.
  it("shows the withdrawal notice only when the server announces one", () => {
    const endsAt = new Date(2026, 11, 1).getTime();
    renderCard(sandboxOf("stopped", false, { withdrawalEndsAt: endsAt }));
    expect(screen.getByTestId("sandbox-card-withdrawal").textContent).toContain(
      "stops running",
    );
    cleanup();

    renderCard(sandboxOf("stopped", false, { withdrawalEndsAt: null }));
    expect(screen.queryByTestId("sandbox-card-withdrawal")).toBeNull();
  });

  // A frozen row ends on its own day-30 deadline, which the state line above
  // already names, and that day can fall well BEFORE the announced one — it
  // does here by more than three weeks. A notice naming the announced day
  // beside it would put two stop dates on one card and let the person read
  // the later, wrong one as how long the row has left.
  it("drops the announced day from a frozen row's notice, leaving the state line's day-30 date the only one on the card", () => {
    const frozenAt = Date.UTC(2026, 9, 9);
    renderCard(
      sandboxOf("suspended", true, {
        frozenAt,
        destroyAt: frozenDestroyAt(frozenAt),
        withdrawalEndsAt: Date.UTC(2026, 11, 1),
      }),
    );

    expect(screen.getByTestId("sandbox-card-withdrawal").textContent).toBe(
      "This sandbox stops running and is rebuilt from your environment. Files outside the repository are lost.",
    );
    expect(screen.getByTestId("sandbox-card-state-line").textContent).toMatch(
      /Will be removed on /,
    );
  });

  it("names the region by the server's label, never its id", () => {
    renderCard(
      sandboxOf("awake", false, {
        region: "us-west-3",
        regionLabel: "United States (West)",
      }),
    );
    expect(screen.getByTestId("sandbox-card-region").textContent).toBe(
      "United States (West)",
    );
  });

  it("reads a day's cost below a cent as under $0.01, with no credits in the Charged row", () => {
    mocks.costs = {
      sandboxes: [costToday(3)],
      awakeBurnMillicreditsPerHour: 120,
      todayYoursMillicredits: 0,
      todayByEnvironment: [],
    };
    renderCard(sandboxOf("awake", false, {}));
    expect(screen.getByTestId("sandbox-card-cost-today").textContent).toBe(
      "under $0.01 today",
    );
    expect(
      screen.getByTestId("sandbox-card-cost-charged").textContent,
    ).not.toContain("credits");
  });

  it("reads a cent or more of today's cost in dollars", () => {
    mocks.costs = {
      sandboxes: [costToday(20)],
      awakeBurnMillicreditsPerHour: 120,
      todayYoursMillicredits: 0,
      todayByEnvironment: [],
    };
    renderCard(sandboxOf("awake", false, {}));
    expect(screen.getByTestId("sandbox-card-cost-today").textContent).toBe(
      "$0.02 today",
    );
  });

  it("says what a suspend keeps from the provider's catalogue, but not on a burst sandbox", () => {
    mocks.catalogue = {
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
          regions: [],
        },
      ],
    };
    renderCard(sandboxOf("awake", false, { burst: false }));
    expect(screen.getByTestId("sandbox-card-idle").textContent).toContain(
      "keeps memory",
    );
    cleanup();
    renderCard(sandboxOf("awake", false, { burst: true }));
    expect(screen.getByTestId("sandbox-card-idle").textContent).not.toContain(
      "keeps memory",
    );
    cleanup();
    // An Automations row is released, never suspended.
    renderCard(
      sandboxOf("released", false, { burst: false, kind: "automation" }),
    );
    expect(screen.getByTestId("sandbox-card-idle").textContent).toBe(
      "Stops after 30 min idle",
    );
  });

  it("reads what a suspend keeps from the catalogue entry of the sandbox's own OS", () => {
    // A provider serving two OSes is one catalogue entry per OS, each with
    // its own suspend: the card of one OS never says what the other keeps.
    const entry = {
      provider: "daytona",
      shape: {
        cpuMin: 1,
        cpuMax: 4,
        cpuStep: 1,
        memoryPerCpuMinMb: 1024,
        memoryPerCpuMaxMb: 8192,
        memoryMinMb: 1024,
        memoryMaxMb: 16384,
        memoryStepMb: 512,
        diskMinMb: 10240,
        diskMaxMb: 51200,
        diskDefaultMb: 10240,
      },
      stoppedStorage: "disk",
      shapes: null,
      dockerInGuest: false,
      creatable: true,
      notCreatableReason: null,
      regions: [],
    };
    mocks.catalogue = {
      providers: [
        {
          ...entry,
          os: ["linux"],
          suspendFidelity: "disk",
          wakeClass: "cold-boot",
        },
        {
          ...entry,
          os: ["windows"],
          suspendFidelity: "memory",
          wakeClass: "resume",
        },
      ],
    };
    renderCard(
      sandboxOf("awake", false, { provider: "daytona", os: "windows" }),
    );
    expect(screen.getByTestId("sandbox-card-idle").textContent).toContain(
      "keeps memory",
    );
    cleanup();
    renderCard(sandboxOf("awake", false, { provider: "daytona", os: "linux" }));
    expect(screen.getByTestId("sandbox-card-idle").textContent).toContain(
      "disk only",
    );
  });

  it("shows the cost view and the runway warning when the figures and the warning are in", () => {
    mocks.costs = {
      sandboxes: [COST],
      awakeBurnMillicreditsPerHour: 120,
      todayYoursMillicredits: 0,
      todayByEnvironment: [],
    };
    mocks.warning = { kind: "critical", runwayMinutes: 20 };
    renderCard(sandboxOf("awake", false, {}));
    expect(
      screen.getByTestId("sandbox-card-cost-charged").textContent,
    ).toContain("$6.00 since");
    expect(
      screen.getByTestId("sandbox-card-cost-charged").textContent,
    ).toContain("$0.50 pending");
    const warning = screen.getByTestId("sandbox-balance-warning");
    expect(warning.getAttribute("data-level")).toBe("critical");
    expect(warning.textContent).toContain("20 min");
  });
});

describe("<SandboxCard /> rates", () => {
  it.each([
    ["awake", "$0.12 an hour", "under $0.01 an hour", "Storage rate"],
    ["suspended", "under $0.01 an hour", "$0.12 an hour", "Awake rate"],
    ["stopped", "under $0.01 an hour", "$0.12 an hour", "Awake rate"],
  ] as const)(
    "shows the current and other-state rates once each when %s",
    (state, currentRate, otherRate, otherRateLabel) => {
      renderCard(sandboxOf(state, false, {}));

      expect(screen.getAllByText(currentRate)).toHaveLength(1);
      expect(screen.getAllByText(otherRate)).toHaveLength(1);
      expect(screen.getByText(otherRateLabel)).toBeTruthy();
      expect(screen.getByTestId("sandbox-card-shape")).toBeTruthy();
      expect(screen.getByTestId("sandbox-card-idle")).toBeTruthy();
      expect(screen.getByTestId("sandbox-card-last-active")).toBeTruthy();
      expect(screen.queryByTestId("sandbox-card-cost-now")).toBeNull();
    },
  );

  it("uses the personal ledger rate when it differs from the nominal rate", () => {
    mocks.costs = {
      sandboxes: [{ ...COST, currentRateMillicreditsPerHour: 250 }],
      awakeBurnMillicreditsPerHour: 250,
      todayYoursMillicredits: 0,
      todayByEnvironment: [],
    };

    renderCard(sandboxOf("awake", false, {}));

    expect(screen.getAllByText("$0.25 an hour")).toHaveLength(1);
    expect(screen.queryByText("$0.12 an hour")).toBeNull();
    expect(screen.getByText("Storage rate")).toBeTruthy();
  });

  it("says Not billing for a frozen personal sandbox and shows its awake rate once", () => {
    mocks.costs = {
      sandboxes: [
        {
          ...COST,
          currentRateMillicreditsPerHour: 0,
          frozen: true,
          state: "suspended",
        },
      ],
      awakeBurnMillicreditsPerHour: 0,
      todayYoursMillicredits: 0,
      todayByEnvironment: [],
    };

    renderCard(sandboxOf("suspended", true, {}));

    expect(screen.getAllByText("Not billing")).toHaveLength(1);
    expect(screen.getAllByText("$0.12 an hour")).toHaveLength(1);
    expect(screen.getByText("Awake rate")).toBeTruthy();
  });
});

/**
 * The card's `sandbox` prop as the scope builder resolves it, for the cases
 * that are about WHICH answer the card shows: the host list's facts (registry
 * row, then directory entry) when it has them, the sandbox list's summary
 * otherwise. `listed` is what `GET /api/v3/hosts?include=sandboxState` said;
 * `null` is a registry row that carried no sandbox facts (and no directory
 * entry to copy them from).
 */
function resolvedSandbox(input: {
  readonly listed: {
    readonly state: HostScopeSandbox["state"];
    readonly frozen: boolean;
  } | null;
  readonly summaryFrozen: boolean;
}): HostScopeSandbox {
  const item: HostListItem = {
    hostId: "sbx-host",
    displayName: "Build box",
    platform: "linux",
    kind: "sandbox",
    publicKey: "pk",
    createdAt: "2026-01-01T00:00:00Z",
    updatePolicy: "manual",
    status: {
      connectivity: "connectable",
      viewerReachability: "unknown",
      clientCloud: "ok",
      updateState: "current",
      appVersion: "1.5.0",
      lastSeenAt: "2026-01-01T00:00:00Z",
    },
    profile: "agent",
    ...(input.listed === null
      ? {}
      : {
          sandboxState: input.listed.state,
          sandboxFrozen: input.listed.frozen,
        }),
  };
  const options = buildHostScopeOptions({
    leases: [],
    authorityAttached: false,
    directory:
      input.listed === null
        ? []
        : [hostListItemToDirectoryEntry(item, "wss://relay.example.test")],
    registry: [item],
    localHostId: null,
    activeHostId: null,
    localService: undefined,
    localPlatform: null,
    hasLiveSession: () => false,
    localHostSettingUp: false,
    localHostTerminalRunNote: null,
    sandboxes: [
      sandboxSummaryFixture({
        id: "sbx_1",
        hostId: "sbx-host",
        displayName: NAME,
        state: "suspended",
        frozen: input.summaryFrozen,
      }),
    ],
    nowMs: 0,
  });
  const sandbox = options.find(
    (option) => option.hostId === "sbx-host",
  )?.sandbox;
  if (sandbox === undefined || sandbox === null) {
    throw new Error("the builder produced no sandbox facts for the row");
  }
  return sandbox;
}

describe("<SandboxCard /> facts as the scope resolves them", () => {
  it("shows the host list's thaw, not the stale summary's frozen flag", () => {
    const sandbox = resolvedSandbox({
      listed: { state: "suspended", frozen: false },
      summaryFrozen: true,
    });
    // The builder prefers the host list: thawed.
    expect(sandbox.frozen).toBe(false);

    renderCard(sandbox);

    expect(screen.getByTestId("sandbox-card").getAttribute("data-frozen")).toBe(
      "false",
    );
    expect(screen.queryByTestId("sandbox-card-state")).toBeNull();
    expect(screen.queryByTestId("sandbox-card-state-line")).toBeNull();
    expect(actionTestIds()).toEqual([
      "sandbox-card-resume",
      "sandbox-card-destroy",
    ]);
  });

  it("control: shows a frozen row when the host list says frozen, whatever the summary says", () => {
    const sandbox = resolvedSandbox({
      listed: { state: "suspended", frozen: true },
      summaryFrozen: false,
    });
    expect(sandbox.frozen).toBe(true);

    renderCard(sandbox);

    expect(screen.getByTestId("sandbox-card").getAttribute("data-frozen")).toBe(
      "true",
    );
    expect(screen.getByTestId("sandbox-card-state-line").textContent).toMatch(
      /^Your credits ran out/,
    );
    expect(actionTestIds()).toEqual(["sandbox-card-destroy"]);
  });

  it("control: falls back to the summary's frozen flag when the host list carries no sandbox facts", () => {
    const sandbox = resolvedSandbox({ listed: null, summaryFrozen: true });
    // The builder's fallback, not a hand-written prop.
    expect(sandbox.frozen).toBe(true);
    expect(sandbox.state).toBe("suspended");

    renderCard(sandbox);

    expect(screen.getByTestId("sandbox-card").getAttribute("data-frozen")).toBe(
      "true",
    );
    expect(screen.getByTestId("sandbox-card-state-line").textContent).toMatch(
      /^Your credits ran out/,
    );
    expect(actionTestIds()).toEqual(["sandbox-card-destroy"]);
  });
});

describe("<SandboxCard /> without a summary", () => {
  // The details come from the sandbox list, which loads for a signed-in user.
  beforeEach(() => {
    useAuthStore.setState({ status: "signed-in" });
  });
  afterEach(() => {
    useAuthStore.setState({ status: "signed-out" });
  });

  function renderWithoutSummary(state: HostScopeSandbox["state"]): void {
    renderCard({ state, frozen: false, summary: null, teamOwned: false });
  }

  it("says it is loading while the list has not answered", async () => {
    mocks.binding?.auth.listSandboxes.mockImplementation(
      () => new Promise(() => undefined),
    );
    renderWithoutSummary("suspended");

    await screen.findByText("Loading this sandbox's details…");
    expect(screen.queryByTestId("sandbox-card-details-reload")).toBeNull();
  });

  it("says the details could not be loaded when the list failed, and Retry reads the list again", async () => {
    mocks.binding?.auth.listSandboxes.mockResolvedValue({
      kind: "network-error",
      detail: "the request never completed (TypeError)",
    });
    renderWithoutSummary("suspended");

    const failed = await screen.findByTestId("sandbox-card-details-failed");
    expect(failed.textContent).toContain(
      "Couldn't load this sandbox's details.",
    );
    const retry = screen.getByTestId("sandbox-card-details-reload");
    expect(retry.textContent).toBe("Retry");
    const reads = mocks.binding?.auth.listSandboxes.mock.calls.length ?? 0;

    fireEvent.click(retry);

    await waitFor(() => {
      expect(mocks.binding?.auth.listSandboxes).toHaveBeenCalledTimes(
        reads + 1,
      );
    });
  });

  it("says why instead of loading when the build cannot reach the control plane, and never reads the list", async () => {
    mocks.unavailableReason =
      "Sandboxes aren't available in the staging build.";
    renderWithoutSummary("suspended");

    const line = await screen.findByTestId("sandbox-card-details-unavailable");
    expect(line.textContent).toBe(
      "Sandboxes aren't available in the staging build.",
    );
    expect(screen.queryByText("Loading this sandbox's details…")).toBeNull();
    expect(screen.queryByTestId("sandbox-card-details-reload")).toBeNull();
    expect(screen.queryByTestId("sandbox-card-details-failed")).toBeNull();
    expect(mocks.binding?.auth.listSandboxes).not.toHaveBeenCalled();
  });

  it("says a destroyed sandbox was destroyed once the list answered without it", async () => {
    mocks.binding?.auth.listSandboxes.mockResolvedValue({
      kind: "ok",
      response: { sandboxes: [] },
    });
    renderWithoutSummary("destroyed");

    const destroyed = await screen.findByTestId(
      "sandbox-card-details-destroyed",
    );
    expect(destroyed.textContent).toBe("This sandbox was destroyed.");
    expect(
      within(screen.getByTestId("sandbox-card")).getByTestId(
        "sandbox-card-operational-line",
      ).textContent,
    ).toBe("Its disk is gone.");
    expect(screen.queryByTestId("sandbox-card-details-reload")).toBeNull();
  });

  it("says any other sandbox missing from an answered list is not in it, and Refresh reads the list again", async () => {
    mocks.binding?.auth.listSandboxes.mockResolvedValue({
      kind: "ok",
      response: { sandboxes: [] },
    });
    renderWithoutSummary("suspended");

    const absent = await screen.findByTestId("sandbox-card-details-absent");
    expect(absent.textContent).toContain("Not in your sandbox list.");
    const refresh = screen.getByTestId("sandbox-card-details-reload");
    expect(refresh.textContent).toBe("Refresh");
    const reads = mocks.binding?.auth.listSandboxes.mock.calls.length ?? 0;

    fireEvent.click(refresh);

    await waitFor(() => {
      expect(mocks.binding?.auth.listSandboxes).toHaveBeenCalledTimes(
        reads + 1,
      );
    });
  });
});

describe("<SandboxCard /> verbs", () => {
  function suspend(): void {
    fireEvent.click(screen.getByTestId("sandbox-card-suspend"));
  }

  it("toasts success naming the sandbox when the verb lands at rest (200)", async () => {
    renderCard(sandboxOf("awake", false, {}));
    suspend();
    await waitFor(() => {
      expect(mocks.toastSuccess).toHaveBeenCalledWith(`Suspended ${NAME}`);
    });
    expect(mocks.binding?.auth.runSandboxVerb).toHaveBeenCalledWith(
      "sbx_1",
      "suspend",
      null,
      SANDBOX_VERB_FETCH_TIMEOUT_MS,
    );
    expect(mocks.toastInfo).not.toHaveBeenCalled();
  });

  it("a Suspend the server answers with a stopped row toasts Stopped, not Suspended", async () => {
    mocks.binding?.auth.runSandboxVerb.mockResolvedValue({
      kind: "ok",
      settled: true,
      state: "stopped",
    });
    renderCard(sandboxOf("awake", false, {}));
    suspend();
    await waitFor(() => {
      expect(mocks.toastSuccess).toHaveBeenCalledWith(`Stopped ${NAME}`);
    });
    expect(mocks.toastSuccess).not.toHaveBeenCalledWith(`Suspended ${NAME}`);
  });

  it("toasts info, not success, when the server's deadline passed with the row still moving (202)", async () => {
    mocks.binding?.auth.runSandboxVerb.mockResolvedValue({
      kind: "ok",
      settled: false,
      state: "suspending",
    });
    renderCard(sandboxOf("awake", false, {}));
    suspend();
    await waitFor(() => {
      expect(mocks.toastInfo).toHaveBeenCalledWith(`Suspending ${NAME}…`);
    });
    expect(mocks.toastSuccess).not.toHaveBeenCalled();
  });

  it("says nothing when the row was destroyed while the verb waited (404 sandbox_not_found)", async () => {
    mocks.binding?.auth.runSandboxVerb.mockResolvedValue(
      refusal(404, "sandbox_not_found"),
    );
    renderCard(sandboxOf("awake", false, {}));
    suspend();
    await waitFor(() => {
      expect(mocks.binding?.auth.runSandboxVerb).toHaveBeenCalledTimes(1);
    });
    // Let the mutation settle before asserting the absence of a toast.
    await waitFor(() => {
      expect(mocks.binding?.directory.refresh).toHaveBeenCalledTimes(1);
    });
    expect(mocks.toastSuccess).not.toHaveBeenCalled();
    expect(mocks.toastInfo).not.toHaveBeenCalled();
    expect(mocks.toastFromAuthError).not.toHaveBeenCalled();
  });

  it("disables the other verbs while one runs but leaves Destroy usable", async () => {
    // Held in an object: TS narrows a `let` assigned only in a callback to `never`.
    const gate: { finish: (() => void) | null } = { finish: null };
    mocks.binding?.auth.runSandboxVerb.mockImplementation(
      () =>
        new Promise((resolve) => {
          gate.finish = () =>
            resolve({ kind: "ok", settled: true, state: "suspended" });
        }),
    );
    renderCard(sandboxOf("awake", false, {}));
    suspend();

    await waitFor(() => {
      expect(
        screen.getByTestId("sandbox-card-stop").getAttribute("aria-disabled"),
      ).toBe("true");
    });
    expect(
      screen.getByTestId("sandbox-card-suspend").hasAttribute("disabled"),
    ).toBe(true);
    expect(screen.getByRole("status").textContent).toContain(
      "Suspending · pending",
    );
    expect(
      screen.getByTestId("sandbox-card-destroy").hasAttribute("disabled"),
    ).toBe(false);

    gate.finish?.();
    await waitFor(() => {
      expect(
        screen.getByTestId("sandbox-card-stop").getAttribute("aria-disabled"),
      ).toBe(null);
    });
  });
});

describe("<SandboxCard /> Automations row", () => {
  it("offers an awake row no action, and says it is free", () => {
    mocks.costs = {
      sandboxes: [costToday(3)],
      awakeBurnMillicreditsPerHour: 120,
      todayYoursMillicredits: 0,
      todayByEnvironment: [],
    };
    renderCard(sandboxOf("awake", false, { kind: "automation" }));
    expect(actionTestIds()).toEqual([]);
    expect(screen.queryByTestId("sandbox-card-stop")).toBeNull();
    expect(screen.queryByTestId("sandbox-card-destroy")).toBeNull();
    expect(screen.getByText("Free", { exact: true })).toBeTruthy();
    expect(screen.getByTestId("sandbox-card-cost-today").textContent).toBe(
      "Free today",
    );
    expect(screen.queryByTestId("sandbox-card-state-line")).toBeNull();
    expect(screen.getByTestId("sandbox-card-idle").textContent).toBe(
      "Stops after 30 min idle · files kept · the next shell starts it",
    );
  });

  it("offers a released row no action", () => {
    renderCard(sandboxOf("released", false, { kind: "automation" }));
    expect(actionTestIds()).toEqual([]);
  });
});

describe("<SandboxCard /> destroy", () => {
  function openDestroy(): void {
    fireEvent.click(screen.getByTestId("sandbox-card-destroy"));
  }
  function typeName(): void {
    fireEvent.change(screen.getByTestId("sandbox-confirm-destroy-typed"), {
      target: { value: NAME },
    });
  }

  it("asks for confirmation on a non-burst row and destroys nothing until it is given", async () => {
    renderCard(sandboxOf("suspended", false, { burst: false }));
    openDestroy();

    const dialog = await screen.findByTestId("confirm-destructive-dialog");
    expect(within(dialog).getByText(`Destroy ${NAME}?`)).toBeDefined();
    expect(
      within(dialog).getByText(/The disk is not recoverable/),
    ).toBeDefined();
    expect(mocks.binding?.auth.destroySandbox).not.toHaveBeenCalled();

    typeName();
    fireEvent.click(screen.getByTestId("confirm-action"));
    await waitFor(() => {
      expect(mocks.binding?.auth.destroySandbox).toHaveBeenCalledWith(
        "sbx_1",
        false,
      );
    });
    await waitFor(() => {
      expect(mocks.toastSuccess).toHaveBeenCalledWith(`Destroyed ${NAME}`);
    });
  });

  it("destroys nothing when the confirmation is cancelled", async () => {
    renderCard(sandboxOf("suspended", false, {}));
    openDestroy();
    await screen.findByTestId("confirm-destructive-dialog");
    fireEvent.click(screen.getByTestId("confirm-cancel"));
    await waitFor(() => {
      expect(screen.queryByTestId("confirm-destructive-dialog")).toBeNull();
    });
    expect(mocks.binding?.auth.destroySandbox).not.toHaveBeenCalled();
  });

  it("toasts Destroying…, not Destroyed, when the server answers 202", async () => {
    mocks.binding?.auth.destroySandbox.mockResolvedValue({
      kind: "ok",
      settled: false,
    });
    renderCard(sandboxOf("suspended", false, {}));
    openDestroy();
    await screen.findByTestId("confirm-destructive-dialog");
    typeName();
    fireEvent.click(screen.getByTestId("confirm-action"));

    await waitFor(() => {
      expect(mocks.toastInfo).toHaveBeenCalledWith(`Destroying ${NAME}…`);
    });
    expect(mocks.toastSuccess).not.toHaveBeenCalled();
  });

  it("toasts Destroyed when the row was already gone (404 sandbox_not_found)", async () => {
    mocks.binding?.auth.destroySandbox.mockResolvedValue(
      refusal(404, "sandbox_not_found"),
    );
    renderCard(sandboxOf("suspended", false, {}));
    openDestroy();
    await screen.findByTestId("confirm-destructive-dialog");
    typeName();
    fireEvent.click(screen.getByTestId("confirm-action"));
    await waitFor(() => {
      expect(mocks.toastSuccess).toHaveBeenCalledWith(`Destroyed ${NAME}`);
    });
  });

  describe("onDestroyed (an unenrolled row returns Settings to the active host)", () => {
    async function confirmDestroy(): Promise<void> {
      openDestroy();
      await screen.findByTestId("confirm-destructive-dialog");
      typeName();
      fireEvent.click(screen.getByTestId("confirm-action"));
    }

    it("calls onDestroyed once when the destroy settled (gone)", async () => {
      const onDestroyed = vi.fn<() => void>();
      renderCardDestroyed(sandboxOf("suspended", false, {}), onDestroyed);
      await confirmDestroy();

      await waitFor(() => {
        expect(mocks.toastSuccess).toHaveBeenCalledWith(`Destroyed ${NAME}`);
      });
      expect(onDestroyed).toHaveBeenCalledTimes(1);
    });

    it("calls onDestroyed when the row was already gone (404 sandbox_not_found)", async () => {
      mocks.binding?.auth.destroySandbox.mockResolvedValue(
        refusal(404, "sandbox_not_found"),
      );
      const onDestroyed = vi.fn<() => void>();
      renderCardDestroyed(sandboxOf("suspended", false, {}), onDestroyed);
      await confirmDestroy();

      await waitFor(() => {
        expect(mocks.toastSuccess).toHaveBeenCalledWith(`Destroyed ${NAME}`);
      });
      expect(onDestroyed).toHaveBeenCalledTimes(1);
    });

    it("does not call onDestroyed when the destroy was accepted but is not gone yet (202)", async () => {
      mocks.binding?.auth.destroySandbox.mockResolvedValue({
        kind: "ok",
        settled: false,
      });
      const onDestroyed = vi.fn<() => void>();
      renderCardDestroyed(sandboxOf("suspended", false, {}), onDestroyed);
      await confirmDestroy();

      await waitFor(() => {
        expect(mocks.toastInfo).toHaveBeenCalledWith(`Destroying ${NAME}…`);
      });
      expect(onDestroyed).not.toHaveBeenCalled();
    });

    it("destroys without throwing when onDestroyed is null", async () => {
      renderCardDestroyed(sandboxOf("suspended", false, {}), null);
      await confirmDestroy();

      await waitFor(() => {
        expect(mocks.binding?.auth.destroySandbox).toHaveBeenCalledWith(
          "sbx_1",
          false,
        );
      });
      await waitFor(() => {
        expect(mocks.toastSuccess).toHaveBeenCalledWith(`Destroyed ${NAME}`);
      });
    });
  });

  describe("the typed-name gate", () => {
    async function openFrozen(): Promise<HTMLElement> {
      renderCard(sandboxOf("suspended", true, {}));
      openDestroy();
      await screen.findByTestId("confirm-destructive-dialog");
      const input = screen.getByTestId("sandbox-confirm-destroy-typed");
      if (!(input instanceof HTMLInputElement)) {
        throw new Error("the typed confirmation is not an input");
      }
      return input;
    }

    it("keeps Confirm disabled while the field is empty and shows no red reason yet", async () => {
      await openFrozen();
      expect(
        screen.getByTestId("confirm-action").hasAttribute("disabled"),
      ).toBe(true);
      expect(screen.queryByTestId("confirm-blocked-reason")).toBeNull();
    });

    it("explains itself once something wrong is typed, and stays disabled", async () => {
      const input = await openFrozen();
      fireEvent.change(input, { target: { value: "build" } });
      expect(screen.getByTestId("confirm-blocked-reason").textContent).toBe(
        `Type ${NAME} below to destroy it.`,
      );
      expect(
        screen.getByTestId("confirm-action").hasAttribute("disabled"),
      ).toBe(true);
    });

    it("enables Confirm on the exact name, ignoring surrounding spaces, and then destroys", async () => {
      const input = await openFrozen();
      fireEvent.change(input, { target: { value: `  ${NAME} ` } });
      expect(screen.queryByTestId("confirm-blocked-reason")).toBeNull();
      const confirm = screen.getByTestId("confirm-action");
      expect(confirm.hasAttribute("disabled")).toBe(false);

      fireEvent.click(confirm);
      await waitFor(() => {
        expect(mocks.binding?.auth.destroySandbox).toHaveBeenCalledWith(
          "sbx_1",
          false,
        );
      });
    });

    it("clears what was typed when the dialog is opened again", async () => {
      const input = await openFrozen();
      fireEvent.change(input, { target: { value: "build" } });
      fireEvent.click(screen.getByTestId("confirm-cancel"));
      await waitFor(() => {
        expect(screen.queryByTestId("confirm-destructive-dialog")).toBeNull();
      });
      openDestroy();
      const reopened = await screen.findByTestId(
        "sandbox-confirm-destroy-typed",
      );
      expect(reopened).toHaveProperty("value", "");
    });
  });
});

describe("<SandboxCard /> secrets summary readiness", () => {
  it("says all working for an awake sandbox with a ready route", () => {
    mocks.grantsData = oneSecretGrant();
    renderCard(
      sandboxOf("awake", false, {
        phase: "proxy-reachable",
        routes: [{ route: "route-1", state: "ready", code: null }],
      }),
    );

    expect(screen.getByTestId("sandbox-card-secrets").textContent).toContain(
      "1 secret · all working",
    );
  });

  it("says connecting while the sandbox is attaching", () => {
    mocks.grantsData = oneSecretGrant();
    renderCard(sandboxOf("awake", false, { phase: "attaching" }));

    expect(screen.getByTestId("sandbox-card-secrets").textContent).toContain(
      "1 secret · connecting",
    );
  });

  it("does not claim a route is ready when its host is offline", () => {
    mocks.grantsData = oneSecretGrant();
    renderCardOnHost(
      sandboxOf("awake", false, {
        phase: "ready",
        routes: [{ route: "route-1", state: "ready", code: null }],
      }),
      null,
      "offline",
    );

    expect(screen.getByTestId("sandbox-card-secrets").textContent).toContain(
      "1 secret",
    );
    expect(
      screen.getByTestId("sandbox-card-secrets").textContent,
    ).not.toContain("all working");
  });
});

describe("<SandboxCard /> secrets section", () => {
  function untrustedRefusalEvent(): SandboxEgressEvent {
    return {
      kind: "egress.refused",
      id: "ev-refused",
      at: new Date(2026, 9, 1, 12).getTime(),
      emitter: "reporter",
      untrusted: true,
      code: "grant_missing",
      route: null,
      host: "db.internal",
      protocol: "postgres",
      secret: "PROD_DB",
      howToRequest: null,
    };
  }

  it.each([false, true] as const)(
    "hides the empty secrets section while phase is absent (grants error: %s)",
    (grantsError) => {
      mocks.grantsError = grantsError;
      renderCard(sandboxOf("awake", false, { phase: null }));

      expect(screen.queryByTestId("sandbox-card-secrets")).toBeNull();
      expect(screen.queryByTestId("sandbox-card-secret-details")).toBeNull();
    },
  );

  it("mounts none of its live hooks while the sandbox reports no phase", () => {
    mocks.supportsMethod = true;

    renderCard(sandboxOf("awake", false, { phase: null }));

    expect(mocks.useEgressEvents).not.toHaveBeenCalled();
    expect(screen.queryByTestId("sandbox-card-repair")).toBeNull();
  });

  it("shows the section and no Docker note for an awake, ready sandbox", () => {
    mocks.grantsData = oneSecretGrant();
    renderCard(sandboxOf("awake", false, { phase: "ready" }));

    // No sandbox image carries Docker, so the card says nothing about
    // using secrets from a container.
    expect(screen.getByTestId("sandbox-card-secrets")).toBeTruthy();
    expect(screen.queryByTestId("sandbox-card-docker-note")).toBeNull();
  });

  it("shows no event list while there are no events", () => {
    renderCard(sandboxOf("awake", false, { phase: "ready" }));

    expect(screen.queryByTestId("sandbox-card-egress-events")).toBeNull();
    expect(screen.queryByTestId("sandbox-card-egress-event")).toBeNull();
  });

  it("shows a blocked request count and reveals its event details on See events", async () => {
    mocks.grantsData = { version: 3, grants: [], github: null };
    mocks.egressEvents = [untrustedRefusalEvent()];

    renderCard(sandboxOf("awake", false, { phase: "ready" }));

    const events = screen.getByTestId("sandbox-card-egress-events");
    expect(events.querySelector("summary")?.textContent).toContain(
      "1 recent blocked request · See events",
    );
    expect(events.hasAttribute("open")).toBe(false);
    const summary = events.querySelector("summary");
    if (summary === null) throw new Error("Expected the events disclosure");
    fireEvent.click(summary);
    await waitFor(() => expect(events.hasAttribute("open")).toBe(true));
    const item = screen.getByTestId("sandbox-card-egress-event");
    expect(item.getAttribute("data-tone")).toBe("refused");
    expect(item.textContent).toContain("reported by the sandbox");
  });

  it("subscribes to the egress events of the summary's host while awake", () => {
    renderCard(sandboxOf("awake", false, { phase: "ready" }));

    expect(mocks.useEgressEvents).toHaveBeenLastCalledWith("host-sbx-1");
  });

  it("subscribes to nothing while the sandbox is suspended", () => {
    mocks.grantsData = { version: 3, grants: [], github: null };
    renderCard(sandboxOf("suspended", false, { phase: "ready" }));

    expect(screen.getByTestId("sandbox-card-secrets")).toBeTruthy();
    expect(mocks.useEgressEvents).toHaveBeenLastCalledWith(null);
    expect(mocks.useEgressEvents).not.toHaveBeenCalledWith("host-sbx-1");
  });

  it("subscribes to nothing for a frozen sandbox", () => {
    renderCard(sandboxOf("awake", true, { phase: "ready" }));

    expect(mocks.useEgressEvents).toHaveBeenLastCalledWith(null);
  });

  describe("the repair action", () => {
    it("is hidden when the host does not serve the verb", () => {
      mocks.supportsMethod = false;

      renderCard(
        sandboxOf("awake", false, { phase: "ready", guestConfigured: false }),
      );

      expect(screen.queryByTestId("sandbox-card-repair")).toBeNull();
    });

    it("is hidden for a healthy guest, even on an awake sandbox whose host serves the verb", () => {
      mocks.supportsMethod = true;

      renderCard(
        sandboxOf("awake", false, { phase: "ready", guestConfigured: true }),
      );

      expect(screen.queryByTestId("sandbox-card-repair")).toBeNull();
    });

    it("is hidden while the guest's state is unknown", () => {
      mocks.supportsMethod = true;

      renderCard(
        sandboxOf("awake", false, { phase: "ready", guestConfigured: null }),
      );

      expect(screen.queryByTestId("sandbox-card-repair")).toBeNull();
    });

    it("is hidden while the sandbox is not awake, even when the host serves the verb", () => {
      mocks.supportsMethod = true;

      renderCard(
        sandboxOf("suspended", false, {
          phase: "ready",
          guestConfigured: false,
        }),
      );

      expect(screen.queryByTestId("sandbox-card-repair")).toBeNull();
    });

    it("asks the summary's host about the verb", () => {
      mocks.supportsMethod = true;

      renderCard(
        sandboxOf("awake", false, { phase: "ready", guestConfigured: false }),
      );

      expect(mocks.useSupportsMethod).toHaveBeenLastCalledWith(
        "host-sbx-1",
        "host.sandbox.repairGuestConfiguration",
      );
    });

    it("is shown for an awake sandbox whose guest failed, on a host that serves the verb, and runs the mutation with an empty request", () => {
      mocks.supportsMethod = true;
      renderCard(
        sandboxOf("awake", false, { phase: "ready", guestConfigured: false }),
      );

      const button = screen.getByTestId("sandbox-card-repair");
      expect(button.hasAttribute("disabled")).toBe(false);
      expect(screen.queryByTestId("sandbox-card-repair-spinner")).toBeNull();
      fireEvent.click(button);

      expect(mocks.repairMutate).toHaveBeenCalledTimes(1);
      expect(mocks.repairMutate.mock.lastCall?.[0]).toEqual({});
    });

    it("keeps the lifecycle primary when guest setup failed but the phase is unknown", () => {
      mocks.supportsMethod = true;
      renderCard(
        sandboxOf("awake", false, { phase: null, guestConfigured: false }),
      );

      expect(screen.getByTestId("sandbox-card-suspend")).toBeTruthy();
      expect(screen.queryByTestId("sandbox-card-repair")).toBeNull();
    });

    it("is disabled and shows a spinner while the repair is pending", () => {
      mocks.supportsMethod = true;
      mocks.repairPending = true;

      renderCard(
        sandboxOf("awake", false, { phase: "ready", guestConfigured: false }),
      );

      expect(
        screen.getByTestId("sandbox-card-repair").hasAttribute("disabled"),
      ).toBe(true);
      expect(screen.getByTestId("sandbox-card-repair-spinner")).toBeTruthy();
    });
  });
});

describe("<SandboxCard /> egress events without refusals", () => {
  it.each([
    [
      "teardown-only",
      {
        kind: "egress.teardown",
        id: "ev-closed-only",
        at: new Date(2026, 9, 1, 12).getTime(),
        emitter: "gateway",
        untrusted: false,
        route: "route-1",
        reason: "secret_rotated",
      },
      "Connections closed",
    ],
    [
      "held-only",
      {
        kind: "egress.held",
        id: "ev-held-only",
        at: new Date(2026, 9, 1, 12).getTime(),
        emitter: "gateway",
        untrusted: false,
        route: "route-1",
        waitedMs: 1200,
      },
      "Connection held while waking",
    ],
  ] as const)(
    "shows the events disclosure for a %s list",
    async (_name, event, headline) => {
      mocks.egressEvents = [event];

      renderCard(sandboxOf("awake", false, { phase: "ready" }));

      const events = screen.getByTestId("sandbox-card-egress-events");
      const summary = within(events).getByText(
        "Recent network events · See events",
      );
      fireEvent.click(summary);
      await waitFor(() => expect(events.hasAttribute("open")).toBe(true));
      expect(
        screen.getByTestId("sandbox-card-egress-event").textContent,
      ).toContain(headline);
    },
  );
});

describe("<SandboxCard /> condensed secrets and network", () => {
  function grant(
    secretName: string,
    route: string,
    destination: string,
  ): SandboxGrant {
    return {
      secretName,
      kind: "password",
      protocol: "postgres",
      source: "approved",
      connectorName: "private-connector",
      rotation: null,
      routes: [{ route, destination, port: 5432, unready: null }],
    };
  }

  function grantsOf(grants: readonly SandboxGrant[]): SandboxGrantsSummary {
    return { version: 3, grants, github: null };
  }

  async function openDetails(): Promise<HTMLElement> {
    const details = screen.getByTestId("sandbox-card-secret-details");
    fireEvent.click(within(details).getByText("Details"));
    await waitFor(() => expect(details.hasAttribute("open")).toBe(true));
    return details;
  }

  it("keeps grant and GitHub facts closed until Details opens", async () => {
    mocks.grantsData = grantsOf([
      {
        ...grant("PROD_DB", "route-1", "db.internal"),
        rotation: {
          state: "enforced",
          classes: [
            {
              workerClass: "postgres",
              status: "acknowledged",
              evidence: [{ kind: "session_closed", count: 1 }],
            },
          ],
        },
      },
      grant("CACHE_KEY", "route-2", "cache.internal"),
    ]);
    mocks.grantsData = {
      ...mocks.grantsData,
      github: {
        linked: true,
        installations: [
          { account: "traycerai", repositorySelection: "selected" },
        ],
      },
    };

    renderCard(
      sandboxOf("awake", false, {
        phase: "ready",
        routes: [
          { route: "route-1", state: "ready", code: null },
          { route: "route-2", state: "ready", code: null },
        ],
      }),
    );

    const row = screen.getByTestId("sandbox-card-secrets");
    expect(row.textContent).toContain("2 secrets · all working");
    expect(row.textContent).toContain("Manage");
    const details = screen.getByTestId("sandbox-card-secret-details");
    expect(details.hasAttribute("open")).toBe(false);
    expect(within(row).queryByText(/stand-in|real value/)).toBeNull();

    fireEvent.click(within(details).getByText("Details"));
    await waitFor(() => expect(details.hasAttribute("open")).toBe(true));
    expect(
      within(details).getByTestId("sandbox-card-stand-in").textContent,
    ).toMatch(/stand-in|real value/);
    const database = within(details).getAllByTestId("sandbox-card-grant")[0];
    expect(database.textContent).toContain("PROD_DB");
    expect(database.querySelector("p")?.textContent).toBe(
      "PROD_DB · postgres · brokered · through connector private-connector · approved for this sandbox",
    );
    expect(
      within(database).getByTestId("sandbox-card-grant-route").textContent,
    ).toBe("db.internal:5432 · ready");
    expect(screen.getByTestId("sandbox-card-grant-rotation").textContent).toBe(
      "New value enforced: postgres, 1 session closed.",
    );
    expect(screen.getByTestId("sandbox-card-github").textContent).toBe(
      "GitHub: traycerai (selected repositories)",
    );
    fireEvent.click(within(row).getByRole("button", { name: "Manage" }));
    expect(mocks.openEnvironmentPage).toHaveBeenCalledWith({
      configurationId: "personal",
      pageId: "secrets",
    });
  });

  it("opens failed grant details with See why and keeps Manage available", async () => {
    mocks.grantsData = grantsOf([grant("PROD_DB", "route-1", "db.internal")]);

    renderCard(
      sandboxOf("awake", false, {
        phase: "ready",
        routes: [
          { route: "route-1", state: "unavailable", code: "connector_offline" },
        ],
      }),
    );

    const row = screen.getByTestId("sandbox-card-secrets");
    expect(row.textContent).toContain("1 of 1 secret not working");
    expect(row.textContent).toContain("See why");
    expect(row.textContent).toContain("Manage");
    fireEvent.click(within(row).getByRole("button", { name: "See why" }));
    const details = screen.getByTestId("sandbox-card-secret-details");
    await waitFor(() => expect(details.hasAttribute("open")).toBe(true));
    expect(
      screen.getByTestId("sandbox-card-grant-route").textContent,
    ).toContain("Connector is offline");
    fireEvent.click(within(row).getByRole("button", { name: "Manage" }));
    expect(mocks.openEnvironmentPage).toHaveBeenCalledWith({
      configurationId: "personal",
      pageId: "secrets",
    });
  });

  it("retries a failed grants read and disables Retry during a refetch", () => {
    mocks.grantsError = true;
    renderCard(sandboxOf("awake", false, { phase: "ready" }));

    const row = screen.getByTestId("sandbox-card-secrets");
    expect(row.textContent).toContain("Couldn't load this sandbox's secrets");
    fireEvent.click(within(row).getByRole("button", { name: "Retry" }));
    expect(mocks.grantsRefetch).toHaveBeenCalledTimes(1);
    cleanup();

    mocks.grantsFetching = true;
    renderCard(sandboxOf("awake", false, { phase: "ready" }));
    expect(
      within(screen.getByTestId("sandbox-card-secrets"))
        .getByRole("button", { name: "Retry" })
        .hasAttribute("disabled"),
    ).toBe(true);
  });

  it("keeps cached grant facts without Retry when a refetch fails", async () => {
    mocks.grantsData = grantsOf([grant("PROD_DB", "route-1", "db.internal")]);
    mocks.grantsError = true;
    renderCard(sandboxOf("awake", false, { phase: "ready" }));

    const row = screen.getByTestId("sandbox-card-secrets");
    expect(row.textContent).toContain("1 secret");
    expect(row.textContent).not.toContain("Couldn't load");
    expect(within(row).queryByRole("button", { name: "Retry" })).toBeNull();

    const details = await openDetails();
    expect(
      within(details).getByTestId("sandbox-card-grant").textContent,
    ).toContain("PROD_DB");
    expect(mocks.grantsRefetch).not.toHaveBeenCalled();
  });

  it("shows saved grants while suspended and while the sandbox has no phase", async () => {
    mocks.grantsData = grantsOf([grant("PROD_DB", "route-1", "db.internal")]);
    renderCard(sandboxOf("suspended", false, { phase: "ready" }));
    expect(screen.getByTestId("sandbox-card-secrets").textContent).toContain(
      "1 secret",
    );
    let details = await openDetails();
    expect(
      within(details).getByTestId("sandbox-card-grant").textContent,
    ).toContain("PROD_DB");
    cleanup();

    renderCard(sandboxOf("awake", false, { phase: null }));
    expect(screen.getByTestId("sandbox-card-secrets").textContent).toContain(
      "1 secret",
    );
    details = await openDetails();
    expect(
      within(details).getByTestId("sandbox-card-grant").textContent,
    ).toContain("PROD_DB");
    expect(mocks.useEgressEvents).not.toHaveBeenCalledWith("host-sbx-1");
  });

  it("shows broker unavailability even when the sandbox reports the route ready", async () => {
    mocks.grantsData = grantsOf([
      {
        ...grant("PROD_DB", "route-1", "db.internal"),
        routes: [
          {
            route: "route-1",
            destination: "db.internal",
            port: 5432,
            unready: "connector_offline",
          },
        ],
      },
    ]);
    renderCard(
      sandboxOf("awake", false, {
        phase: "ready",
        routes: [{ route: "route-1", state: "ready", code: null }],
      }),
    );

    const row = screen.getByTestId("sandbox-card-secrets");
    expect(row.textContent).toContain("1 of 1 secret not working");
    fireEvent.click(within(row).getByRole("button", { name: "See why" }));
    const details = screen.getByTestId("sandbox-card-secret-details");
    await waitFor(() => expect(details.hasAttribute("open")).toBe(true));
    expect(
      screen.getByTestId("sandbox-card-grant-route").textContent,
    ).toContain("connector private-connector offline");
  });

  it("keeps degraded phase details available before grants load and opens them from See why", async () => {
    renderCard(sandboxOf("awake", false, { phase: "degraded(gateway)" }));
    let details = screen.getByTestId("sandbox-card-secret-details");
    expect(details.hasAttribute("open")).toBe(false);
    fireEvent.click(within(details).getByText("Details"));
    await waitFor(() => expect(details.hasAttribute("open")).toBe(true));
    expect(
      screen.getByTestId("sandbox-card-secrets-readiness").textContent,
    ).toBe(
      "Degraded at gateway: requests to granted destinations are refused until it recovers.",
    );
    cleanup();

    mocks.grantsData = grantsOf([grant("PROD_DB", "route-1", "db.internal")]);
    renderCard(sandboxOf("awake", false, { phase: "degraded(gateway)" }));
    const row = screen.getByTestId("sandbox-card-secrets");
    expect(row.textContent).toContain("1 secret · not working");
    fireEvent.click(within(row).getByRole("button", { name: "See why" }));
    details = screen.getByTestId("sandbox-card-secret-details");
    await waitFor(() => expect(details.hasAttribute("open")).toBe(true));
    expect(
      screen.getByTestId("sandbox-card-secrets-readiness").textContent,
    ).toContain("Degraded at gateway");
    expect(
      within(details).getByTestId("sandbox-card-grant").textContent,
    ).toContain("PROD_DB");
  });

  it.each([
    [
      "not linked",
      { linked: false, installations: [] },
      "GitHub: not linked. Git on this sandbox can't reach your repositories.",
    ],
    [
      "has no installations",
      { linked: true, installations: [] },
      "GitHub: linked, with the Traycer App installed nowhere yet.",
    ],
  ] as const)(
    "marks GitHub %s as not working",
    async (_state, github, exactLine) => {
      mocks.grantsData = { ...grantsOf([]), github };
      renderCard(sandboxOf("awake", false, { phase: "ready" }));

      const row = screen.getByTestId("sandbox-card-secrets");
      expect(row.textContent).toContain("GitHub not working");
      fireEvent.click(within(row).getByRole("button", { name: "See why" }));
      const details = screen.getByTestId("sandbox-card-secret-details");
      await waitFor(() => expect(details.hasAttribute("open")).toBe(true));
      expect(screen.getByTestId("sandbox-card-github").textContent).toBe(
        exactLine,
      );
    },
  );

  interface SeeWhyCase {
    readonly name: string;
    readonly grants: SandboxGrantsSummary;
    readonly runtime: Parameters<typeof sandboxSummaryFixture>[0];
    readonly line: string;
    readonly seeWhy: boolean;
  }
  const seeWhyCases: readonly SeeWhyCase[] = [
    {
      name: "an unavailable route",
      grants: grantsOf([grant("PROD_DB", "route-1", "db.internal")]),
      runtime: {
        phase: "ready",
        routes: [
          {
            route: "route-1",
            state: "unavailable",
            code: "connector_offline",
          },
        ],
      },
      line: "1 of 1 secret not working",
      seeWhy: true,
    },
    {
      name: "a failed rotation",
      grants: grantsOf([
        {
          ...grant("PROD_DB", "route-1", "db.internal"),
          rotation: { state: "failed", classes: [] },
        },
      ]),
      runtime: {
        phase: "ready",
        routes: [{ route: "route-1", state: "ready", code: null }],
      },
      line: "1 of 1 secret not working",
      seeWhy: true,
    },
    {
      name: "GitHub not linked",
      grants: {
        ...grantsOf([]),
        github: { linked: false, installations: [] },
      },
      runtime: { phase: "ready", routes: [] },
      line: "0 secrets · GitHub not working",
      seeWhy: true,
    },
    {
      name: "a degraded sandbox",
      grants: grantsOf([grant("PROD_DB", "route-1", "db.internal")]),
      runtime: { phase: "degraded(gateway)", routes: [] },
      line: "1 secret · not working",
      seeWhy: true,
    },
    {
      name: "every secret working",
      grants: grantsOf([grant("PROD_DB", "route-1", "db.internal")]),
      runtime: {
        phase: "ready",
        routes: [{ route: "route-1", state: "ready", code: null }],
      },
      line: "1 secret · all working",
      seeWhy: false,
    },
    {
      name: "a sandbox still connecting",
      grants: grantsOf([grant("PROD_DB", "route-1", "db.internal")]),
      runtime: { phase: "attaching", routes: [] },
      line: "1 secret · connecting",
      seeWhy: false,
    },
  ];

  it.each(seeWhyCases)(
    "offers See why exactly when the summary reports failure: $name",
    ({ grants, runtime, line, seeWhy }) => {
      mocks.grantsData = grants;
      renderCard(sandboxOf("awake", false, runtime));

      const row = screen.getByTestId("sandbox-card-secrets");
      expect(row.textContent).toContain(line);
      expect(
        within(row).queryByRole("button", { name: "See why" }) !== null,
      ).toBe(seeWhy);
    },
  );

  it("shows a blocked request count and See events only when there is a refusal", () => {
    mocks.grantsData = grantsOf([]);
    renderCard(sandboxOf("awake", false, { phase: "ready" }));
    expect(screen.queryByTestId("sandbox-card-egress-events")).toBeNull();
    cleanup();

    mocks.egressEvents = [
      {
        kind: "egress.refused",
        id: "ev-refused",
        at: new Date(2026, 9, 1, 12).getTime(),
        emitter: "reporter",
        untrusted: true,
        code: "grant_missing",
        route: null,
        host: "db.internal",
        protocol: "postgres",
        secret: "PROD_DB",
        howToRequest: null,
      },
    ];
    renderCard(sandboxOf("awake", false, { phase: "ready" }));

    const events = screen.getByTestId("sandbox-card-egress-events");
    expect(events.querySelector("summary")?.textContent).toContain(
      "1 recent blocked request · See events",
    );
  });

  it("joins a known route address for another event when a refusal opens the section", async () => {
    mocks.grantsData = grantsOf([grant("PROD_DB", "route-1", "db.internal")]);
    mocks.egressEvents = [
      {
        kind: "egress.teardown",
        id: "ev-closed",
        at: new Date(2026, 9, 1, 12).getTime(),
        emitter: "gateway",
        untrusted: false,
        route: "route-1",
        reason: "secret_rotated",
      },
      {
        kind: "egress.refused",
        id: "ev-refused",
        at: new Date(2026, 9, 1, 12).getTime(),
        emitter: "reporter",
        untrusted: true,
        code: "grant_missing",
        route: null,
        host: "db.internal",
        protocol: "postgres",
        secret: "PROD_DB",
        howToRequest: null,
      },
    ];
    renderCard(sandboxOf("awake", false, { phase: "ready" }));

    const events = screen.getByTestId("sandbox-card-egress-events");
    const summary = events.querySelector("summary");
    if (summary === null) throw new Error("Expected the events disclosure");
    fireEvent.click(summary);
    await waitFor(() => expect(events.hasAttribute("open")).toBe(true));
    const closedEvents = screen
      .getAllByTestId("sandbox-card-egress-event")
      .filter((event) => event.getAttribute("data-tone") === "closed");
    expect(closedEvents).toHaveLength(1);
    expect(closedEvents[0].textContent).toContain("db.internal:5432 ·");
  });
});
