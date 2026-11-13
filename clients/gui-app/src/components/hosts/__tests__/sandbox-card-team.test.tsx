import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type {
  SandboxPod,
  SandboxSummary,
  UserSandboxCost,
} from "@traycer/protocol/host/sandbox-control";
import {
  HOST_SANDBOX_STATES,
  type HostSandboxState,
} from "@traycer/protocol/host/host-status";
import type { SandboxGrantsSummary } from "@traycer/protocol/host/sandbox-secrets";
import {
  createFakeSandboxBinding,
  type FakeSandboxBinding,
} from "@/hooks/sandboxes/__tests__/sandbox-binding-fixture";
import { sandboxSummaryFixture } from "@/hooks/sandboxes/__tests__/sandbox-fixtures";
import { formatSandboxDate } from "@/lib/sandboxes/sandbox-row-lines";
import { frozenDestroyAt } from "@/lib/sandboxes/sandbox-balance";
import { useAuthStore } from "@/stores/auth/auth-store";
import { SANDBOX_VERB_FETCH_TIMEOUT_MS } from "@traycer-clients/shared/host-client/sandbox-control";

const mocks = vi.hoisted(() => ({
  binding: null as FakeSandboxBinding | null,
  toastSuccess: vi.fn(),
  toastInfo: vi.fn(),
  toastFromAuthError: vi.fn<(error: Error, title: string) => void>(),
  costs: null as UserSandboxCost | null,
  grantsData: undefined as SandboxGrantsSummary | undefined,
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
  useRunnerHostOrNull: () => ({ sandboxControlUnavailableReason: null }),
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
  useSandboxEgressEvents: () => [],
}));
vi.mock("@/hooks/sandboxes/use-sandbox-grants-query", () => ({
  useSandboxGrants: () => ({
    data: mocks.grantsData,
    isError: false,
    isFetching: false,
    refetch: vi.fn(),
  }),
}));
vi.mock("@/hooks/host/use-host-supports-method", () => ({
  useHostSupportsMethod: () => false,
}));
vi.mock(
  "@/hooks/sandboxes/use-sandbox-repair-guest-configuration-mutation",
  () => ({
    useSandboxRepairGuestConfiguration: () => ({
      isPending: false,
      mutate: vi.fn(),
    }),
  }),
);
vi.mock("@/hooks/sandboxes/use-refresh-sandbox-costs", () => ({
  useRefreshSandboxCosts: () => undefined,
}));
vi.mock("@/hooks/sandboxes/use-sandbox-catalogue-query", () => ({
  useSandboxCatalogue: () => ({ data: null }),
}));
vi.mock("@/hooks/sandboxes/use-sandbox-session-report", () => ({
  useSandboxSessionReport: () => ({
    report: { kind: "unknown" },
    failed: false,
  }),
}));
vi.mock(
  "@/hooks/sandboxes/use-sandbox-configurations",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("@/hooks/sandboxes/use-sandbox-configurations")
    >()),
    useSandboxConfigurations: () => ({
      configurations: [
        { kind: "personal" },
        {
          kind: "team",
          teamId: "team-acme",
          teamName: "Acme",
          environmentId: "env_team",
        },
      ],
      teamEnvironmentIds: new Set(["env_team"]),
      complete: true,
    }),
  }),
);
vi.mock("@/hooks/sandboxes/use-sandbox-costs-query", () => ({
  useSandboxCosts: () => ({ data: mocks.costs, isError: false }),
}));
vi.mock("@/hooks/home-focus/use-focus-model", async () => {
  const { EMPTY_FOCUS_MODEL } =
    await import("@/lib/home-focus/build-focus-model");
  return { useFocusModel: () => EMPTY_FOCUS_MODEL };
});
vi.mock("@/hooks/sandboxes/use-sandbox-runway-warning", () => ({
  useSandboxRunwayWarning: () => ({ kind: "none" }),
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
  SandboxHeaderActions,
  SandboxHeaderCost,
  SandboxHeaderNotices,
  SandboxInstallationGroup,
} from "@/components/hosts/sandbox-card";
import { HostOverviewSecretsTab } from "@/components/settings/panels/host-overview-secrets-tab";
import type { HostScopeSandbox } from "@/components/settings/host-scope/host-scope-model";

/**
 * A TEAM sandbox's card names who created it and
 * whose bundle the running wake is on, has no personal cost view, says its
 * pod's room for shells, always asks for its name before a destroy, and asks
 * before a Resume or Start bills the person pressing it.
 */

const NAME = "build-box";
const VIEWER = "user-viewer";
const ENV = "env_team";

function renderCard(sandbox: HostScopeSandbox, teamOwned: boolean): void {
  const queryClient = new QueryClient({
    defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <SandboxHeaderActions
        hostName="Host name"
        sandbox={{ ...sandbox, teamOwned }}
        onDestroyed={null}
        renderActions={renderSandboxHeaderActions}
      />
      <SandboxHeaderCost sandbox={{ ...sandbox, teamOwned }} />
      <SandboxHeaderNotices
        sandbox={{ ...sandbox, teamOwned }}
        teamName="Acme"
      />
      <SandboxInstallationGroup sandbox={{ ...sandbox, teamOwned }} />
      {sandbox.summary === null ? null : (
        <HostOverviewSecretsTab
          hostState="online"
          sandbox={{ ...sandbox, teamOwned }}
        />
      )}
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
  overrides: Partial<SandboxSummary>,
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
    ownerKind: "unknown",
    teamOwned: false,
  };
}

function podOf(
  summary: SandboxSummary,
  headroom: number,
  liveShells: number,
): SandboxPod {
  return { sandbox: summary, ordinal: 0, liveShells, headroom };
}

function text(testId: string): string {
  return screen.getByTestId(testId).textContent;
}

beforeEach(() => {
  mocks.binding = createFakeSandboxBinding();
  mocks.costs = null;
  mocks.grantsData = undefined;
  mocks.openEnvironmentPage.mockClear();
  mocks.toastSuccess.mockClear();
  mocks.toastInfo.mockClear();
  mocks.toastFromAuthError.mockClear();
  useAuthStore.setState({
    status: "signed-in",
    contextMetadata: { userId: VIEWER, username: "viewer" },
  });
});
afterEach(() => {
  cleanup();
  useAuthStore.setState({ status: "signed-out", contextMetadata: null });
});

describe("team creator and wake payer", () => {
  it("names the creator and the wake payer on a team card, as 'you' for the viewer", () => {
    renderCard(
      sandboxOf("awake", false, {
        createdBy: { userId: VIEWER, displayName: "Vera Viewer" },
        wakePayer: { userId: VIEWER, displayName: "Vera Viewer" },
      }),
      true,
    );
    expect(text("sandbox-card-creator")).toBe("you");
    expect(text("sandbox-card-wake-payer")).toBe("You");
  });

  it("names another member by their display name", () => {
    renderCard(
      sandboxOf("awake", false, {
        createdBy: { userId: "user-ada", displayName: "Ada Lovelace" },
        wakePayer: { userId: "user-grace", displayName: "Grace Hopper" },
      }),
      true,
    );
    expect(text("sandbox-card-creator")).toBe("Ada Lovelace");
    expect(text("sandbox-card-wake-payer")).toBe("Grace Hopper");
  });

  it("shows the creator but no payer line while the team sandbox is asleep", () => {
    renderCard(
      sandboxOf("suspended", false, {
        createdBy: { userId: "user-ada", displayName: "Ada Lovelace" },
        wakePayer: { userId: "user-ada", displayName: "Ada Lovelace" },
      }),
      true,
    );
    expect(text("sandbox-card-creator")).toBe("Ada Lovelace");
    expect(screen.queryByTestId("sandbox-card-wake-payer")).toBeNull();
  });

  it("shows neither line on a personal card, whatever the summary says", () => {
    renderCard(
      sandboxOf("awake", false, {
        createdBy: { userId: VIEWER, displayName: "Vera Viewer" },
        wakePayer: { userId: VIEWER, displayName: "Vera Viewer" },
      }),
      false,
    );
    expect(screen.queryByTestId("sandbox-card-creator")).toBeNull();
    expect(screen.queryByTestId("sandbox-card-wake-payer")).toBeNull();
  });

  it("shows no creator line on a team card whose summary names none", () => {
    renderCard(sandboxOf("awake", false, { createdBy: null }), true);
    expect(screen.queryByTestId("sandbox-card-creator")).toBeNull();
  });

  it("names the team payer and removal date in the header notice", () => {
    const frozenAt = new Date(2026, 8, 1, 12).getTime();
    renderCard(
      sandboxOf("suspended", true, {
        frozenAt,
        wakePayer: { userId: "user-ada", displayName: "Ada Lovelace" },
      }),
      true,
    );
    expect(text("sandbox-card-state-line")).toBe(
      `Ada Lovelace's Acme credits ran out · Will be removed on ${formatSandboxDate(frozenDestroyAt(frozenAt), true)}`,
    );
  });

  it("uses neutral payer wording when team sandbox details are unavailable", () => {
    renderCard(
      {
        state: "suspended",
        frozen: true,
        summary: null,
        ownerKind: "team",
        teamOwned: true,
      },
      true,
    );
    expect(text("sandbox-card-state-line")).toBe(
      "Its payer's Acme credits ran out",
    );
  });

  it("uses neutral payer wording when a team summary has no wake payer", () => {
    renderCard(sandboxOf("suspended", true, { wakePayer: null }), true);
    expect(text("sandbox-card-state-line")).toBe(
      "Its payer's Acme credits ran out",
    );
  });
});

describe("team cost view", () => {
  it("opens the team Secrets page from Manage", () => {
    mocks.grantsData = { version: 3, grants: [], github: null };
    renderCard(sandboxOf("awake", false, { environmentId: ENV }), true);

    fireEvent.click(screen.getByRole("button", { name: "Manage" }));

    expect(mocks.openEnvironmentPage).toHaveBeenCalledWith({
      configurationId: ENV,
      pageId: "secrets",
    });
  });

  it.each([
    ["awake", "$0.12 an hour", "under $0.01 an hour", "Storage rate"],
    ["suspended", "under $0.01 an hour", "$0.12 an hour", "Awake rate"],
  ] as const)(
    "shows current and other-state rates once, with no personal ledger, when %s",
    (state, currentRate, otherRate, otherRateLabel) => {
      renderCard(sandboxOf(state, false, {}), true);

      expect(screen.getAllByText(currentRate)).toHaveLength(1);
      expect(screen.getAllByText(otherRate)).toHaveLength(1);
      expect(screen.getByText(otherRateLabel)).toBeTruthy();
      expect(screen.queryByTestId("sandbox-card-cost-today")).toBeNull();
      expect(screen.queryByTestId("sandbox-card-cost")).toBeNull();
      expect(screen.getByTestId("sandbox-card-shape")).toBeTruthy();
      expect(screen.getByTestId("sandbox-card-idle")).toBeTruthy();
      expect(screen.getByTestId("sandbox-card-last-active")).toBeTruthy();
    },
  );

  it("says Not billing for a frozen team sandbox, which has no ledger rate", () => {
    renderCard(sandboxOf("suspended", true, {}), true);

    expect(screen.getAllByText("Not billing")).toHaveLength(1);
    expect(screen.queryByText("under $0.01 an hour")).toBeNull();
  });

  describe("with no ledger, each state's own rate", () => {
    const PRICE = { awakeMc: 120, suspendedMc: 40, stoppedMc: 20 };
    const HEADER_RATE: Record<HostSandboxState, string | null> = {
      creating: "Not billing",
      awake: "$0.12 an hour",
      suspending: null,
      suspended: "$0.04 an hour",
      resuming: null,
      stopping: null,
      stopped: "$0.02 an hour",
      starting: null,
      released: "Not billing",
      destroying: null,
      destroyed: "Not billing",
      failed: "Not billing",
    };

    function headerRate(sandbox: HostScopeSandbox): string {
      render(
        <div data-testid="header-rate">
          <SandboxHeaderCost sandbox={{ ...sandbox, teamOwned: true }} />
        </div>,
      );
      return text("header-rate");
    }

    it.each(HOST_SANDBOX_STATES)("shows the rate fragment for %s", (state) => {
      const sandbox = sandboxOf(state, false, { priceMcPerHour: PRICE });
      const rate = HEADER_RATE[state];
      expect(headerRate(sandbox)).toBe(rate === null ? "" : `·${rate}`);
    });

    it("reads the summary's state when the host list has none yet", () => {
      const sandbox = sandboxOf(null, false, {
        state: "destroyed",
        priceMcPerHour: PRICE,
      });
      expect(headerRate(sandbox)).toBe("·Not billing");
    });

    it.each([
      "suspending",
      "resuming",
      "stopping",
      "starting",
      "destroying",
      "destroyed",
    ] as const)("hides the other-state rate during %s", (state) => {
      renderCard(sandboxOf(state, false, { priceMcPerHour: PRICE }), true);
      expect(screen.queryByTestId("sandbox-card-other-rate")).toBeNull();
      expect(screen.queryByText("Storage rate")).toBeNull();
      expect(screen.queryByText("Awake rate")).toBeNull();
    });

    it("keeps a known zero visible on a frozen team transition", () => {
      renderCard(sandboxOf("resuming", true, { priceMcPerHour: PRICE }), true);

      expect(screen.getByText("Not billing", { exact: true })).toBeTruthy();
      expect(screen.queryByTestId("sandbox-card-other-rate")).toBeNull();
    });
  });
});

describe("team pod room", () => {
  function scriptPods(
    pods: (summary: SandboxSummary) => readonly SandboxPod[],
    summary: SandboxSummary,
  ): void {
    mocks.binding?.auth.getSandboxAutomation.mockResolvedValue({
      kind: "ok",
      automation: { available: true, sandbox: null, pods: pods(summary) },
    });
  }

  it("reads the environment's pod list and says the pod's room and live shells", async () => {
    const pod = sandboxOf("awake", false, {
      kind: "automation",
      environmentId: ENV,
    });
    if (pod.summary === null) throw new Error("the fixture has no summary");
    scriptPods((summary) => [podOf(summary, 6, 2)], pod.summary);

    renderCard(pod, true);

    await waitFor(() => {
      expect(text("sandbox-card-pod-room")).toBe(
        "Room for 6 more shells · 2 live shells",
      );
    });
    expect(mocks.binding?.auth.getSandboxAutomation).toHaveBeenCalledTimes(1);
    expect(mocks.binding?.auth.getSandboxAutomation).toHaveBeenCalledWith(ENV);
  });

  it("says when the pod is full and has no live shells to count", async () => {
    const pod = sandboxOf("awake", false, {
      kind: "automation",
      environmentId: ENV,
    });
    if (pod.summary === null) throw new Error("the fixture has no summary");
    scriptPods((summary) => [podOf(summary, 0, 0)], pod.summary);

    renderCard(pod, true);

    await waitFor(() => {
      expect(text("sandbox-card-pod-room")).toBe(
        "No room for another shell · no live shells",
      );
    });
  });

  it("finds its own pod among the team's by sandbox id", async () => {
    const pod = sandboxOf("awake", false, {
      kind: "automation",
      environmentId: ENV,
      id: "sbx_pod_2",
    });
    if (pod.summary === null) throw new Error("the fixture has no summary");
    const other = sandboxSummaryFixture({
      kind: "automation",
      environmentId: ENV,
      id: "sbx_pod_1",
    });
    scriptPods(
      (summary) => [podOf(other, 1, 7), podOf(summary, 3, 1)],
      pod.summary,
    );

    renderCard(pod, true);

    await waitFor(() => {
      expect(text("sandbox-card-pod-room")).toBe(
        "Room for 3 more shells · 1 live shell",
      );
    });
  });

  it("shows no room line when the pod list does not hold this pod", async () => {
    const pod = sandboxOf("awake", false, {
      kind: "automation",
      environmentId: ENV,
    });
    mocks.binding?.auth.getSandboxAutomation.mockResolvedValue({
      kind: "ok",
      automation: { available: true, sandbox: null, pods: [] },
    });

    renderCard(pod, true);

    await waitFor(() => {
      expect(mocks.binding?.auth.getSandboxAutomation).toHaveBeenCalledTimes(1);
    });
    expect(screen.queryByTestId("sandbox-card-pod-room")).toBeNull();
  });

  it("shows no room line, and reads no pod list, for a team pod with no environment", async () => {
    renderCard(
      sandboxOf("awake", false, { kind: "automation", environmentId: null }),
      true,
    );
    await new Promise((resolve) => setTimeout(resolve, 20));

    // Reading it with no environment would read the person's own host.
    expect(mocks.binding?.auth.getSandboxAutomation).not.toHaveBeenCalled();
    expect(screen.queryByTestId("sandbox-card-pod-room")).toBeNull();
  });

  it("reads no pod list for a personal Automations card or a team card that is not a pod", async () => {
    renderCard(
      sandboxOf("awake", false, { kind: "automation", environmentId: ENV }),
      false,
    );
    cleanup();
    renderCard(sandboxOf("awake", false, { environmentId: ENV }), true);
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(mocks.binding?.auth.getSandboxAutomation).not.toHaveBeenCalled();
    expect(screen.queryByTestId("sandbox-card-pod-room")).toBeNull();
  });
});

describe("team destroy", () => {
  function openDestroy(): void {
    fireEvent.click(screen.getByTestId("sandbox-card-destroy"));
  }

  it("asks for the typed name on a team card, naming no other members it has no list for", async () => {
    renderCard(sandboxOf("suspended", false, { environmentId: ENV }), true);
    openDestroy();

    const dialog = await screen.findByTestId("confirm-destructive-dialog");
    expect(dialog.textContent).toContain(
      "Destroying ends every running session. The disk",
    );
    expect(dialog.textContent).not.toContain("told who destroyed it");
    expect(screen.getByTestId("sandbox-confirm-destroy-typed")).toBeDefined();
    expect(screen.getByTestId("confirm-action").hasAttribute("disabled")).toBe(
      true,
    );
    expect(mocks.binding?.auth.destroySandbox).not.toHaveBeenCalled();
  });

  it("destroys only once the exact name is typed", async () => {
    renderCard(sandboxOf("suspended", false, { environmentId: ENV }), true);
    openDestroy();
    await screen.findByTestId("confirm-destructive-dialog");

    const input = screen.getByTestId("sandbox-confirm-destroy-typed");
    fireEvent.change(input, { target: { value: "build" } });
    expect(text("confirm-blocked-reason")).toBe(
      `Type ${NAME} below to destroy it.`,
    );
    expect(screen.getByTestId("confirm-action").hasAttribute("disabled")).toBe(
      true,
    );

    fireEvent.change(input, { target: { value: NAME } });
    expect(screen.getByTestId("confirm-action").hasAttribute("disabled")).toBe(
      false,
    );
    fireEvent.click(screen.getByTestId("confirm-action"));
    await waitFor(() => {
      expect(mocks.binding?.auth.destroySandbox).toHaveBeenCalledWith(
        "sbx_1",
        false,
      );
    });
  });

  it("asks for the name on a team pod too", async () => {
    renderCard(
      sandboxOf("awake", false, { kind: "automation", environmentId: ENV }),
      true,
    );
    openDestroy();
    const dialog = await screen.findByTestId("confirm-destructive-dialog");
    expect(screen.getByTestId("sandbox-confirm-destroy-typed")).toBeDefined();
    expect(dialog.textContent).not.toContain("told who destroyed it");
  });

  it("asks for the name on a personal card as well, without the team sentences", async () => {
    renderCard(sandboxOf("suspended", false, {}), false);
    openDestroy();
    const dialog = await screen.findByTestId("confirm-destructive-dialog");
    expect(screen.getByTestId("sandbox-confirm-destroy-typed")).toBeDefined();
    expect(dialog.textContent).not.toContain("other members");
    expect(dialog.textContent).not.toContain("Affected members");
  });
});

describe("waking a team sandbox", () => {
  it("runs Resume at once on a team card: no confirm stands between the click and the verb", async () => {
    renderCard(sandboxOf("suspended", false, {}), true);
    fireEvent.click(screen.getByTestId("sandbox-card-resume"));

    await waitFor(() => {
      expect(mocks.binding?.auth.runSandboxVerb).toHaveBeenCalledTimes(1);
    });
    expect(mocks.binding?.auth.runSandboxVerb).toHaveBeenCalledWith(
      "sbx_1",
      "resume",
      null,
      SANDBOX_VERB_FETCH_TIMEOUT_MS,
    );
    await waitFor(() => {
      expect(mocks.toastSuccess).toHaveBeenCalledWith(`Resumed ${NAME}`);
    });
    expect(screen.queryByTestId("team-wake-confirm")).toBeNull();
  });

  it("runs Start at once on a stopped team card", async () => {
    renderCard(sandboxOf("stopped", false, {}), true);
    fireEvent.click(screen.getByTestId("sandbox-card-start"));

    await waitFor(() => {
      expect(mocks.binding?.auth.runSandboxVerb).toHaveBeenCalledWith(
        "sbx_1",
        "start",
        null,
        SANDBOX_VERB_FETCH_TIMEOUT_MS,
      );
    });
    expect(screen.queryByTestId("team-wake-confirm")).toBeNull();
  });

  it("runs Suspend at once on a team sandbox", async () => {
    renderCard(sandboxOf("awake", false, {}), true);
    fireEvent.click(screen.getByTestId("sandbox-card-suspend"));

    await waitFor(() => {
      expect(mocks.binding?.auth.runSandboxVerb).toHaveBeenCalledWith(
        "sbx_1",
        "suspend",
        null,
        SANDBOX_VERB_FETCH_TIMEOUT_MS,
      );
    });
  });
});

describe("footer", () => {
  it("offers no New sandbox like this on a card with no lifecycle actions", () => {
    renderCard(sandboxOf("creating", false, {}), true);

    expect(screen.queryByTestId("sandbox-card-new-like-this")).toBeNull();
  });
});
